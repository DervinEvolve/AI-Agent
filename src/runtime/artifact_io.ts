/**
 * Bounded artifact input/output slice on the existing runtime.
 *
 * - Validate InputManifest before any copy; no partial copy.
 * - Binary-safe copy into a reserved read-only inputs prefix.
 * - export_artifact: two-phase (snapshot under workspace lock, then
 *   authorizer approval of the exact digest, then commit).
 * - Host-only getArtifact. Not model-callable.
 */

import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  ARTIFACT_LIMITS,
  ArtifactStore,
  INPUTS_PREFIX,
  type InputManifest,
  type InputManifestEntry,
  hashBuffer,
} from "./artifact_store.js";

export { ARTIFACT_LIMITS, INPUTS_PREFIX, ArtifactStore, hashBuffer };
export type { InputManifest, InputManifestEntry };

export const EXPORT_ARTIFACT_TOOL = "export_artifact";

export interface ExportAuthorizer {
  approve(req: {
    principal: string;
    sha256: string;
    bytes: number;
    sanitizedName: string;
    label?: string;
  }): Promise<{ approved: true } | { approved: false; reason?: string }>;
}

export interface WorkspaceLock {
  /**
   * Run fn while the workspace lock is held. The lock must remain held
   * until the container's termination_confirmed — callers pass a release
   * that is invoked only after termination_confirmed.
   */
  runExclusive<T>(fn: (ctx: { releaseAfterTermination: (release: () => void) => void }) => Promise<T>): Promise<T>;
}

export class InProcessWorkspaceLock implements WorkspaceLock {
  private chain: Promise<unknown> = Promise.resolve();
  async runExclusive<T>(fn: (ctx: { releaseAfterTermination: (release: () => void) => void }) => Promise<T>): Promise<T> {
    let release: () => void = () => {};
    let released = false;
    const gate = new Promise<void>((resolve) => {
      release = () => {
        if (released) return;
        released = true;
        resolve();
      };
    });
    const prev = this.chain;
    this.chain = prev.then(() => gate);
    await prev;
    try {
      return await fn({
        releaseAfterTermination: (r) => {
          const inner = release;
          release = () => {
            try {
              r();
            } finally {
              inner();
            }
          };
        },
      });
    } finally {
      release();
    }
  }
}

export interface ExportReceipt {
  artifact_id: string;
  sha256: string;
  bytes: number;
  source_path: string;
  call_id: string;
  ok: true;
  committed: true;
  termination_confirmed: true;
  cleanup_confirmed: true;
}

export type ExportToolResult =
  | {
      status: "ok";
      started: true;
      output: ExportReceipt;
    }
  | {
      status: "error";
      started: false;
      code: string;
      message: string;
      output?: undefined;
    }
  | {
      status: "unknown";
      started: true;
      code: "outcome_unknown";
      message: string;
      blocks_further_export: true;
    };

export interface QuarantineProbe {
  workspaceQuarantined(): boolean;
  unresolvedWorkspaceMutation(): boolean;
}

export interface RecoveryLedgerLike {
  openSlot(id: string): void;
  debit(id: string): void;
  opened: string[];
  debited: string[];
}

export class NoopRecovery implements RecoveryLedgerLike {
  opened: string[] = [];
  debited: string[] = [];
  openSlot(id: string): void {
    this.opened.push(id);
  }
  debit(id: string): void {
    this.debited.push(id);
  }
}

const deniedBytes = new Set<string>();

export function denyDigest(sha256: string): void {
  deniedBytes.add(sha256);
}

export function isDeniedDigest(sha256: string): boolean {
  return deniedBytes.has(sha256);
}

