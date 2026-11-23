/**
 * Host-only ArtifactStore: opaque per-principal attachment ids over
 * content-addressed, reference-counted blobs.
 *
 * Shared blobs + per-principal attachment rows. A pin on any unreconciled
 * commit prevents TTL tombstone of that artifact_id. Blob bytes drop only
 * when refcount reaches zero under a blob-row lock plus grace delay.
 * Quota charges each attachment its full size even when bytes are deduped.
 * Random ids (not digest prefixes) so shared content is not an existence oracle.
 */

import { createHash, randomBytes } from "node:crypto";

export const ARTIFACT_LIMITS = Object.freeze({
  maxInputFiles: 16,
  maxInputBytesPerFile: 8 * 1024 * 1024,
  maxInputBytesTotal: 32 * 1024 * 1024,
  maxExports: 8,
  maxExportBytesPerFile: 8 * 1024 * 1024,
  maxExportBytesTotal: 16 * 1024 * 1024,
  defaultRetentionMs: 24 * 60 * 60 * 1000,
  blobGcGraceMs: 60_000,
});

export const INPUTS_PREFIX = "/workspace/inputs/";
export const INPUTS_REL_PREFIX = "inputs/";

export interface BlobRecord {
  sha256: string;
  bytes: Buffer;
  refcount: number;
  /** Epoch ms after which a zero-refcount blob may be deleted. */
  gcEligibleAt: number | null;
}

export interface ArtifactRecord {
  artifactId: string;
  principal: string;
  sha256: string;
  bytes: number;
  mediaLabel: string;
  sanitizedName: string;
  createdAt: number;
  expiresAt: number;
  tombstoned: boolean;
  /** Unreconciled commit pin: TTL must not tombstone this row. */
  unreconciledPin: boolean;
  kind: "input" | "export";
}

export interface InputManifestEntry {
  artifactId: string;
  sha256: string;
  bytes: number;
  mediaLabel: string;
  sanitizedName: string;
}

export interface InputManifest {
  principal: string;
  runId: string;
  entries: readonly InputManifestEntry[];
  frozen: true;
}

export type GetArtifactResult =
  | { ok: true; bytes: Buffer; sha256: string; mediaLabel: string; sanitizedName: string }
  | { ok: false; code: "denied" };

function sha256Of(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function newOpaqueId(): string {
  return "art_" + randomBytes(16).toString("hex");
}

/**
 * Sanitize a relative input name. Rejects empty, separators, '..', absolute,
 * and anything that would escape the inputs prefix. Returns null on reject.
 */
export function sanitizeInputName(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.includes("\0")) return null;
  if (raw.includes("/") || raw.includes("\\")) return null;
  if (raw.includes("..")) return null;
  if (raw.startsWith(".") && raw !== "." && raw.startsWith("..")) return null;
  if (raw === "." || raw === "..") return null;
  if (raw.startsWith("/")) return null;
  // Only a single path segment of safe characters.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw)) return null;
  if (raw === "." || raw.endsWith(".") && raw.includes("..")) return null;
  return raw;
}

export interface ProposedInput {
  name: string;
  bytes: Buffer;
  mediaLabel?: string;
}

export class ArtifactStore {
  private blobs = new Map<string, BlobRecord>();
  private artifacts = new Map<string, ArtifactRecord>();
  /** principal -> sum of charged attachment bytes (inputs + exports). */
  private quotaUsed = new Map<string, number>();
  private quotaCap = new Map<string, number>();
  private blobLocks = new Map<string, Promise<void>>();

  setQuota(principal: string, capBytes: number): void {
    this.quotaCap.set(principal, capBytes);
  }

  quotaRemaining(principal: string): number {
    const cap = this.quotaCap.get(principal);
    const used = this.quotaUsed.get(principal) ?? 0;
    if (cap === undefined) return Number.POSITIVE_INFINITY;
    return Math.max(0, cap - used);
  }

  private charge(principal: string, n: number): boolean {
    const cap = this.quotaCap.get(principal);
    const used = this.quotaUsed.get(principal) ?? 0;
    if (cap !== undefined && used + n > cap) return false;
    this.quotaUsed.set(principal, used + n);
    return true;
  }

  private uncharge(principal: string, n: number): void {
    const used = this.quotaUsed.get(principal) ?? 0;
    this.quotaUsed.set(principal, Math.max(0, used - n));
  }

