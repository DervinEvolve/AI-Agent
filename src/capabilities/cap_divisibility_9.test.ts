import { isDivisible } from './cap_divisibility_9';

describe('cap_divisibility_9 - isDivisible', () => {
  it('reports 12 divisible by 3 with exact factorization', () => {
    const r = isDivisible(12, 3);
    expect(r.ok).toBe(true);
    expect(r.divisible).toBe(true);
    expect(r.remainder).toBe(0);
    expect(r.quotient).toBe(4);
    expect(r.message).toBe('12 is divisible by 3 because 12 = 3 × 4.');
  });

  it('rejects a zero divisor with educational message', () => {
    const r = isDivisible(12, 0);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('DIVIDE_BY_ZERO');
    expect(r.message).toMatch(/nothing is divisible by zero/);
  });

  it('treats 0 as divisible by every nonzero b', () => {
    const r = isDivisible(0, 7);
    expect(r.ok).toBe(true);
    expect(r.divisible).toBe(true);
    expect(r.remainder).toBe(0);
    expect(r.quotient).toBe(0);
  });

  it('handles negative dividend (-12 by 3)', () => {
    const r = isDivisible(-12, 3);
    expect(r.divisible).toBe(true);
    expect(r.remainder).toBe(0);
    expect(r.quotient).toBe(-4);
  });

  it('handles negative divisor (12 by -3)', () => {
    const r = isDivisible(12, -3);
    expect(r.divisible).toBe(true);
    expect(r.remainder).toBe(0);
    expect(r.quotient).toBe(-4);
  });

  it('handles both negative (-12 by -3)', () => {
    const r = isDivisible(-12, -3);
    expect(r.divisible).toBe(true);
    expect(r.remainder).toBe(0);
    expect(r.quotient).toBe(4);
  });

  it('b === 1 always divides', () => {
    expect(isDivisible(999, 1).divisible).toBe(true);
    expect(isDivisible(-5, 1).divisible).toBe(true);
  });

  it('a === b divides evenly with quotient 1', () => {
    const r = isDivisible(42, 42);
    expect(r.divisible).toBe(true);
    expect(r.quotient).toBe(1);
  });

  it('|a| < |b| with a !== 0 is not divisible', () => {
    const r = isDivisible(3, 12);
    expect(r.divisible).toBe(false);
    expect(r.remainder).toBe(3);
    expect(r.quotient).toBeUndefined();
    expect(r.message).toMatch(/not divisible/);
  });

  it('non-zero remainder is reported as non-negative', () => {
    const r = isDivisible(-13, 64);
    expect(r.divisible).toBe(false);
    expect(r.remainder).toBe(51); // ((-13 % 64) + 64) % 64
  });

  it('handles safe-integer boundary values', () => {
    const max = Number.MAX_SAFE_INTEGER; // 2^53 - 1
    expect(isDivisible(max, 1).divisible).toBe(true);
    expect(isDivisible(max, max).divisible).toBe(true);
    expect(isDivisible(-max, -max).divisible).toBe(true);
  });

  it('rejects non-integer / non-finite inputs', () => {
    expect(isDivisible(1.5, 3).ok).toBe(false);
    expect(isDivisible(NaN, 3).ok).toBe(false);
    expect(isDivisible(Infinity, 3).ok).toBe(false);
    // @ts-expect-error testing runtime rejection of string input
    expect(isDivisible('12', 3).ok).toBe(false);
  });

  it('rejects values beyond the safe integer range', () => {
    const beyond = Number.MAX_SAFE_INTEGER + 2;
    const r = isDivisible(beyond, 3);
    expect(r.ok).toBe(false);
  });
});