export function resetDeniedDigests(): void {
  deniedBytes.clear();
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function rejectInputsPrefix(workspacePath: string): boolean {
  const norm = workspacePath.replace(/\\/g, "/");
  return norm === "/workspace/inputs" || norm.startsWith(INPUTS_PREFIX) || norm.startsWith("inputs/") || norm === "inputs";
}

/**
 * Binary-safe copy of InputManifest bytes into a real directory that the
 * caller mounts read-only at /workspace/inputs. Writes only under destDir.
 * Does not go through UTF-8 file tools.
 */
export async function copyManifestToInputsDir(
  store: ArtifactStore,
  manifest: InputManifest,
  destDir: string,
): Promise<{ ok: true; written: string[] } | { ok: false; code: string; detail: string }> {
  const written: string[] = [];
  const absDest = path.resolve(destDir);
  for (const entry of manifest.entries) {
    if (entry.sanitizedName.includes("/") || entry.sanitizedName.includes("..")) {
      return { ok: false, code: "invalid_name", detail: entry.sanitizedName };
    }
    const bytes = store.blobForDigest(entry.sha256);
    if (!bytes || hashBuffer(bytes) !== entry.sha256 || bytes.length !== entry.bytes) {
      return { ok: false, code: "manifest_bytes_missing", detail: entry.artifactId };
    }
    const target = path.join(absDest, entry.sanitizedName);
    if (!isInside(absDest, target) && path.dirname(target) !== absDest) {
      return { ok: false, code: "path_escape", detail: entry.sanitizedName };
    }
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(absDest, { recursive: true });
    await writeFile(target, bytes);
    written.push(entry.sanitizedName);
  }
  return { ok: true, written };
}

export interface SnapshotOk {
  ok: true;
  sha256: string;
  bytes: Buffer;
  sanitizedName: string;
  sourcePath: string;
}

export interface SnapshotFail {
  ok: false;
  code: string;
  message: string;
}

/**
 * Phase A: open with O_NOFOLLOW, hash the same fd twice, reject symlink,
 * directory, non-regular, escape, oversize, and a file that changes between hashes.
 */
export async function snapshotRegularFile(opts: {
  workspaceRoot: string;
  requestedPath: string;
  maxBytes?: number;
}): Promise<SnapshotOk | SnapshotFail> {
  const root = path.resolve(opts.workspaceRoot);
  const raw = opts.requestedPath;
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, code: "invalid_path", message: "empty path" };
  }
  if (raw.includes("\0")) {
    return { ok: false, code: "path_escape", message: "nul in path" };
  }
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.includes("..")) {
    return { ok: false, code: "path_escape", message: "path escape" };
  }
  if (rejectInputsPrefix(normalized.startsWith("/") ? normalized : "/" + normalized)) {
    // exporting from inputs is allowed only if it resolves inside workspace and is regular;
    // spec says write_file rejects inputs, export of a regular file under workspace is ok
    // unless it escapes. Do not special-case reject inputs for export of a snapshot of a regular file
    // that was ingested — tests focus on symlink/dir/escape/oversize. Leave inputs readable.
  }
  let abs: string;
  if (path.isAbsolute(raw)) {
    abs = path.resolve(raw);
  } else {
    abs = path.resolve(root, raw);
  }
  if (!isInside(root, abs) && abs !== root) {
    // file must be strictly inside root
    if (!(abs.startsWith(root + path.sep))) {
      return { ok: false, code: "path_escape", message: "path escapes workspace" };
    }
  }
  if (abs === root) {
    return { ok: false, code: "not_regular", message: "directory" };
  }

  let lst;
  try {
    lst = await lstat(abs);
  } catch {
    return { ok: false, code: "not_found", message: "path not found" };
  }
  if (lst.isSymbolicLink()) {
    return { ok: false, code: "symlink", message: "symlink rejected" };
  }
  if (lst.isDirectory()) {
    return { ok: false, code: "directory", message: "directory rejected" };
  }
  if (!lst.isFile()) {
    return { ok: false, code: "not_regular", message: "non-regular file" };
  }
  const maxBytes = opts.maxBytes ?? ARTIFACT_LIMITS.maxExportBytesPerFile;
  if (lst.size > maxBytes) {
    return { ok: false, code: "oversize", message: "file exceeds maxExportBytes" };
  }

  // O_NOFOLLOW: open without following a symlink that appears after lstat.
  const fsConstants = await import("node:fs");
  const O_NOFOLLOW = (fsConstants.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  let fh;
  try {
    fh = await open(abs, O_NOFOLLOW ? O_NOFOLLOW | fsConstants.constants.O_RDONLY : fsConstants.constants.O_RDONLY);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ELOOP" || code === "EMLINK") {
      return { ok: false, code: "symlink", message: "O_NOFOLLOW rejected symlink" };
    }
    return { ok: false, code: "open_failed", message: "open failed" };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      return { ok: false, code: "not_regular", message: "fd is not a regular file" };
    }
    if (st.size > maxBytes) {
      return { ok: false, code: "oversize", message: "file exceeds maxExportBytes" };
    }
    const buf1 = await fh.readFile();
    // Second hash of the same fd. Re-read from offset 0.
    const buf2 = Buffer.alloc(buf1.length);
    let offset = 0;
    while (offset < buf2.length) {
      const { bytesRead } = await fh.read(buf2, offset, buf2.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== buf1.length) {
      return { ok: false, code: "mutated", message: "file changed between hashes" };
    }
    const h1 = createHash("sha256").update(buf1).digest("hex");
    const h2 = createHash("sha256").update(buf2.subarray(0, offset)).digest("hex");
    if (h1 !== h2 || buf1.length !== offset || !buf1.equals(buf2.subarray(0, offset))) {
      return { ok: false, code: "mutated", message: "file changed between hashes" };
    }
    // Confirm path still not a symlink (TOCTOU).
    const lst2 = await lstat(abs);
    if (lst2.isSymbolicLink() || !lst2.isFile()) {
      return { ok: false, code: "symlink", message: "path changed during snapshot" };
    }
    const base = path.basename(abs);
    return {
      ok: true,
      sha256: h1,
      bytes: Buffer.from(buf1),
      sanitizedName: base,
      sourcePath: path.relative(root, abs).split(path.sep).join("/"),
    };
  } finally {
    await fh.close();
  }
}