  private retainBlob(digest: string, bytes: Buffer, now: number): void {
    const existing = this.blobs.get(digest);
    if (existing) {
      existing.refcount += 1;
      existing.gcEligibleAt = null;
      return;
    }
    this.blobs.set(digest, {
      sha256: digest,
      bytes: Buffer.from(bytes),
      refcount: 1,
      gcEligibleAt: null,
    });
    void now;
  }

  private releaseBlob(digest: string, now: number): void {
    const blob = this.blobs.get(digest);
    if (!blob) return;
    blob.refcount = Math.max(0, blob.refcount - 1);
    if (blob.refcount === 0) {
      blob.gcEligibleAt = now + ARTIFACT_LIMITS.blobGcGraceMs;
    }
  }

  /** Drop zero-refcount blobs whose grace has elapsed. */
  sweep(now: number = Date.now()): number {
    let dropped = 0;
    for (const [digest, blob] of this.blobs) {
      if (blob.refcount === 0 && blob.gcEligibleAt !== null && blob.gcEligibleAt <= now) {
        this.blobs.delete(digest);
        dropped += 1;
      }
    }
    return dropped;
  }

  /**
   * Validate and ingest an InputManifest. No partial copy: any reject
   * leaves the store unchanged for this call.
   */
  ingestInputs(opts: {
    principal: string;
    runId: string;
    files: ProposedInput[];
    now?: number;
    retentionMs?: number;
  }): { ok: true; manifest: InputManifest } | { ok: false; code: string; detail: string } {
    const now = opts.now ?? Date.now();
    const retentionMs = opts.retentionMs ?? ARTIFACT_LIMITS.defaultRetentionMs;
    const files = opts.files;
    if (!Array.isArray(files)) {
      return { ok: false, code: "invalid_manifest", detail: "files must be an array" };
    }
    if (files.length > ARTIFACT_LIMITS.maxInputFiles) {
      return { ok: false, code: "over_limit", detail: "maxInputFiles exceeded" };
    }
    const seen = new Set<string>();
    let total = 0;
    const prepared: { name: string; bytes: Buffer; label: string; digest: string }[] = [];
    for (const f of files) {
      const name = sanitizeInputName(f?.name ?? "");
      if (!name) {
        return { ok: false, code: "invalid_name", detail: "rejected input name" };
      }
      if (seen.has(name)) {
        return { ok: false, code: "duplicate_name", detail: name };
      }
      seen.add(name);
      if (!Buffer.isBuffer(f.bytes)) {
        return { ok: false, code: "invalid_bytes", detail: name };
      }
      if (f.bytes.length > ARTIFACT_LIMITS.maxInputBytesPerFile) {
        return { ok: false, code: "over_limit", detail: "maxInputBytes per file" };
      }
      total += f.bytes.length;
      if (total > ARTIFACT_LIMITS.maxInputBytesTotal) {
        return { ok: false, code: "over_limit", detail: "maxInputBytes total" };
      }
      prepared.push({
        name,
        bytes: f.bytes,
        label: typeof f.mediaLabel === "string" && f.mediaLabel.length > 0 ? f.mediaLabel : "application/octet-stream",
        digest: sha256Of(f.bytes),
      });
    }
    if (!this.charge(opts.principal, total)) {
      return { ok: false, code: "quota", detail: "principal quota exceeded" };
    }
    const entries: InputManifestEntry[] = [];
    for (const p of prepared) {
      this.retainBlob(p.digest, p.bytes, now);
      const artifactId = newOpaqueId();
      const rec: ArtifactRecord = {
        artifactId,
        principal: opts.principal,
        sha256: p.digest,
        bytes: p.bytes.length,
        mediaLabel: p.label,
        sanitizedName: p.name,
        createdAt: now,
        expiresAt: now + retentionMs,
        tombstoned: false,
        unreconciledPin: false,
        kind: "input",
      };
      this.artifacts.set(artifactId, rec);
      entries.push({
        artifactId,
        sha256: p.digest,
        bytes: p.bytes.length,
        mediaLabel: p.label,
        sanitizedName: p.name,
      });
    }
    const manifest: InputManifest = Object.freeze({
      principal: opts.principal,
      runId: opts.runId,
      entries: Object.freeze(entries.map((e) => Object.freeze({ ...e }))),
      frozen: true as const,
    });
    return { ok: true, manifest };
  }

