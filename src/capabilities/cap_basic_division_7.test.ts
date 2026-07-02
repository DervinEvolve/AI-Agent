import { divide, formatDivisionExplanation } from './cap_basic_division_7';

describe('cap_basic_division_7 — Euclidean division', () => {
  describe('basic positive cases', () => {
    test('7 ÷ 3 = 2 r 1', () => {
      const result = divide(7, 3);
      expect(result.quotient).toBe(2);
      expect(result.remainder).toBe(1);
    });

    test('10 ÷ 2 = 5 r 0 (exact division)', () => {
      const result = divide(10, 2);
      expect(result.quotient).toBe(5);
      expect(result.remainder).toBe(0);
    });

    test('1 ÷ 5 = 0 r 1 (dividend smaller than divisor)', () => {
      const result = divide(1, 5);
      expect(result.quotient).toBe(0);
      expect(result.remainder).toBe(1);
    });
  });

  describe('negative dividend (Euclidean: remainder stays non-negative)', () => {
    test('-7 ÷ 3 = -3 r 2', () => {
      const result = divide(-7, 3);
      expect(result.quotient).toBe(-3);
      expect(result.remainder).toBe(2);
    });

    test('-10 ÷ 3 = -4 r 2', () => {
      const result = divide(-10, 3);
      expect(result.quotient).toBe(-4);
      expect(result.remainder).toBe(2);
    });

    test('-1 ÷ 5 = -1 r 4', () => {
      const result = divide(-1, 5);
      expect(result.quotient).toBe(-1);
      expect(result.remainder).toBe(4);
    });
  });

  describe('negative divisor', () => {
    test('7 ÷ -3 = -2 r 1 (remainder < |divisor|)', () => {
      const result = divide(7, -3);
      expect(result.quotient).toBe(-2);
      expect(result.remainder).toBe(1);
      // Verify Euclidean invariant: 0 ≤ r < |b|
      expect(result.remainder).toBeGreaterThanOrEqual(0);
      expect(result.remainder).toBeLessThan(Math.abs(-3));
    });

    test('-7 ÷ -3 = 3 r 2', () => {
      const result = divide(-7, -3);
      expect(result.quotient).toBe(3);
      expect(result.remainder).toBe(2);
      expect(result.remainder).toBeGreaterThanOrEqual(0);
      expect(result.remainder).toBeLessThan(Math.abs(-3));
    });
  });

  describe('division by zero — educational rejection', () => {
    test('throws with educational message for divisor 0', () => {
      expect(() => divide(5, 0)).toThrow();
      expect(() => divide(5, 0)).toThrow(/zero/);
    });

    test('throws even when dividend is 0', () => {
      expect(() => divide(0, 0)).toThrow();
      expect(() => divide(0, 0)).toThrow(/zero/);
    });
  });

  describe('large safe integers', () => {
    const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 2^53 - 1

    test('handles large positive operands', () => {
      const result = divide(MAX_SAFE, 2);
      expect(result.quotient).toBe(Math.floor(MAX_SAFE / 2));
      expect(result.remainder).toBe(1);
      expect(result.quotient * 2 + result.remainder).toBe(MAX_SAFE);
    });

    test('handles large negative dividend', () => {
      const result = divide(-MAX_SAFE, 7);
      expect(result.remainder).toBeGreaterThanOrEqual(0);
      expect(result.remainder).toBeLessThan(7);
      expect(BigInt(result.quotient) * 7n + BigInt(result.remainder)).toBe(BigInt(-MAX_SAFE));
    });
  });

  describe('Euclidean invariant: a = b * q + r, 0 ≤ r < |b|', () => {
    const cases: [number, number][] = [
      [17, 5],
      [-17, 5],
      [17, -5],
      [-17, -5],
      [0, 5],
      [0, -5],
      [42, 7],
      [-42, 7],
    ];

    test.each(cases)('dividend=%i, divisor=%i', (a, b) => {
      const { quotient: q, remainder: r } = divide(a, b);
      expect(b * q + r).toBe(a);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(Math.abs(b));
    });
  });

  describe('formatDivisionExplanation', () => {
    test('produces educational string', () => {
      const result = divide(7, 3);
      const explanation = formatDivisionExplanation(7, 3, result);
      expect(explanation).toContain('7 ÷ 3');
      expect(explanation).toContain('**Remainder:** 1');
      expect(explanation).toContain('3 × 2 + 1 = 7');
    });
  });
});
