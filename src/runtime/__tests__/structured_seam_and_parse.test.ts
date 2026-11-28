import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HeldCandidateSeam,
  UNTRUSTED_FEEDBACK_LABEL,
  buildStructuredFeedback,
  digestCandidate,
  digestText,
  dropCandidate,
  holdCandidate,
  parseStrictAnswer,
  releaseCandidate,
} from "../structured/types";

describe("structured parse, feedback, and held-candidate seam", () => {
  it("rejects duplicate keys (including escaped aliases) and trailing junk that JSON.parse would accept", () => {
    const dup = '{"a":1,"a":2}';
    expect(JSON.parse(dup)).toEqual({ a: 2 });
    expect(parseStrictAnswer(dup)).toEqual({ ok: false, code: "not_json" });
    expect(parseStrictAnswer('{"a":1,"\\u0061":2}')).toEqual({ ok: false, code: "not_json" });
    expect(parseStrictAnswer('{"nested":{"a":1,"a":2}}')).toEqual({ ok: false, code: "not_json" });
    expect(parseStrictAnswer('[{"a":1},{"a":1,"a":2}]')).toEqual({ ok: false, code: "not_json" });
    expect(parseStrictAnswer('{"a":1} trailing')).toEqual({ ok: false, code: "not_json" });
    expect(parseStrictAnswer("")).toEqual({ ok: false, code: "not_json" });
    expect(parseStrictAnswer(new Uint8Array([0xff, 0xfe]))).toEqual({ ok: false, code: "not_json" });

    const ok = parseStrictAnswer('{"a":1,"b":[true,null]}  \n');
    expect(ok).toEqual({ ok: true, value: { a: 1, b: [true, null] } });
  });

  it("holds a candidate unchanged, digests with sha256, and releases or drops exactly once", () => {
    const text = '{"ok":true}';
    const expected = createHash("sha256").update(text, "utf8").digest("hex");
    expect(digestText(text)).toBe(expected);

    const seam = new HeldCandidateSeam();
    expect(seam.isHeld()).toBe(false);
    expect(digestCandidate(seam)).toBeNull();
    expect(releaseCandidate(seam)).toBeNull();

    holdCandidate(seam, text);
    expect(seam.isHeld()).toBe(true);
    expect(seam.digest()).toBe(expected);
    expect(digestCandidate(seam)).toBe(expected);

    const peeked = seam.peek();
    expect(peeked).toEqual({ text, digest: expected });
    expect(seam.isHeld()).toBe(true);

    const released = releaseCandidate(seam);
    expect(released).toEqual({ text, digest: expected });
    expect(seam.isHeld()).toBe(false);
    expect(seam.peek()).toBeNull();
    expect(releaseCandidate(seam)).toBeNull();

    holdCandidate(seam, text);
    holdCandidate(seam, text + " ");
    expect(seam.digest()).toBe(digestText(text + " "));
    expect(seam.digest()).not.toBe(expected);
    dropCandidate(seam);
    expect(seam.isHeld()).toBe(false);
    expect(releaseCandidate(seam)).toBeNull();

    expect(() => seam.hold(1 as unknown as string)).toThrow(TypeError);
  });

  it("builds path-level feedback with only code, pointer, and keyword under the byte cap", () => {
    const raw = [
      {
        keyword: "type",
        instancePath: "/ok",
        message: "expected boolean",
        schema: { description: "do-not-leak" },
        params: { type: "boolean" },
      },
      { code: "required", pointer: "/missing", keyword: "required", extra: "nope" },
      "not-an-error",
      null,
    ];
    const open = buildStructuredFeedback(raw, { maxErrors: 8, maxErrorBytes: 4096 });
    expect(open.items).toEqual([
      { code: "type", pointer: "/ok", keyword: "type" },
      { code: "required", pointer: "/missing", keyword: "required" },
    ]);
    expect(open.bytes).toBe(Buffer.byteLength(JSON.stringify(open.items), "utf8"));
    expect(open.labelled.startsWith(UNTRUSTED_FEEDBACK_LABEL + "\n")).toBe(true);
    expect(open.labelled).not.toContain("expected boolean");
    expect(open.labelled).not.toContain("do-not-leak");
    expect(open.labelled).not.toContain("boolean");
    expect(Object.keys(open.items[0]).sort()).toEqual(["code", "keyword", "pointer"]);

    const one = buildStructuredFeedback(raw, { maxErrors: 1, maxErrorBytes: 4096 });
    expect(one.items).toHaveLength(1);
    expect(one.items[0]).toEqual({ code: "type", pointer: "/ok", keyword: "type" });

    const firstBytes = Buffer.byteLength(JSON.stringify([one.items[0]]), "utf8");
    const tight = buildStructuredFeedback(raw, { maxErrors: 8, maxErrorBytes: firstBytes });
    expect(tight.items).toEqual([one.items[0]]);
    expect(tight.bytes).toBe(firstBytes);

    const none = buildStructuredFeedback(raw, { maxErrors: 8, maxErrorBytes: firstBytes - 1 });
    expect(none.items).toEqual([]);
    expect(none.bytes).toBe(2);
    expect(none.labelled).toBe(UNTRUSTED_FEEDBACK_LABEL + "\n[]");
  });
});