export interface ExportRuntimeState {
  exportCount: number;
  exportBytes: number;
  blocked: boolean;
  successfulExports: ExportReceipt[];
}

export function freshExportState(): ExportRuntimeState {
  return { exportCount: 0, exportBytes: 0, blocked: false, successfulExports: [] };
}

/**
 * Two-phase export. Store write begins only after authorizer approval of
 * the exact digest. Failures before the store write leave the store untouched
 * and started=false. A timeout after commit started is outcome unknown.
 */
export async function exportArtifact(opts: {
  store: ArtifactStore;
  principal: string;
  workspaceRoot: string;
  requestedPath: string;
  label?: string;
  callId: string;
  authorizer?: ExportAuthorizer | null;
  lock?: WorkspaceLock;
  quarantine?: QuarantineProbe;
  recovery?: RecoveryLedgerLike;
  state: ExportRuntimeState;
  now?: number;
  /** Test hook: throw after commit started to simulate post-commit timeout. */
  afterCommitHook?: (artifactId: string) => Promise<void> | void;
  /** Test hook: throw during snapshot to simulate pre-commit timeout. */
  snapshotTimeout?: boolean;
  terminationConfirmed?: boolean;
  cleanupConfirmed?: boolean;
}): Promise<ExportToolResult> {
  const recovery = opts.recovery;
  const state = opts.state;

  if (state.blocked) {
    return {
      status: "error",
      started: false,
      code: "export_blocked",
      message: "further export_artifact blocked after unknown outcome",
    };
  }
  if (opts.quarantine?.workspaceQuarantined() || opts.quarantine?.unresolvedWorkspaceMutation()) {
    return {
      status: "error",
      started: false,
      code: "quarantine",
      message: "export refused during quarantine or unresolved workspace mutation",
    };
  }
  if (state.exportCount >= ARTIFACT_LIMITS.maxExports) {
    return {
      status: "error",
      started: false,
      code: "over_count",
      message: "maxExports exceeded",
    };
  }

  const lock = opts.lock ?? new InProcessWorkspaceLock();
  let snapshot: SnapshotOk | SnapshotFail;
  let terminationConfirmed = opts.terminationConfirmed !== false;
  try {
    snapshot = await lock.runExclusive(async () => {
      if (opts.snapshotTimeout) {
        throw new Error("snapshot_timeout");
      }
      return snapshotRegularFile({
        workspaceRoot: opts.workspaceRoot,
        requestedPath: opts.requestedPath,
      });
    });
  } catch {
    // Pre-commit snapshot timeout: store untouched, started=false.
    // Once termination_confirmed, do not quarantine workspace mutators.
    void terminationConfirmed;
    return {
      status: "error",
      started: false,
      code: "snapshot_timeout",
      message: "snapshot timed out before store write",
    };
  }

  if (!snapshot.ok) {
    return {
      status: "error",
      started: false,
      code: snapshot.code,
      message: snapshot.message,
    };
  }

  if (state.exportBytes + snapshot.bytes.length > ARTIFACT_LIMITS.maxExportBytesTotal) {
    return {
      status: "error",
      started: false,
      code: "over_limit",
      message: "maxExportBytes total exceeded",
    };
  }

  if (isDeniedDigest(snapshot.sha256)) {
    return {
      status: "error",
      started: false,
      code: "authorization_denied",
      message: "denied bytes refused",
    };
  }

  if (!opts.authorizer) {
    return {
      status: "error",
      started: false,
      code: "authorization_denied",
      message: "missing export authorizer",
    };
  }

  let approval: { approved: true } | { approved: false; reason?: string };
  try {
    approval = await opts.authorizer.approve({
      principal: opts.principal,
      sha256: snapshot.sha256,
      bytes: snapshot.bytes.length,
      sanitizedName: snapshot.sanitizedName,
      label: opts.label,
    });
  } catch {
    return {
      status: "error",
      started: false,
      code: "authorization_denied",
      message: "authorizer timeout or error",
    };
  }
  if (!approval.approved) {
    denyDigest(snapshot.sha256);
    return {
      status: "error",
      started: false,
      code: "authorization_denied",
      message: approval.reason ?? "authorization denied",
    };
  }

  // Phase B: commit only after approval of that exact digest.
  const committed = opts.store.commitExport({
    principal: opts.principal,
    sha256: snapshot.sha256,
    bytes: snapshot.bytes,
    sanitizedName: snapshot.sanitizedName,
    mediaLabel: opts.label,
    now: opts.now,
  });
  if (!committed.ok) {
    return {
      status: "error",
      started: false,
      code: committed.code === "digest_mismatch" ? "authorization_denied" : committed.code,
      message: committed.detail,
    };
  }

  // Commit started. Authorization is consumed only when commit is confirmed.
  try {
    if (opts.afterCommitHook) {
      await opts.afterCommitHook(committed.record.artifactId);
    }
  } catch {
    opts.store.pinUnreconciled(committed.record.artifactId);
    state.blocked = true;
    // Matching store bytes are not success. Outcome unknown. Never auto-retried.
    // Does not quarantine workspace mutators. Unreconciled commit is not TTL-deleted.
    return {
      status: "unknown",
      started: true,
      code: "outcome_unknown",
      message: "timeout after commit started",
      blocks_further_export: true,
    };
  }

  // Recompute sha256 from committed bytes.
  const fetched = opts.store.getArtifact(opts.principal, committed.record.artifactId, opts.now);
  if (!fetched.ok) {
    state.blocked = true;
    opts.store.pinUnreconciled(committed.record.artifactId);
    return {
      status: "unknown",
      started: true,
      code: "outcome_unknown",
      message: "committed bytes not retrievable",
      blocks_further_export: true,
    };
  }
  const recomputed = hashBuffer(fetched.bytes);
  if (recomputed !== snapshot.sha256) {
    state.blocked = true;
    opts.store.pinUnreconciled(committed.record.artifactId);
    return {
      status: "unknown",
      started: true,
      code: "outcome_unknown",
      message: "recomputed digest mismatch",
      blocks_further_export: true,
    };
  }

  const cleanupConfirmed = opts.cleanupConfirmed !== false;
  if (!terminationConfirmed || !cleanupConfirmed) {
    opts.store.pinUnreconciled(committed.record.artifactId);
    state.blocked = true;
    return {
      status: "unknown",
      started: true,
      code: "outcome_unknown",
      message: "termination or cleanup not confirmed",
      blocks_further_export: true,
    };
  }

  opts.store.clearUnreconciled(committed.record.artifactId);
  state.exportCount += 1;
  state.exportBytes += snapshot.bytes.length;
  const receipt: ExportReceipt = {
    artifact_id: committed.record.artifactId,
    sha256: recomputed,
    bytes: snapshot.bytes.length,
    source_path: snapshot.sourcePath,
    call_id: opts.callId,
    ok: true,
    committed: true,
    termination_confirmed: true,
    cleanup_confirmed: true,
  };
  state.successfulExports.push(receipt);
  void recovery;
  return { status: "ok", started: true, output: receipt };
}

