import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactStore,
  ARTIFACT_LIMITS,
  hashBuffer,
  sanitizeInputName,
} from "../../runtime/artifact_store.js";
import {
  copyManifestToInputsDir,
  exportArtifact,
  freshExportState,
  NoopRecovery,
  resetDeniedDigests,
  validateShape9,
  validateShape10,
  verifyExportContract,
  type ExportAuthorizer,
} from "../../runtime/artifact_io.js";
import { checkCitation } from "../../runtime/artifact_evidence.js";
import { toolsForChild, toolsForParent } from "../cap_artifact_io_53.js";

function digest(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function approving(): ExportAuthorizer {
  return {
    async approve() {
      return { approved: true };
    },
  };
}

describe("artifact io principal isolation and contract", () => {
  let root: string;
  beforeEach(async () => {
    resetDeniedDigests();
    root = await mkdtemp(path.join(tmpdir(), "artio-rt-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("ingests exact bytes, exports a derived file, and isolates TTL across principals", async () => {
    const store = new ArtifactStore();
    const csv = Buffer.from("sku,qty\nA,2\nB,3\n", "utf8");
    const manifest = store.ingestInputs({
      principal: "alice",
      runId: "run-1",
      files: [{ name: "orders.csv", bytes: csv, mediaLabel: "text/csv" }],
      now: 1_000,
    });
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]!.sha256).toBe(digest(csv));
    expect(manifest.frozen).toBe(true);

    const inputsDir = path.join(root, "inputs");
    await mkdir(inputsDir, { recursive: true });
    const copied = await copyManifestToInputsDir(store, manifest, inputsDir);
    expect(copied).toHaveLength(1);
    const onDisk = await readFile(path.join(inputsDir, "orders.csv"));
    expect(onDisk.equals(csv)).toBe(true);
    expect(hashBuffer(onDisk)).toBe(manifest.entries[0]!.sha256);

    const report = Buffer.from("total,5\n", "utf8");
    const reportPath = path.join(root, "report.csv");
    await writeFile(reportPath, report);

    const state = freshExportState();
    const recovery = new NoopRecovery();
    const receipt = await exportArtifact({
      store,
      principal: "alice",
      workspaceRoot: root,
      requestPath: "report.csv",
      label: "text/csv",
      authorizer: approving(),
      state,
      recovery,
      now: 2_000,
      quarantine: false,
      unresolvedMutation: false,
      terminationConfirmed: true,
      cleanupConfirmed: true,
    });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.sha256).toBe(digest(report));
    expect(receipt.bytes).toBe(report.length);
    expect(receipt.committed).toBe(true);

    const got = store.getArtifact("alice", receipt.artifactId, 2_000);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.bytes.equals(report)).toBe(true);

    const bob = store.exportBytes({
      principal: "bob",
      sha256: receipt.sha256,
      bytes: report,
      mediaLabel: "text/csv",
      sanitizedName: "report.csv",
      now: 2_000,
    });
    expect(bob.ok).toBe(true);
    if (!bob.ok) return;

    store.tombstoneExpired("alice", receipt.artifactId, receipt.expiresAt + 1);
    const aliceAfter = store.getArtifact("alice", receipt.artifactId, receipt.expiresAt + 1);
    expect(aliceAfter.ok).toBe(false);
    const bobStill = store.getArtifact("bob", bob.artifactId, receipt.expiresAt + 1);
    expect(bobStill.ok).toBe(true);
    if (bobStill.ok) expect(bobStill.bytes.equals(report)).toBe(true);

    const cross = store.getArtifact("carol", bob.artifactId, 2_000);
    expect(cross.ok).toBe(false);

    const shape9 = validateShape9(
      { call_id: receipt.callId, artifact_id: receipt.artifactId, sha256: receipt.sha256 },
      [receipt],
    );
    expect(shape9.valid).toBe(true);
    const shape10 = validateShape10(
      { input_artifact_id: manifest.entries[0]!.artifactId, sha256: digest(csv) },
      manifest,
    );
    expect(shape10.valid).toBe(true);
    const cited = checkCitation({
      shape: 9,
      citation: { call_id: receipt.callId, artifact_id: receipt.artifactId, sha256: receipt.sha256 },
      currentRunExports: [receipt],
      inputManifest: manifest,
    });
    expect(cited.valid).toBe(true);
    expect(cited.satisfiesTaskContract).toBe(false);
    expect(cited.settlesOutcome).toBe(false);

    const contract = verifyExportContract({
      requiredName: "report.csv",
      expectedSha256: digest(report),
      exports: [receipt],
    });
    expect(contract.ok).toBe(true);

    const wrong = verifyExportContract({
      requiredName: "report.csv",
      expectedSha256: digest("nope"),
      exports: [receipt],
    });
    expect(wrong.ok).toBe(false);

    expect(sanitizeInputName("../x")).toEqual({ ok: false });
    expect(toolsForChild([{ name: "export_artifact" }, { name: "read_file" }]).map((t) => t.name)).toEqual([
      "read_file",
    ]);
    expect(toolsForParent([{ name: "read_file" }], null).map((t) => t.name)).toEqual(["read_file"]);
    expect(ARTIFACT_LIMITS.maxExports).toBe(8);
  });
});
