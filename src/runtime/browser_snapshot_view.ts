// Pure helpers for the Stage A browser snapshot slice: a UTF-8-safe 24 KiB
// transcript view cap, classification of the INTACT tool result (never the
// truncated view), and byte-offset paging over the full stored snapshot.

export const VIEW_CAP_BYTES = 24 * 1024;

export interface CappedView {
  view: string;
  truncated: boolean;
  totalBytes: number;
}

function alignBack(buf: Buffer, end: number, floor: number): number {
  while (end > floor && end < buf.length && (buf[end] & 0xc0) === 0x80) end--;
  return end;
}

/** Cap a transcript view to cap bytes, marker included, on a code point boundary. */
export function capTranscriptView(text: string, cap: number = VIEW_CAP_BYTES): CappedView {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return { view: text, truncated: false, totalBytes: buf.length };
  const marker = `\n[truncated: ${buf.length} bytes total; use recall to page]`;
  const budget = Math.max(0, cap - Buffer.byteLength(marker, "utf8"));
  const end = alignBack(buf, budget, 0);
  return { view: buf.subarray(0, end).toString("utf8") + marker, truncated: true, totalBytes: buf.length };
}

export type BrowserOutcome = "success" | "failure" | "unknown";

/** Classify the intact result: outer status ok and output.ok true is success. */
export function classifyIntactResult(result: { status?: unknown; output?: unknown }): BrowserOutcome {
  if (result.status !== "ok") return "failure";
  const out = result.output as { ok?: unknown } | null | undefined;
  if (out && typeof out === "object") {
    if (out.ok === true) return "success";
    if (out.ok === false) return "failure";
  }
  return "unknown";
}

export interface Page {
  chunk: string;
  next_offset: number;
  has_more: boolean;
}

/** Page the full stored snapshot by byte offset; chunks end on char boundaries. */
export function pageSnapshot(full: string, offset: number, limit: number): Page {
  const buf = Buffer.from(full, "utf8");
  if (!Number.isInteger(offset) || offset < 0 || offset > buf.length) throw new RangeError("bad offset");
  if (!Number.isInteger(limit) || limit < 4) throw new RangeError("bad limit");
  let end = Math.min(offset + limit, buf.length);
  end = alignBack(buf, end, offset);
  return { chunk: buf.subarray(offset, end).toString("utf8"), next_offset: end, has_more: end < buf.length };
}