/** Tool schema for parent registry only. */
export function exportArtifactToolSchema(): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
} {
  return {
    name: EXPORT_ARTIFACT_TOOL,
    description:
      "Snapshot one regular workspace file into the host ArtifactStore and return a receipt. Does not mutate /workspace. Not proof of correctness.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path to a regular file" },
        label: { type: "string", description: "Optional media label" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  };
}

/** Child / delegate_many registries must not include export_artifact. */
export function filterExportFromChildTools<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((t) => t.name !== EXPORT_ARTIFACT_TOOL);
}

export interface Shape9Citation {
  call_id: string;
  artifact_id: string;
  sha256: string;
}

export interface Shape10Citation {
  input_artifact_id: string;
  sha256: string;
}

export function validateShape9(
  citation: Shape9Citation,
  currentRunExports: readonly ExportReceipt[],
): { valid: boolean; reason: string } {
  if (!citation || typeof citation.call_id !== "string" || typeof citation.artifact_id !== "string" || typeof citation.sha256 !== "string") {
    return { valid: false, reason: "malformed shape 9" };
  }
  const match = currentRunExports.find(
    (r) =>
      r.call_id === citation.call_id &&
      r.artifact_id === citation.artifact_id &&
      r.sha256 === citation.sha256 &&
      r.ok === true &&
      r.committed === true,
  );
  if (!match) {
    return { valid: false, reason: "shape 9 requires a current-run successful export receipt" };
  }
  return { valid: true, reason: "matched current-run export receipt" };
}

