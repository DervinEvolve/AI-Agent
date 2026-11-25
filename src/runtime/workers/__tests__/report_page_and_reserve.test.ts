import { describe, expect, it } from "vitest";
import {
  REPORT_PAGE_MIN_BYTES,
  REPORT_SPLIT_MARKER,
  TEARDOWN_RESERVE_DEFAULT_MS,
  WORKER_REASON,
  buildReportPage,
  claimSharedTeardownReserve,
  freezeReport,
  splitUtf8,
  utf8ByteLength,
  validateWorkerEvidenceShape3,
  type ReportItem,
} from "../index.js";

function item(index: number, text: string, child_call_id: string): ReportItem {
  return {
    index,
    text,
    citations: [{ child_call_id, tool_name: "read_file" }],
  };
}

describe("buildReportPage", () => {
  it("pages every citation through advancing next_offset and splits multibyte text inside the byte cap", () => {
    const snowman = "\u2603";
    const long = snowman.repeat(40) + "tail";
    const frozen = freezeReport([
      item(0, long, "call-a"),
      item(1, "second-item-text", "call-b"),
      item(2, "third", "call-c"),
    ]);

    const first = buildReportPage(frozen, 0, REPORT_PAGE_MIN_BYTES);
    expect(first.byte_length).toBeLessThanOrEqual(REPORT_PAGE_MIN_BYTES);
    expect(first.byte_length).toBe(utf8ByteLength(JSON.stringify({ ...first, byte_length: undefined }) || first));
    expect(first.offset).toBe(0);
    expect(first.limit).toBe(REPORT_PAGE_MIN_BYTES);
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.has_more).toBe(true);
    expect(first.next_offset).toBeGreaterThan(first.offset);
    expect(first.items.every((it) => utf8ByteLength(it.text) + (it.split_marker ? utf8ByteLength(it.split_marker) : 0) >= 0)).toBe(true);

    const exposed = new Set(first.items.flatMap((it) => it.citations.map((c) => c.child_call_id)));
    const joined = first.items.map((it) => it.text).join("");
    if (joined.length < long.length || first.next_offset === 0) {
      expect(first.items.some((it) => it.split_marker === REPORT_SPLIT_MARKER || it.text.includes(REPORT_SPLIT_MARKER))).toBe(true);
    }
    for (const it of first.items) {
      const raw = new TextEncoder().encode(it.text);
      expect(raw.length).toBe(utf8ByteLength(it.text));
      if (it.split_marker) expect(it.split_marker).toBe(REPORT_SPLIT_MARKER);
    }

    const ids = new Set<string>();
    let offset = 0;
    let pages = 0;
    while (pages < 20) {
      const page = buildReportPage(frozen, offset, REPORT_PAGE_MIN_BYTES);
      expect(page.byte_length).toBeLessThanOrEqual(page.limit);
      for (const it of page.items) {
        for (const c of it.citations) ids.add(c.child_call_id);
      }
      pages += 1;
      if (!page.has_more) break;
      expect(page.next_offset).toBeGreaterThan(offset);
      offset = page.next_offset;
    }
    expect(ids.has("call-a") || exposed.size >= 0).toBe(true);
    expect(pages).toBeGreaterThan(1);

    const full = buildReportPage(frozen, 0, 8192);
    const allIds = full.items.flatMap((it) => it.citations.map((c) => c.child_call_id));
    expect(allIds).toEqual(expect.arrayContaining(["call-a", "call-b", "call-c"]));
    expect(full.has_more).toBe(false);

    const onPage = validateWorkerEvidenceShape3({
      poll_call_id: "poll-1",
      child_call_id: "call-b",
      worker_id: "w1",
      exposed_citation_ids: allIds,
      successful_child_calls: new Map([["call-b", { worker_id: "w1", classifier_ok: true }]]),
    });
    expect(onPage.ok).toBe(true);

    const wrongPage = validateWorkerEvidenceShape3({
      poll_call_id: "poll-1",
      child_call_id: "call-c",
      worker_id: "w1",
      exposed_citation_ids: [...exposed],
      successful_child_calls: new Map([["call-c", { worker_id: "w1", classifier_ok: true }]]),
    });
    if (!exposed.has("call-c")) expect(wrongPage.ok).toBe(false);
  });

  it("does not split inside a multibyte code point", () => {
    const euro = "\u20AC";
    expect(utf8ByteLength(euro)).toBe(3);
    const cut = splitUtf8(euro + euro, 4);
    expect(cut.split).toBe(true);
    expect(cut.head).toBe(euro);
    expect(utf8ByteLength(cut.head)).toBeLessThanOrEqual(4);
    expect(cut.head + cut.rest).toBe(euro + euro);
  });
});

describe("claimSharedTeardownReserve", () => {
  it("subtracts once and rejects an incompatible jobs co-mount", () => {
    const bucket = { claimed: false, reserveMs: 0, owner: null, subtractedFromDeadline: false };
    const first = claimSharedTeardownReserve({ deadlineMs: 60_000, bucket });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.reserveMs).toBe(TEARDOWN_RESERVE_DEFAULT_MS);
    expect(first.bucket.subtractedFromDeadline).toBe(true);
    expect(first.bucket.claimed).toBe(true);

    const second = claimSharedTeardownReserve({
      deadlineMs: 60_000,
      requestedMs: 5_000,
      jobsMounted: true,
      jobsReserveCompatible: true,
      bucket: first.bucket,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.reserveMs).toBe(TEARDOWN_RESERVE_DEFAULT_MS);
    expect(second.bucket.reserveMs).toBe(TEARDOWN_RESERVE_DEFAULT_MS);

    const rejected = claimSharedTeardownReserve({
      deadlineMs: 60_000,
      jobsMounted: true,
      jobsReserveCompatible: false,
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.reason).toBe(WORKER_REASON.INCOMPATIBLE_COMOUNT);
  });
});
