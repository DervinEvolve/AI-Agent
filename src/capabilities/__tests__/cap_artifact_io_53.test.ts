import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  ArtifactStore,
  ARTIFACT_LIMITS,
  sanitizeInputName,
  hashBuffer,
} from "../../runtime/artifact_store.js";
import {
  copyManifestToInputsDir,
  exportArtifact,
  freshExportState,
  resetDeniedDigests,
  rejectInputsPrefix,
  snapshotRegularFile,
  validateShape9,
  validateShape10,
  verifyExportContract,
  filterExportFromChildTools,
  exportArtifactToolSchema,
  NoopRecovery,
  type ExportAuthorizer,
} from "../../runtime/artifact_io.js";
import { checkCitation } from "../../runtime/artifact_evidence.js";
import {
  toolsForParent,
  toolsForChild,
  artifactIoEnabled,
  CAP_ARTIFACT_IO_53,
} from "../cap_artifact_io_53.js";

function digest(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function approving(expected?: string): ExportAuthorizer {
  return {
    async approve(req) {
      if (expected && req.sha256 !== expected) return { approved: false, reason: "digest mismatch" };
      return { approved: true };
    },
  };
}

describe("cap_artifact_io_53", () => {
  let root: string;
  beforeEach(async () => {
    resetDeniedDigests();
    root = await mkdtemp(path.join(tmpdir(), "artio-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("exposes active capability id and inclusive caps", () => {
    expect(CAP_ARTIFACT_IO_53.id).toBe("cap_artifact_io_53");
    expect(CAP_ARTIFACT_IO_53.status).toBe("active");
    expect(ARTIFACT_LIMITS.maxInputFiles).toBe(16);
    expect(ARTIFACT_LIMITS.maxInputBytesPerFile).toBe(8 * 1024 * 1024);
    expect(ARTIFACT_LIMITS.maxInputBytesTotal).toBe(32 * 1024 * 1024);
    expect(ARTIFACT_LIMITS.maxExports).toBe(8);
    expect(ARTIFACT_LIMITS.maxExportBytesPerFile).toBe(8 * 1024 * 1024);
    expect(ARTIFACT_LIMITS.maxExportBytesTotal).toBe(16 * 1024 * 1024);
  });

  it("rejects empty names, separators, dotdot, duplicates before any copy", () => {
    const store = new ArtifactStore();
    expect(sanitizeInputName("")).toBeNull();
    expect(sanitizeInputName("a/b")).toBeNull();
    expect(sanitizeInputName("../x")).toBeNull();
    expect(sanitizeInputName("..")).toBeNull();
    expect(sanitizeInputName("foo\\bar")).toBeNull();
    const dup = store.ingestInputs({
      principal: "p",
      runId: "r",
      files: [
        { name: "a.csv", bytes: Buffer.from("1") },
        { name: "a.csv", bytes: Buffer.from("2") },
      ],
    });
    expect(dup.ok).toBe(false);
    expect(store.listExports("p")).toHaveLength(0);
    const bad = store.ingestInputs({
      principal: "p",
      runId: "r",
      files: [{ name: "../etc", bytes: Buffer.from("x") }],
    });
    expect(bad.ok).toBe(false);
    expect(store.blobPresent(digest(Buffer.from("x")))).toBe(false);
  });

  it("round trip: ingest CSV, derive report, export, retrieve after cleanup", async () => {
    const store = new ArtifactStore();
    const csv = Buffer.from("name,n\nalice,2\nbob,3\n", "utf8");
    const ingested = store.ingestInputs({
      principal: "host",
      runId: "run-1",
      files: [{ name: "data.csv", bytes: csv, mediaLabel: "text/csv" }],
    });
    expect(ingested.ok).toBe(true);
    if (!ingested.ok) return;
    const inputsDir = path.join(root, "inputs");
    const copied = await copyManifestToInputsDir(store, ingested.manifest, inputsDir);
    expect(copied.ok).toBe(true);
    const readBack = await import("node:fs/promises").then((fs) => fs.readFile(path.join(inputsDir, "data.csv")));
    expect(Buffer.compare(readBack, csv)).toBe(0);
    expect(digest(readBack)).toBe(digest(csv));

    const lines = readBack.toString("utf8").trim().split("\n").slice(1);
    const sum = lines.reduce((acc, line) => acc + Number(line.split(",")[1]), 0);
    const report = Buffer.from(`total,${sum}\n`, "utf8");
    const reportPath = path.join(root, "report.csv");
    await writeFile(reportPath, report);

    const expected = digest(report);
    const state = freshExportState();
    const result = await exportArtifact({
      store,
      principal: "host",
      workspaceRoot: root,
      requestedPath: "report.csv",
      callId: "call-export-1",
      authorizer: approving(expected),
      state,
      label: "text/csv",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.output.sha256).toBe(expected);
    expect(result.output.committed).toBe(true);
    expect(result.output.termination_confirmed).toBe(true);
    expect(result.output.cleanup_confirmed).toBe(true);

    // workspace cleanup
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });

    const got = store.getArtifact("host", result.output.artifact_id);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(Buffer.compare(got.bytes, report)).toBe(0);

    const contract = verifyExportContract(
      { requiredExport: { name: "report.csv", expectedSha256: expected } },
      store,
      "host",
      result.output,
    );
    expect(contract.satisfied).toBe(true);
    const receiptAlone = verifyExportContract({}, store, "host", result.output);
    expect(receiptAlone.satisfied).toBe(false);
  });

  it("binary PNG ingest and export are byte-identical; inputs prefix rejected", async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0x00, 0xfe,
    ]);
    const store = new ArtifactStore();
    const ingested = store.ingestInputs({
      principal: "host",
      runId: "run-png",
      files: [{ name: "dot.png", bytes: png, mediaLabel: "image/png" }],
    });
    expect(ingested.ok).toBe(true);
    if (!ingested.ok) return;
    const inputsDir = path.join(root, "inputs");
    await copyManifestToInputsDir(store, ingested.manifest, inputsDir);
    const fromDisk = await import("node:fs/promises").then((fs) => fs.readFile(path.join(inputsDir, "dot.png")));
    expect(Buffer.compare(fromDisk, png)).toBe(0);

    await writeFile(path.join(root, "out.png"), png);
    const state = freshExportState();
    const result = await exportArtifact({
      store,
      principal: "host",
      workspaceRoot: root,
      requestedPath: "out.png",
      callId: "c-png",
      authorizer: approving(digest(png)),
      state,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const got = store.getArtifact("host", result.output.artifact_id);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(Buffer.compare(got.bytes, png)).toBe(0);
    expect(rejectInputsPrefix("/workspace/inputs/dot.png")).toBe(true);
    expect(rejectInputsPrefix("inputs/dot.png")).toBe(true);
    expect(rejectInputsPrefix("out.png")).toBe(false);
  });

  it("export rejects symlink, directory, path escape, oversize; store unchanged", async () => {
    const store = new ArtifactStore();
    const state = freshExportState();
    await mkdir(path.join(root, "sub"));
    await writeFile(path.join(root, "sub", "f.txt"), Buffer.from("hi"));
    await symlink(path.join(root, "sub", "f.txt"), path.join(root, "link.txt"));

    const sym = await snapshotRegularFile({ workspaceRoot: root, requestedPath: "link.txt" });
    expect(sym.ok).toBe(false);
    if (!sym.ok) expect(sym.code).toBe("symlink");

    const dir = await snapshotRegularFile({ workspaceRoot: root, requestedPath: "sub" });
    expect(dir.ok).toBe(false);

    const esc = await snapshotRegularFile({ workspaceRoot: root, requestedPath: "../etc/passwd" });
    expect(esc.ok).toBe(false);
    if (!esc.ok) expect(esc.code).toBe("path_escape");

    const big = Buffer.alloc(ARTIFACT_LIMITS.maxExportBytesPerFile + 1, 1);
    await writeFile(path.join(root, "big.bin"), big);
    const over = await exportArtifact({
      store,
      principal: "host",
      workspaceRoot: root,
      requestedPath: "big.bin",
      callId: "c-big",
      authorizer: approving(),
      state,
    });
    expect(over.status).toBe("error");
    if (over.status === "error") expect(over.started).toBe(false);
    expect(store.listExports("host")).toHaveLength(0);
  });

  it("authorizer denial leaves store untouched and does not debit recovery", async () => {
    const store = new ArtifactStore();
    await writeFile(path.join(root, "a.txt"), Buffer.from("secret-ish"));
    const recovery = new NoopRecovery();
    const state = freshExportState();
    const result = await exportArtifact({
      store,
      principal: "host",
      workspaceRoot: root,
      requestedPath: "a.txt",
      callId: "c1",
      authorizer: { async approve() { return { approved: false, reason: "no" }; } },
      state,
      recovery,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.started).toBe(false);
      expect(result.code).toBe("authorization_denied");
    }
    expect(store.listExports("host")).toHaveLength(0);
    expect(recovery.opened).toHaveLength(0);
    expect(recovery.debited).toHaveLength(0);

    const again = await exportArtifact({
      store,
      principal: "host",
      workspaceRoot: root,
      requestedPath: "a.txt",
      callId: "c2",
      authorizer: approving(),
      state,
      recovery,
    });
    expect(again.status).toBe("error");
    if (again.status === "error") expect(again.code).toBe("authorization_denied");
  });

  it("missing authorizer denies; different bytes deny", async () => {
    const store = new ArtifactStore();
    await writeFile(path.join(root, "a.txt"), Buffer.from("abc"));
    const state = freshExportState();
    const missing = await exportArtifact({
      store,
      principal: "host",
      workspaceRoot: root,
      requestedPath: "a.txt",
      callId: "c",
      authorizer: null,
      state,
    });
    expect(missing.status).toBe("error");
    if (missing.status === "error") expect(missing.code).toBe("authorization_denied");
    expect(store.listExports("host")).toHaveLength(0);

    resetDeniedDigests();
    const wrong = await exportArtifact({
      store,
      principal: "host",
      workspaceRoot: root,
      requestedPath: "a.txt",
      callId: "c",
      authorizer: approving("0".repeat(64)),
      state: freshExportState(),
    });
    expect(wrong.status).toBe("error");
    if (wrong.status === "error") expect(wrong.code).toBe("authorization_denied");
  });

  it("pre-commit snapshot timeout leaves store untouched", async () => {
    const store = new ArtifactStore();
    await writeFile(path.join(root, "a.txt"), Buffer.from("abc"));
    const result = await exportArtifact({
      store,
      principal: "host",
      workspaceRoot: root,
      requestedPath: "a.txt",
      callId: "c",
      authorizer: approving(),
      state: freshExportState(),
      snapshotTimeout: true,
      terminationConfirmed: true,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.started).toBe(false);
      expect(result.code).toBe("snapshot_timeout");
    }
    expect(store.listExports("host")).toHaveLength(0);
  });

  it("post-commit timeout is unknown, blocks further export, matching bytes are not success", async () => {
    const store = new ArtifactStore();
    const body = Buffer.from("committed-bytes");
    await writeFile(path.join(root, "a.txt"), body);
    const state = freshExportState();
    const result = await exportArtifact({
      store,
      principal: "host",
      workspaceRoot: root,
      requestedPath: "a.txt",
      callId: "c",
      authorizer: approving(digest(body)),
      state,
      afterCommitHook: () => {
        throw new Error("timeout");
      },
    });
    expect(result.status).toBe("unknown");
    if (result.status === "unknown") expect(result.blocks_further_export).toBe(true);
    expect(state.blocked).toBe(true);
    const again = await exportArtifact({
      store,
      principal: "host",
      workspaceRoot: root,
      requestedPath: "a.txt",
      callId: "c2",
      authorizer: approving(digest(body)),
      state,
    });
    expect(again.status).toBe("error");
    if (again.status === "error") expect(again.code).toBe("export_blocked");
    // matching bytes exist but are not a successful export receipt
    expect(state.successfulExports).toHaveLength(0);
  });

  it("export during quarantine neither opens nor debits recovery", async () => {
    const store = new ArtifactStore();
    await writeFile(path.join(root, "a.txt"), Buffer.from("abc"));
    const recovery = new NoopRecovery();
    const result = await exportArtifact({
      store,
      principal: "host",
      workspaceRoot: root,
      requestedPath: "a.txt",
      callId: "c",
      authorizer: approving(),
      state: freshExportState(),
      recovery,
      quarantine: {
        workspaceQuarantined: () => true,
        unresolvedWorkspaceMutation: () => false,
      },
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.code).toBe("quarantine");
    expect(recovery.opened).toHaveLength(0);
    expect(recovery.debited).toHaveLength(0);
    expect(store.listExports("host")).toHaveLength(0);
  });

  it("two principals: A TTL tombstones only A; B still retrieves; cross-principal denied", () => {
    const store = new ArtifactStore();
    const bytes = Buffer.from("same-bytes");
    const now = 1_000_000;
    const a = store.commitExport({
      principal: "A",
      sha256: digest(bytes),
      bytes,
      sanitizedName: "f.bin",
      now,
      retentionMs: 100,
    });
    const b = store.commitExport({
      principal: "B",
      sha256: digest(bytes),
      bytes,
      sanitizedName: "f.bin",
      now,
      retentionMs: 10_000,
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.record.artifactId).not.toBe(b.record.artifactId);
    expect(store.refcount(digest(bytes))).toBe(2);
    store.expireDue(now + 150);
    expect(store.getArtifact("A", a.record.artifactId, now + 150).ok).toBe(false);
    const bGot = store.getArtifact("B", b.record.artifactId, now + 150);
    expect(bGot.ok).toBe(true);
    if (bGot.ok) expect(Buffer.compare(bGot.bytes, bytes)).toBe(0);
    expect(store.refcount(digest(bytes))).toBe(1);
    // cross-principal and guessed id: uniform denial
    expect(store.getArtifact("A", b.record.artifactId, now + 150)).toEqual({ ok: false, code: "denied" });
    expect(store.getArtifact("B", "art_guessed", now + 150)).toEqual({ ok: false, code: "denied" });
    expect(store.getArtifact("A", a.record.artifactId, now + 150)).toEqual({ ok: false, code: "denied" });
    // B expiry drops refcount to zero; grace keeps bytes until sweep
    store.expireDue(now + 20_000);
    expect(store.refcount(digest(bytes))).toBe(0);
    expect(store.blobPresent(digest(bytes))).toBe(true);
    store.sweep(now + 20_000 + ARTIFACT_LIMITS.blobGcGraceMs);
    expect(store.blobPresent(digest(bytes))).toBe(false);
    expect(store.getArtifact("B", b.record.artifactId, now + 20_000)).toEqual({ ok: false, code: "denied" });
  });

  it("unreconciled pin is not TTL-deleted", () => {
    const store = new ArtifactStore();
    const bytes = Buffer.from("pinned");
    const now = 5_000;
    const c = store.commitExport({
      principal: "A",
      sha256: digest(bytes),
      bytes,
      sanitizedName: "p.bin",
      now,
      retentionMs: 10,
      unreconciled: true,
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const tomb = store.expireDue(now + 100);
    expect(tomb).not.toContain(c.record.artifactId);
    const got = store.getArtifact("A", c.record.artifactId, now + 50);
    expect(got.ok).toBe(true);
  });

  it("shape 9 only current-run success; shape 10 only InputManifest; neither settles contract", () => {
    const store = new ArtifactStore();
    const csv = Buffer.from("a,1\n");
    const ing = store.ingestInputs({
      principal: "host",
      runId: "r",
      files: [{ name: "in.csv", bytes: csv }],
    });
    expect(ing.ok).toBe(true);
    if (!ing.ok) return;
    const receipt = {
      artifact_id: "art_deadbeef",
      sha256: digest(Buffer.from("report")),
      bytes: 6,
      source_path: "report.csv",
      call_id: "call-1",
      ok: true as const,
      committed: true as const,
      termination_confirmed: true as const,
      cleanup_confirmed: true as const,
    };
    const s9 = validateShape9(
      { call_id: "call-1", artifact_id: "art_deadbeef", sha256: receipt.sha256 },
      [receipt],
    );
    expect(s9.valid).toBe(true);
    expect(
      validateShape9({ call_id: "other", artifact_id: "art_deadbeef", sha256: receipt.sha256 }, [receipt]).valid,
    ).toBe(false);
    expect(validateShape9({ call_id: "call-1", artifact_id: "nope", sha256: receipt.sha256 }, []).valid).toBe(false);

    const entry = ing.manifest.entries[0];
    expect(
      validateShape10({ input_artifact_id: entry.artifactId, sha256: entry.sha256 }, ing.manifest).valid,
    ).toBe(true);
    expect(
      validateShape10({ input_artifact_id: entry.artifactId, sha256: "ab" }, ing.manifest).valid,
    ).toBe(false);
    expect(validateShape10({ input_artifact_id: entry.artifactId, sha256: entry.sha256 }, null).valid).toBe(false);

    const ev9 = checkCitation({
      shape: 9,
      citation: { call_id: "call-1", artifact_id: "art_deadbeef", sha256: receipt.sha256 },
      currentRunExports: [receipt],
      inputManifest: ing.manifest,
    });
    expect(ev9.valid).toBe(true);
    expect(ev9.settlesOutcome).toBe(false);
    expect(ev9.closesRecovery).toBe(false);
    expect(ev9.satisfiesTaskContract).toBe(false);

    const ev10 = checkCitation({
      shape: 10,
      citation: { input_artifact_id: entry.artifactId, sha256: entry.sha256 },
      currentRunExports: [],
      inputManifest: ing.manifest,
    });
    expect(ev10.valid).toBe(true);
    expect(ev10.satisfiesTaskContract).toBe(false);
  });

  it("child registries exclude export_artifact; absent config preserves tool list", () => {
    const schema = exportArtifactToolSchema();
    const base = [{ name: "write_file" }, { name: "run_command" }, schema];
    expect(toolsForChild(base).map((t) => t.name)).not.toContain("export_artifact");
    expect(artifactIoEnabled(null)).toBe(false);
    expect(artifactIoEnabled(undefined)).toBe(false);
    expect(toolsForParent([{ name: "write_file" }], null)).toEqual([{ name: "write_file" }]);
    const withCfg = toolsForParent([{ name: "write_file" }], { enabled: true, principal: "p" });
    expect(withCfg.map((t) => t.name)).toContain("export_artifact");
  });

  it("over-limit input rejected whole, never truncated", () => {
    const store = new ArtifactStore();
    const files = Array.from({ length: ARTIFACT_LIMITS.maxInputFiles + 1 }, (_, i) => ({
      name: `f${i}.bin`,
      bytes: Buffer.from("x"),
    }));
    const r = store.ingestInputs({ principal: "p", runId: "r", files });
    expect(r.ok).toBe(false);
    expect(store.getArtifact("p", "art_anything").ok).toBe(false);
    const huge = Buffer.alloc(ARTIFACT_LIMITS.maxInputBytesPerFile + 1);
    const r2 = store.ingestInputs({
      principal: "p",
      runId: "r",
      files: [{ name: "big.bin", bytes: huge }],
    });
    expect(r2.ok).toBe(false);
    expect(store.blobPresent(hashBuffer(huge))).toBe(false);
  });

  it("quota charges full size even when bytes are deduped", () => {
    const store = new ArtifactStore();
    store.setQuota("A", 100);
    const bytes = Buffer.alloc(60, 7);
    const a = store.commitExport({
      principal: "A",
      sha256: digest(bytes),
      bytes,
      sanitizedName: "a.bin",
    });
    expect(a.ok).toBe(true);
    const b = store.commitExport({
      principal: "A",
      sha256: digest(bytes),
      bytes,
      sanitizedName: "b.bin",
    });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe("quota");
    expect(store.refcount(digest(bytes))).toBe(1);
  });
});