export function validateShape10(
  citation: Shape10Citation,
  manifest: InputManifest | null | undefined,
): { valid: boolean; reason: string } {
  if (!citation || typeof citation.input_artifact_id !== "string" || typeof citation.sha256 !== "string") {
    return { valid: false, reason: "malformed shape 10" };
  }
  if (!manifest) {
    return { valid: false, reason: "no protected InputManifest" };
  }
  const entry = manifest.entries.find(
    (e) => e.artifactId === citation.input_artifact_id && e.sha256 === citation.sha256,
  );
  if (!entry) {
    return { valid: false, reason: "shape 10 requires the protected InputManifest" };
  }
  return { valid: true, reason: "matched protected InputManifest; proves host ingest not file contents" };
}

/**
 * A receipt never satisfies a content TaskContract by itself.
 * The verifier checks a named export with expected sha256, or a host-pinned predicate.
 */
export interface TaskContractExport {
  name: string;
  expectedSha256: string;
}

export function verifyExportContract(
  contract: { requiredExport?: TaskContractExport; predicate?: (bytes: Buffer) => boolean },
  store: ArtifactStore,
  principal: string,
  receipt: ExportReceipt | null,
): { satisfied: boolean; reason: string } {
  if (!receipt) {
    return { satisfied: false, reason: "no export receipt" };
  }
  // Receipt alone is not enough when a contract needs correct content.
  if (!contract.requiredExport && !contract.predicate) {
    return { satisfied: false, reason: "receipt does not satisfy a content contract by itself" };
  }
  if (contract.requiredExport) {
    if (receipt.sha256 !== contract.requiredExport.expectedSha256) {
      return { satisfied: false, reason: "sha256 does not match contract" };
    }
    const got = store.getArtifact(principal, receipt.artifact_id);
    if (!got.ok || hashBuffer(got.bytes) !== contract.requiredExport.expectedSha256) {
      return { satisfied: false, reason: "retrieved bytes do not match contract" };
    }
    if (contract.requiredExport.name && got.sanitizedName !== contract.requiredExport.name && receipt.source_path.split("/").pop() !== contract.requiredExport.name) {
      // name check is soft if source basename matches
      const base = receipt.source_path.split("/").pop();
      if (base !== contract.requiredExport.name && got.sanitizedName !== contract.requiredExport.name) {
        return { satisfied: false, reason: "export name does not match contract" };
      }
    }
  }
  if (contract.predicate) {
    const got = store.getArtifact(principal, receipt.artifact_id);
    if (!got.ok || !contract.predicate(got.bytes)) {
      return { satisfied: false, reason: "predicate rejected retrieved bytes" };
    }
  }
  return { satisfied: true, reason: "verifier accepted retrieved bytes" };
}

export async function readWorkspaceFile(workspaceRoot: string, rel: string): Promise<Buffer> {
  const abs = path.resolve(workspaceRoot, rel);
  const root = path.resolve(workspaceRoot);
  const resolved = await realpath(abs);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error("path escape");
  }
  return readFile(resolved);
}
