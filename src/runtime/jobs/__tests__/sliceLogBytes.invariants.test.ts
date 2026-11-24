import { describe, it, expect } from 'vitest';
import { sliceLogBytes, JOB_CAPS } from '../types';

const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

describe('sliceLogBytes invariants', () => {
  it('walks a multi-byte stream without splitting code points or exceeding limit', () => {
    // 1-, 2-, 3- and 4-byte code points mixed together.
    const text = 'a\u00e9\u20ac\u{1F600}z'.repeat(7) + 'end\n';
    const buf = enc(text);
    const total = buf.length;

    for (const limit of [4, 5, 6, 7, 9]) {
      let offset = 0;
      let out = '';
      let guard = 0;
      while (offset < total) {
        guard += 1;
        expect(guard).toBeLessThan(1000);
        const r = sliceLogBytes(buf, total, offset, limit);
        expect(byteLen(r.data)).toBeLessThanOrEqual(limit);
        expect(r.data).not.toContain('\uFFFD');
        expect(r.next_offset).toBeGreaterThan(offset);
        expect(r.next_offset).toBeLessThanOrEqual(total);
        expect(r.next_offset - offset).toBe(byteLen(r.data));
        expect(r.gap).toBeUndefined();
        expect(r.dropped_bytes).toBe(0);
        out += r.data;
        offset = r.next_offset;
      }
      expect(out).toBe(text);
      expect(offset).toBe(total);
    }
  });

  it('reads head, then reports the gap and resumes at the tail start', () => {
    const head = 4;
    const ring = 8;
    const total = 100;
    const full = enc('HEADringdata');
    expect(full.length).toBe(head + ring);
    const tailStart = total - ring; // 92
    const dropped = total - head - ring; // 88

    // A read from the head is capped at the head boundary.
    const h = sliceLogBytes(full, total, 0, 10, false, head, ring);
    expect(h.data).toBe('HEAD');
    expect(h.next_offset).toBe(head);
    expect(h.gap).toBeUndefined();
    expect(h.dropped_bytes).toBe(dropped);

    // Continuing lands in the dropped middle: gap reported, resume at tail start.
    const g = sliceLogBytes(full, total, h.next_offset, 4, false, head, ring);
    expect(g.gap).toEqual({ from: head, to: tailStart });
    expect(g.data).toBe('ring');
    expect(g.next_offset).toBe(tailStart + 4);
    expect(g.dropped_bytes).toBe(dropped);

    // Inside the ring there is no further gap.
    const t = sliceLogBytes(full, total, g.next_offset, 4, false, head, ring);
    expect(t.gap).toBeUndefined();
    expect(t.data).toBe('data');
    expect(t.next_offset).toBe(total);
  });

  it('3 MiB stream with default caps: tail returns the marker within the output cap', () => {
    const total = 3 * 1024 * 1024;
    const marker = 'JOB-DONE-MARKER\n';
    const retained = JOB_CAPS.headBytes + JOB_CAPS.ringBytes;
    const full = new Uint8Array(retained).fill(120); // 'x'
    full.set(enc(marker), retained - marker.length);
    const limit = JOB_CAPS.outputBytes;

    const t = sliceLogBytes(full, total, 0, limit, true);
    expect(t.data).toContain(marker.trim());
    expect(byteLen(t.data)).toBeLessThanOrEqual(limit);
    expect(t.data).not.toContain('\uFFFD');
    expect(t.dropped_bytes).toBe(total - retained);
    expect(t.next_offset).toBeGreaterThan(total - limit);
    expect(t.next_offset).toBeLessThanOrEqual(total);

    // A cursor in the dropped middle reports the gap and stays within the cap.
    const mid = JOB_CAPS.headBytes + 1000;
    const g = sliceLogBytes(full, total, mid, limit);
    expect(g.gap).toEqual({ from: mid, to: total - JOB_CAPS.ringBytes });
    expect(byteLen(g.data)).toBeLessThanOrEqual(limit);
    expect(g.next_offset).toBeGreaterThan(total - JOB_CAPS.ringBytes);
    expect(g.dropped_bytes).toBe(total - retained);
  });
});
