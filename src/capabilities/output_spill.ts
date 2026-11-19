/**
 * Output spill for bounded tool-output capture.
 *
 * When a tool (e.g. run_code) produces stdout larger than the preview budget
 * (~50KB), the preview handed to the model is clipped head(40%)/tail(60%),
 * and the *full* output is spilled to a content-keyed file on disk so the agent
 * can page it back later (via offset/line-range reads) instead of re-running
 * the tool. Mirrors the hermes-agent PR #97043 / #77041 pattern:
 *  - spill file path is derived from a sha256 of the content (content-keyed)
 *  - 5MB hard cap on spilled content; oversized spills degrade to plain clipping
 *  - spill is best-effort: a failed spill never fails the tool call
 *  - secrets are redacted from the spill *before* it is written to disk
 *  - metadata (byte counts + spill path) travels alongside the preview so it
 *    survives JSON observation storage without re-truncation
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export const PREVIEW_CAP_BYTES = 50 * 1024;
export const SPILL_HARD_CAP_BYTES = 5 * 1024 * 1024;
export const HEAD_RATIO = 0.4;
export const TAIL_RATIO = 0.6;

export const SPILL_MARKER_NOTE =
  "[output truncated: full output spilled to {spillPath}; page it back with readSpillSlice(spillPath, offset) instead of re-running the tool]";

export interface TruncateWithSpillOptions {
  /** Directory where spill files are written. Should live inside the workspace. */
  spillDir: string;
  /** Preview budget in bytes (default 50KB). */
  previewCapBytes?: number;
  /** Head fraction of the preview (default 0.4). */
  headRatio?: number;
  /** Hard cap on spilled bytes (default 5MB). */
  hardCapBytes?: number;
  /** Redact secrets from the spill before writing (default true). */
  redact?: boolean;
  /** Override content key (default: sha256 of content). */
  contentKey?: string;
}

export interface TruncateWithSpillResult {
  /** The (possibly clipped) preview content with an inline spill marker. */
  content: string;
  /** True when the original content exceeded the preview budget. */
  truncated: boolean;
  /** Total byte length of the original content (utf8). */
  totalBytes: number;
  /** Bytes omitted from the preview (0 when not truncated). */
  omittedBytes: number;
  /** Path of the spilled full output, or null when no spill happened. */
  spillPath: string | null;
  /** True when a spill was attempted but failed (degrades to plain clipping). */
  spillFailed: boolean;
  /** Machine-readable metadata to persist with the observation. */
  metadata: {
    stdout_truncated: boolean;
    stdout_bytes_total: number;
    stdout_bytes_omitted: number;
    stdout_spill_path: string | null;
  };
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b/g, // generic api keys
  /\bghp_[A-Za-z0-9]{36,}\b/g, // github tokens
  /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, // JWTs
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9+/_-]{16,}['"]?/gi,
];

/** Best-effort secret redaction applied to spill content before persisting. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

/** Find the largest index <= target that is a line boundary (or 0). */
function snapToLineStart(text: string, target: number): number {
  if (target <= 0) return 0;
  if (target >= text.length) return text.length;
  let i = target;
  while (i > 0 && text[i - 1] !== "\n") i--;
  return i;
}

/** Find the smallest index >= target that is just after a line boundary. */
function snapToLineEnd(text: string, target: number): number {
  if (target >= text.length) return text.length;
  let i = text.indexOf("\n", target);
  return i === -1 ? text.length : i + 1;
}

function contentKeyOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 32);
}

/**
 * Truncate `content` to a head/tail preview and spill the full output to disk.
 * Never throws: a failed spill degrades to plain clipping (spillFailed=true).
 */
