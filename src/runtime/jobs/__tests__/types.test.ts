import { describe, it, expect } from 'vitest';
import { sliceLogBytes } from '../types';

const enc = (s: string) => new TextEncoder().encode(s);

describe('sliceLogBytes', () => {
  it('respects limit and advances', () => {
    const b = enc('hello world');
    const r = sliceLogBytes(b, b.length, 0, 5);
    expect(r.data).toBe('hello');
    expect(r.next_offset).toBe(5);
  });
  it('does not split code points', () => {
    const b = enc('aé');
    const r = sliceLogBytes(b, b.length, 0, 2);
    expect(r.data).toBe('a');
    expect(r.next_offset).toBe(1);
  });
  it('reports gap and dropped bytes, tail returns marker', () => {
    const head = 4;
    const ring = 8;
    const total = 100;
    const full = new Uint8Array(head + ring).fill(120);
    full.set(enc('MARK\n'), head + ring - 5);
    const t = sliceLogBytes(full, total, 0, 6, true, head, ring);
    expect(t.data).toContain('MARK');
    expect(t.dropped_bytes).toBe(total - head - ring);
    const g = sliceLogBytes(full, total, 10, 4, false, head, ring);
    expect(g.gap).toEqual({ from: 10, to: total - ring });
  });
});
