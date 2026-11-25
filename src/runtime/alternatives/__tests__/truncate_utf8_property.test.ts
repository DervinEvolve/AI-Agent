import { describe, it, expect } from 'vitest';
import { ALTERNATIVES_CAPS, truncateUtf8Bytes, utf8ByteLength } from '../types';

const encoder = new TextEncoder();

const SAMPLES = [
  '',
  'plain ascii path/to/file.ts',
  'héllo wörld',
  '目录/文件.ts',
  '😀😀😀',
  'a😀b目é/z',
];

describe('truncateUtf8Bytes exhaustive budget sweep', () => {
  it('returns a maximal well-formed prefix within budget for every budget', () => {
    for (const s of SAMPLES) {
      const total = encoder.encode(s).length;
      const codePoints = Array.from(s);
      for (let budget = 0; budget <= total + 2; budget++) {
        const r = truncateUtf8Bytes(s, budget);

        // Prefix of the input, within budget, with an honest byte count.
        expect(s.startsWith(r.text)).toBe(true);
        expect(r.bytes).toBeLessThanOrEqual(budget);
        expect(r.bytes).toBe(encoder.encode(r.text).length);
        expect(utf8ByteLength(r.text)).toBe(r.bytes);

        // Truncation flag matches whether anything was dropped.
        expect(r.truncated).toBe(r.text !== s);
        if (budget >= total) {
          expect(r.text).toBe(s);
        }

        // Whole code points only: the kept text is a code point prefix.
        const kept = Array.from(r.text);
        expect(kept).toEqual(codePoints.slice(0, kept.length));
        if (r.text.length > 0) {
          const last = r.text.charCodeAt(r.text.length - 1);
          const endsOnHighSurrogate = last >= 0xd800 && last <= 0xdbff;
          expect(endsOnHighSurrogate).toBe(false);
        }

        // Maximal: the next code point would not have fit.
        if (r.truncated) {
          const next = codePoints[kept.length];
          expect(r.bytes + encoder.encode(next).length).toBeGreaterThan(budget);
        }
      }
    }
  });

  it('cuts a long multibyte path at the changed-path cap without splitting', () => {
    const cap = ALTERNATIVES_CAPS.changedPathMaxBytes;
    expect(cap).toBe(256);
    const path = '目'.repeat(100); // 300 bytes, 3 bytes per code point
    expect(utf8ByteLength(path)).toBe(300);
    const r = truncateUtf8Bytes(path, cap);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe('目'.repeat(85));
    expect(r.bytes).toBe(255);
  });
});

describe('ALTERNATIVES_CAPS consistency', () => {
  it('keeps every ranged default inside its inclusive range', () => {
    const ranged = [
      ALTERNATIVES_CAPS.maxSetsPerRun,
      ALTERNATIVES_CAPS.maxAlternatives,
      ALTERNATIVES_CAPS.maxSteps,
      ALTERNATIVES_CAPS.parentStepReserve,
      ALTERNATIVES_CAPS.childRecoveryAllowance,
      ALTERNATIVES_CAPS.alternativesRecoveryBudget,
      ALTERNATIVES_CAPS.maxSnapshotBytes,
      ALTERNATIVES_CAPS.maxSnapshotFiles,
      ALTERNATIVES_CAPS.checkTimeoutMs,
      ALTERNATIVES_CAPS.teardownReserveMs,
    ];
    for (const c of ranged) {
      expect(c.min).toBeLessThanOrEqual(c.default);
      expect(c.default).toBeLessThanOrEqual(c.max);
    }
  });

  it('per-field path caps alone can fill the whole transcript budget', () => {
    // This is why the total serialized size must be enforced separately.
    expect(
      ALTERNATIVES_CAPS.changedPathsMaxItems * ALTERNATIVES_CAPS.changedPathMaxBytes,
    ).toBe(ALTERNATIVES_CAPS.transcriptMaxBytes);
    expect(ALTERNATIVES_CAPS.transcriptMaxBytes).toBe(8192);
    expect(Object.isFrozen(ALTERNATIVES_CAPS)).toBe(true);
  });
});