  /** Bytes for a manifest entry. Host-only; does not check principal (caller already bound the manifest). */
  blobForDigest(sha256: string): Buffer | null {
    const b = this.blobs.get(sha256);
    if (!b || b.refcount <= 0) return null;
    return Buffer.from(b.bytes);
  }

  /**
   * Commit an export after authorizer approval of the exact digest.
   * Caller must have already hashed the fd twice and obtained approval.
   */
  commitExport(opts: {
    principal: string;
    sha256: string;
    bytes: Buffer;
    sanitizedName: string;
    mediaLabel?: string;
    now?: number;
    retentionMs?: number;
    unreconciled?: boolean;
  }): { ok: true; record: ArtifactRecord } | { ok: false; code: string; detail: string } {
    const now = opts.now ?? Date.now();
    const digest = sha256Of(opts.bytes);
    if (digest !== opts.sha256) {
      return { ok: false, code: "digest_mismatch", detail: "bytes do not match authorized sha256" };
    }
    if (opts.bytes.length > ARTIFACT_LIMITS.maxExportBytesPerFile) {
      return { ok: false, code: "over_limit", detail: "maxExportBytes per file" };
    }
    if (!this.charge(opts.principal, opts.bytes.length)) {
      return { ok: false, code: "quota", detail: "principal quota exceeded" };
    }
    this.retainBlob(digest, opts.bytes, now);
    const artifactId = newOpaqueId();
    const rec: ArtifactRecord = {
      artifactId,
      principal: opts.principal,
      sha256: digest,
      bytes: opts.bytes.length,
      mediaLabel: opts.mediaLabel && opts.mediaLabel.length > 0 ? opts.mediaLabel : "application/octet-stream",
      sanitizedName: opts.sanitizedName,
      createdAt: now,
      expiresAt: now + (opts.retentionMs ?? ARTIFACT_LIMITS.defaultRetentionMs),
      tombstoned: false,
      unreconciledPin: opts.unreconciled === true,
      kind: "export",
    };
    this.artifacts.set(artifactId, rec);
    return { ok: true, record: rec };
  }

  pinUnreconciled(artifactId: string): void {
    const rec = this.artifacts.get(artifactId);
    if (rec) rec.unreconciledPin = true;
  }

  clearUnreconciled(artifactId: string): void {
    const rec = this.artifacts.get(artifactId);
    if (rec) rec.unreconciledPin = false;
  }

  /**
   * Tombstone expired artifacts for a principal. Pinned unreconciled rows
   * are skipped. Blob bytes drop only at refcount zero after grace.
   */
  expireDue(now: number = Date.now()): string[] {
    const tombstoned: string[] = [];
    for (const rec of this.artifacts.values()) {
      if (rec.tombstoned) continue;
      if (rec.unreconciledPin) continue;
      if (rec.expiresAt > now) continue;
      rec.tombstoned = true;
      this.releaseBlob(rec.sha256, now);
      this.uncharge(rec.principal, rec.bytes);
      tombstoned.push(rec.artifactId);
    }
    return tombstoned;
  }

  /**
   * Host-only retrieval. Uniform denial: wrong principal, unknown id,
   * tombstoned, or expired — same code, no existence leak.
   */
  getArtifact(principal: string, artifactId: string, now: number = Date.now()): GetArtifactResult {
    const rec = this.artifacts.get(artifactId);
    if (!rec || rec.principal !== principal || rec.tombstoned || rec.expiresAt <= now) {
      return { ok: false, code: "denied" };
    }
    const blob = this.blobs.get(rec.sha256);
    if (!blob || blob.refcount <= 0) {
      return { ok: false, code: "denied" };
    }
    return {
      ok: true,
      bytes: Buffer.from(blob.bytes),
      sha256: rec.sha256,
      mediaLabel: rec.mediaLabel,
      sanitizedName: rec.sanitizedName,
    };
  }

  /** Introspection for tests: whether an id exists at all (host test helper, not a model API). */
  hasRow(artifactId: string): boolean {
    return this.artifacts.has(artifactId);
  }

  refcount(sha256: string): number {
    return this.blobs.get(sha256)?.refcount ?? 0;
  }

  blobPresent(sha256: string): boolean {
    return this.blobs.has(sha256);
  }

  listExports(principal: string): ArtifactRecord[] {
    return [...this.artifacts.values()].filter(
      (r) => r.principal === principal && r.kind === "export" && !r.tombstoned,
    );
  }
}

export function hashBuffer(buf: Buffer): string {
  return sha256Of(buf);
}