export function truncateWithSpill(
  content: string,
  options: TruncateWithSpillOptions,
): TruncateWithSpillResult {
  const previewCap = options.previewCapBytes ?? PREVIEW_CAP_BYTES;
  const headRatio = options.headRatio ?? HEAD_RATIO;
  const hardCap = options.hardCapBytes ?? SPILL_HARD_CAP_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf8");

  if (totalBytes <= previewCap) {
    return {
      content,
      truncated: false,
      totalBytes,
      omittedBytes: 0,
      spillPath: null,
      spillFailed: false,
      metadata: {
        stdout_truncated: false,
        stdout_bytes_total: totalBytes,
        stdout_bytes_omitted: 0,
        stdout_spill_path: null,
      },
    };
  }

  // Build the clipped preview: head (headRatio) + tail (1-headRatio),
  // both cut on line boundaries so lines stay readable.
  const headCut = snapToLineEnd(content, Math.floor(previewCap * headRatio));
  const tailCut = snapToLineStart(content, Math.max(headCut, content.length - Math.floor(previewCap * (1 - headRatio))));
  const previewBody =
    content.slice(0, headCut) +
    "\n[... stdout truncated ...]\n" +
    content.slice(tailCut);
  const omittedBytes = Math.max(0, totalBytes - Buffer.byteLength(previewBody, "utf8"));

  // Attempt the spill (best-effort, hard-capped).
  let spillPath: string | null = null;
  let spillFailed = false;
  if (totalBytes <= hardCap) {
    try {
      fs.mkdirSync(options.spillDir, { recursive: true });
      const key = options.contentKey ?? contentKeyOf(content);
      spillPath = path.join(options.spillDir, `spill-${key}.txt`);
      const toPersist = options.redact === false ? content : redactSecrets(content);
      fs.writeFileSync(spillPath, toPersist, "utf8");
    } catch {
      spillFailed = true;
      spillPath = null;
    }
  }

  const note = SPILL_MARKER_NOTE.replace(
    "{spillPath}",
    spillPath ?? "(spill unavailable)",
  );

  return {
    content: previewBody + "\n" + note,
    truncated: true,
    totalBytes,
    omittedBytes,
    spillPath,
    spillFailed,
    metadata: {
      stdout_truncated: true,
      stdout_bytes_total: totalBytes,
      stdout_bytes_omitted: omittedBytes,
      stdout_spill_path: spillPath,
    },
  };
}

export interface SpillSliceOptions {
  /** Byte offset into the spill file. */
  offset?: number;
  /** Maximum bytes to return (default 50KB). */
  maxBytes?: number;
}

export interface SpillSlice {
  content: string;
  offset: number;
  lengthBytes: number;
  totalBytes: number;
  /** True when the slice runs to the end of the file. */
  atEnd: boolean;
}

/**
 * Page a slice of a spill file back into context. Invalid utf8 sequences are
 * replaced with U+FFFD rather than throwing (Node's default decode behavior).
 */
export function readSpillSlice(
  spillPath: string,
  options: SpillSliceOptions = {},
): SpillSlice {
  const maxBytes = options.maxBytes ?? PREVIEW_CAP_BYTES;
  const buf = fs.readFileSync(spillPath);
  const offset = Math.max(0, Math.min(options.offset ?? 0, buf.length));
  const end = Math.min(buf.length, offset + maxBytes);
  const slice = buf.subarray(offset, end);
  return {
    content: slice.toString("utf8"),
    offset,
    lengthBytes: slice.length,
    totalBytes: buf.length,
    atEnd: end >= buf.length,
  };
}

/**
 * Recall-driven tail recovery: fetch the last `tailBytes` of a spill file,
 * snapped to line boundaries, without re-running the original tool.
 */
export function recallSpillTail(
  spillPath: string,
  tailBytes: number = PREVIEW_CAP_BYTES,
): SpillSlice & { lines: string[] } {
  const buf = fs.readFileSync(spillPath);
  let start = Math.max(0, buf.length - tailBytes);
  // snap forward to a line boundary
  while (start < buf.length && start > 0 && buf[start - 1] !== 0x0a) start++;
  const slice = buf.subarray(start, buf.length);
  const content = slice.toString("utf8");
  return {
    content,
    offset: start,
    lengthBytes: slice.length,
    totalBytes: buf.length,
    atEnd: true,
    lines: content.split("\n").filter((l) => l.length > 0),
  };
}

/**
 * Recall-driven needle search inside a spill file: returns the lines around
 * the first occurrence of `needle` (or null when absent). This is what the
 * agent uses to verify a specific marker (e.g. "LINE 0099") in the omitted
 * region without re-executing the tool.
 */
export function recallSpillFind(
  spillPath: string,
  needle: string,
  contextLines: number = 2,
): { lineIndex: number; text: string } | null {
  const content = fs.readFileSync(spillPath, "utf8");
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => l.includes(needle));
  if (idx === -1) return null;
  const from = Math.max(0, idx - contextLines);
  const to = Math.min(lines.length, idx + contextLines + 1);
  return { lineIndex: idx, text: lines.slice(from, to).join("\n") };
}

/**
 * Locate a needle that must appear in the *omitted* region: verifies it is NOT
 * in the preview but IS in the spill — the recovery contract the eval checks.
 */
export function verifyOmittedTailRecovered(
  result: TruncateWithSpillResult,
  needle: string,
): {
  recovered: boolean;
  inPreview: boolean;
  inSpill: boolean;
  evidence: string | null;
} {
  const inPreview = result.content.includes(needle);
  let inSpill = false;
  let evidence: string | null = null;
  if (result.spillPath) {
    const found = recallSpillFind(result.spillPath, needle);
    if (found) {
      inSpill = true;
      evidence = found.text;
    }
  }
  return { recovered: !inPreview && inSpill, inPreview, inSpill, evidence };
}
