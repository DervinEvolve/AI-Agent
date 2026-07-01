import { divide, formatDivisionExplanation } from './cap_basic_division_7';
import { SafeIntegerError } from '../constraints/constraints';

describe('cap_basic_division_7 — educational error messages and edge cases', () => {
  describe('division by zero — educational explanation', () => {
    test('throws SafeIntegerError with explanatory message', () => {
      expect(() => divide(5, 0)).toThrow(SafeIntegerError);
      try {
        divide(5, 0);
      } catch (error) {
        if (error instanceof SafeIntegerError) {
          expect(error.message).toMatch(/Division by zero is undefined/);
          expect(error.message).toMatch(/0 × q/);
          expect(error.message).toMatch(/mathematicians therefore leave division by zero undefined/);
        }
      }
    });

    test('dividing zero by zero also rejected with explanation', () => {
      expect(() => divide(0, 0)).toThrow(SafeIntegerError);
    });
  });

  describe('invalid inputs — non‑integer, non‑finite, out‑of‑range', () => {
    test('non‑integer dividend', () => {
      expect(() => divide(3.14, 2)).toThrow(SafeIntegerError);
    });

    test('non‑integer divisor', () => {
      expect(() => divide(7, 2.5)).toThrow(SafeIntegerError);
    });

    test('NaN dividend', () => {
      expect(() => divide(NaN, 3)).toThrow(SafeIntegerError);
    });

    test('Infinity divisor', () => {
      expect(() => divide(10, Infinity)).toThrow(SafeIntegerError);
    });

    test('dividend larger than safe integer', () => {
      expect(() => divide(Number.MAX_SAFE_INTEGER + 1, 1)).toThrow(SafeIntegerError);
    });

    test('divisor less than -MAX_SAFE_INTEGER', () => {
      expect(() => divide(1, Number.MIN_SAFE_INTEGER - 1)).toThrow(SafeIntegerError);
    });

    test('error messages mention the label and the invalid value', () => {
      expect(() => divide(1.5, 2))
        .toThrow(/dividend must be an integer.*received 1\.5/);
      expect(() => divide(4, 0.001))
        .toThrow(/divisor must be an integer.*received 0\.001/);
    });
  });

  describe('formatDivisionExplanation — educational output', () => {
    test('produces a complete sentence with quotient and remainder', () => {
      const explanation = formatDivisionExplanation(7, 3, { quotient: 2, remainder: 1 });
      expect(explanation).toContain('7 ÷ 3 = 2 with remainder 1');
      expect(explanation).toContain('Because 3 × 2 + 1 = 7');
      expect(explanation).toContain('0 ≤ 1 < 3');
    });

    test('references the absolute value of divisor for negative divisors', () => {
      const explanation = formatDivisionExplanation(-7, -3, { quotient: 3, remainder: 2 });
      expect(explanation).toContain('-7 ÷ -3 = 3 with remainder 2');
      expect(explanation).toContain('Because -3 × 3 + 2 = -7');
      expect(explanation).toContain('0 ≤ 2 < 3'); // |divisor| = 3
    });

    test('exact division output is correct', () => {
      const explanation = formatDivisionExplanation(20, 5, { quotient: 4, remainder: 0 });
      expect(explanation).toContain('20 ÷ 5 = 4 with remainder 0');
      expect(explanation).toContain('0 ≤ 0 < 5');
    });
  });

  describe('Euclidean invariant — property‑based random tests', () => {
    // Generate many random safe integer pairs and verify a = b * q + r and 0 ≤ r < |b|
    const randomSafeInt = (): number => {
      const range = Number.MAX_SAFE_INTEGER - 2;
      return Math.floor(Math.random() * (2 * range + 1)) - range;
    };

    const testCases = 1000;
    const pairs: [number, number][] = [];
    for (let i = 0; i < testCases; i++) {
      let divisor = randomSafeInt();
      // Ensure divisor is non‑zero
      while (divisor === 0) {
        divisor = randomSafeInt();
      }
      pairs.push([randomSafeInt(), divisor]);
    }

    test.each(pairs)('a = %i, b = %i', (a, b) => {
      const { quotient, remainder } = divide(a, b);
      const absB = Math.abs(b);

      // Euclidean identity
      expect(b * quotient + remainder).toBe(a);

      // Remainder bounds
      expect(remainder).toBeGreaterThanOrEqual(0);
      expect(remainder).toBeLessThan(absB);
    });
  });

  describe('exact boundary values', () => {
    test('maximum safe integer divided by itself yields quotient 1, remainder 0', () => {
      const max = Number.MAX_SAFE_INTEGER;
      const result = divide(max, max);
      expect(result.quotient).toBe(1);
      expect(result.remainder).toBe(0);
    });

    test('maximum safe integer divided by 1 yields itself', () => {
      const max = Number.MAX_SAFE_INTEGER;
      const result = divide(max, 1);
      expect(result.quotient).toBe(max);
      expect(result.remainder).toBe(0);
    });

    test('minimum safe integer divided by -1 yields -MIN_SAFE_INTEGER? Actually MAX_SAFE_INTEGER', () => {
      const min = Number.MIN_SAFE_INTEGER;
      const result = divide(min, -1);
      // -min should be MAX_SAFE_INTEGER for MIN_SAFE_INTEGER = -MAX_SAFE_INTEGER
      expect(result.quotient).toBe(Number.MAX_SAFE_INTEGER);
      expect(result.remainder).toBe(0);
    });

    test('zero dividend by any non‑zero divisor yields 0,0', () => {
      const result = divide(0, 7);
      expect(result.quotient).toBe(0);
      expect(result.remainder).toBe(0);
    });

    test('zero dividend by negative divisor', () => {
      const result = divide(0, -5);
      expect(result.quotient).toBe(0);
      expect(result.remainder).toBe(0);
    });
  });

  describe('mix of signs preserving Euclidean remainder', () => {
    test('positive / positive with remainder', () => {
      const result = divide(10, 6);
      expect(result).toEqual({ quotient: 1, remainder: 4 });
    });

    test('negative / positive', () => {
      const result = divide(-10, 6);
      expect(result).toEqual({ quotient: -2, remainder: 2 });
      expect(0).toBeLessThanOrEqual(result.remainder);
      expect(result.remainder).toBeLessThan(6);
    });

    test('positive / negative', () => {
      const result = divide(10, -6);
      expect(result).toEqual({ quotient: -2, remainder: 4 });
      expect(result.remainder).toBeGreaterThanOrEqual(0);
      expect(result.remainder).toBeLessThan(6);
    });

    test('negative / negative', () => {
      const result = divide(-10, -6);
      expect(result).toEqual({ quotient: 2, remainder: 2 });
      expect(result.remainder).toBeGreaterThanOrEqual(0);
      expect(result.remainder).toBeLessThan(6);
    });
  });

  describe('formatDivisionExplanation covers remainder inequality correctly for large absolute divisor', () => {
    test('large positive divisor', () => {
      const explanation = formatDivisionExplanation(1, 9876543210, { quotient: 0, remainder: 1 });
      expect(explanation).toContain('0 ≤ 1 < 9876543210');
    });

    test('large negative divisor — uses absolute value', () => {
      const explanation = formatDivisionExplanation(-1, -1234567890, {
        quotient: 1,
        remainder: 1234567889,
      });
      expect(explanation).toContain('0 ≤ 1234567889 < 1234567890');
    });
  });
});
