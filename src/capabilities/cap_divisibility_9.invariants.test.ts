import { isDivisible } from './cap_divisibility_9';

// These tests exercise the underlying divisibility/remainder logic via
// mathematical invariants that must hold for the reused non-negative-remainder
// integer-division logic, without asserting exact message wording.
describe('cap_divisibility_9 - divisibility invariants', () => {
  const nonZeroDivisors = [3, -3, 7, -7, 1, -1, 5, 100, -100];
  const dividends = [0, 12, -12, 3, -3, 13, -13, 999, -1000, 42];

  it('non-negative remainder is always in [0, |b|) for valid inputs', () => {
    for (const a of dividends) {
      for (const b of nonZeroDivisors) {
        const r = isDivisible(a, b);
        expect(r.ok).toBe(true);
        expect(typeof r.remainder).toBe('number');
        const rem = r.remainder as number;
        expect(rem).toBeGreaterThanOrEqual(0);
        expect(rem).toBeLessThan(Math.abs(b));
      }
    }
  });

  it('divisible flag agrees with remainder === 0', () => {
    for (const a of dividends) {
      for (const b of nonZeroDivisors) {
        const r = isDivisible(a, b);
        expect(r.divisible).toBe((r.remainder as number) === 0);
      }
    }
  });

  it('when divisible, quotient reconstructs the dividend: a === b * quotient', () => {
    for (const a of dividends) {
      for (const b of nonZeroDivisors) {
        const r = isDivisible(a, b);
        if (r.divisible) {
          expect(typeof r.quotient).toBe('number');
          expect(b * (r.quotient as number)).toBe(a);
        }
      }
    }
  });

  it('divisibility matches an independent modulo computation', () => {
    for (const a of dividends) {
      for (const b of nonZeroDivisors) {
        const expectedDivisible = a % b === 0;
        const r = isDivisible(a, b);
        expect(r.divisible).toBe(expectedDivisible);
      }
    }
  });

  it('zero is divisible by every nonzero divisor with quotient 0', () => {
    for (const b of nonZeroDivisors) {
      const r = isDivisible(0, b);
      expect(r.divisible).toBe(true);
      expect(r.remainder).toBe(0);
      expect(r.quotient).toBe(0);
    }
  });

  it('rejects a zero divisor', () => {
    const r = isDivisible(10, 0);
    expect(r.ok).toBe(false);
    expect(r.divisible).toBeUndefined();
  });

  it('rejects non-integer and out-of-range inputs', () => {
    expect(isDivisible(1.5, 3).ok).toBe(false);
    expect(isDivisible(6, 2.5).ok).toBe(false);
    expect(isDivisible(NaN, 3).ok).toBe(false);
    expect(isDivisible(3, NaN).ok).toBe(false);
    expect(isDivisible(Number.MAX_SAFE_INTEGER + 2, 3).ok).toBe(false);
  });

  it('remainder equals |a| mod |b| for the classic 13-by-5 case', () => {
    const r = isDivisible(13, 5);
    expect(r.divisible).toBe(false);
    expect(r.remainder).toBe(3);
  });
});
