import { describe, it, expect } from "vitest";
import {
  VIEW_CAP_BYTES,
  capTranscriptView,
  classifyIntactResult,
  pageSnapshot,
} from "../browser_snapshot_view";

function bigSnapshot(): string {
  const lines: string[] = [];
  for (let i = 0; i < 4000; i++) lines.push(`[${i}] button "日本語🙂 value-${i}"`);
  return lines.join("\n");
}

describe("browser snapshot view cap", () => {
  it("leaves small text untouched", () => {
    const r = capTranscriptView("hello");
    expect(r).toEqual({ view: "hello", truncated: false, totalBytes: 5 });
  });

  it("caps a multibyte snapshot within 24 KiB including marker, no broken chars", () => {
    const full = bigSnapshot();
    expect(Buffer.byteLength(full)).toBeGreaterThan(VIEW_CAP_BYTES);
    const r = capTranscriptView(full);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.view)).toBeLessThanOrEqual(VIEW_CAP_BYTES);
    expect(r.view).not.toContain("\uFFFD");
  });

  it("handles every boundary alignment", () => {
    for (let pad = 0; pad < 5; pad++) {
      const full = "a".repeat(pad) + "🙂".repeat(8000);
      const r = capTranscriptView(full);
      expect(Buffer.byteLength(r.view)).toBeLessThanOrEqual(VIEW_CAP_BYTES);
      expect(r.view).not.toContain("\uFFFD");
    }
  });
});

describe("classification on intact result", () => {
  it("stays success when the view is truncated", () => {
    const full = bigSnapshot();
    const result = { status: "ok", output: { ok: true, snapshot: full } };
    const view = capTranscriptView(JSON.stringify(result));
    expect(view.truncated).toBe(true);
    expect(classifyIntactResult(result)).toBe("success");
  });

  it("maps other shapes", () => {
    expect(classifyIntactResult({ status: "error" })).toBe("failure");
    expect(classifyIntactResult({ status: "ok", output: { ok: false } })).toBe("failure");
    expect(classifyIntactResult({ status: "ok", output: "x" })).toBe("unknown");
  });
});

describe("paging full snapshot", () => {
  it("reconstructs everything with advancing offsets", () => {
    const full = bigSnapshot();
    let offset = 0;
    let acc = "";
    let guard = 0;
    for (;;) {
      const p = pageSnapshot(full, offset, 1001);
      acc += p.chunk;
      offset = p.next_offset;
      if (!p.has_more) break;
      expect(++guard).toBeLessThan(100000);
    }
    expect(acc).toBe(full);
  });

  it("rejects bad offsets and limits", () => {
    expect(() => pageSnapshot("abc", -1, 10)).toThrow();
    expect(() => pageSnapshot("abc", 4, 10)).toThrow();
    expect(() => pageSnapshot("abc", 0, 1)).toThrow();
  });
});
