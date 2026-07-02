import { describe, it, expect } from 'vitest';
import { computeExponentiation } from '../cap_exponentiation_10.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function expectSuccess(a: number, b: number, expectedResult: number, explanationContains?: string) {
  const out = computeExponentiation(a, b);
  expect(out).toHaveProperty('result');
  if ('result' in out) {
    expect(out.result).toBe(expectedResult);
    if (explanationContains) {
      expect(out.explanation).toContain(explanationContains);
    }
  }
}

function expectError(a: number, b: number, errorCode: string) {
  const out = computeExponentiation(a, b);
  expect(out).toHaveProperty('error');
  if ('error' in out) {
    expect(out.error).toBe(errorCode);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeExponentiation', () => {
  describe('basic positive exponentiation', () => {
    it('2^3 = 8', () => expectSuccess(2, 3, 8));
    it('3^2 = 9', () => expectSuccess(3, 2, 9));
    it('5^0 = 1', () => expectSuccess(5, 0, 1));
    it('7^1 = 7', () => expectSuccess(7, 1, 7));
    it('10^6 = 1000000', () => expectSuccess(10, 6, 1_000_000));
  });

  describe('negative base', () => {
    it('(-2)^3 = -8 (odd exponent)', () => expectSuccess(-2, 3, -8));
    it('(-2)^4 = 16 (even exponent)', () => expectSuccess(-2, 4, 16));
    it('(-3)^3 = -27', () => expectSuccess(-3, 3, -27));
    it('(-3)^4 = 81', () => expectSuccess(-3, 4, 81));
  });

  describe('special base values', () => {
    it('0^5 = 0', () => expectSuccess(0, 5, 0));
    it('0^1 = 0', () => expectSuccess(0, 1, 0));
    it('0^0 is rejected', () => expectError(0, 0, 'ZERO_TO_ZERO'));
    it('1^100 = 1', () => expectSuccess(1, 100, 1));
    it('1^0 = 1', () => expectSuccess(1, 0, 1));
    it('(-1)^100 = 1 (even)', () => expectSuccess(-1, 100, 1));
    it('(-1)^101 = -1 (odd)', () => expectSuccess(-1, 101, -1));
  });

  describe('exponent zero', () => {
    it('42^0 = 1', () => expectSuccess(42, 0, 1));
    it('(-7)^0 = 1', () => expectSuccess(-7, 0, 1));
  });

  describe('overflow detection', () => {
    it('2^53 overflows', () => expectError(2, 53, 'OVERFLOW'));
    it('2^100 overflows', () => expectError(2, 100, 'OVERFLOW'));
    it('10^16 overflows', () => expectError(10, 16, 'OVERFLOW'));
    it('3^40 overflows', () => expectError(3, 40, 'OVERFLOW'));
    it('(-2)^53 overflows', () => expectError(-2, 53, 'OVERFLOW'));
    // Edge: exactly at the boundary should succeed
    // 2^52 = 4503599627370496 < MAX_SAFE_INTEGER
    it('2^52 succeeds (just within safe range)', () => {
      const out = computeExponentiation(2, 52);
      expect(out).toHaveProperty('result');
      if ('result' in out) {
        expect(out.result).toBe(4503599627370496);
      }
    });
  });

  describe('invalid inputs', () => {
    it('negative exponent is rejected', () => expectError(2, -3, 'NEGATIVE_EXPONENT'));
    it('non-integer base is rejected', () => expectError(2.5, 3, 'INVALID_BASE'));
    it('non-integer exponent is rejected', () => expectError(2, 3.5, 'INVALID_EXPONENT'));
    it('NaN base is rejected', () => expectError(NaN, 3, 'INVALID_BASE'));
    it('NaN exponent is rejected', () => expectError(2, NaN, 'INVALID_EXPONENT'));
    it('Infinity base is rejected', () => expectError(Infinity, 3, 'INVALID_BASE'));
    it('Infinity exponent is rejected', () => expectError(2, Infinity, 'INVALID_EXPONENT'));
    it('base exceeding safe integer is rejected', () =>
      expectError(Number.MAX_SAFE_INTEGER + 1, 2, 'INVALID_BASE'));
    it('exponent exceeding safe integer is rejected', () =>
      expectError(2, Number.MAX_SAFE_INTEGER + 1, 'INVALID_EXPONENT'));
  });

  describe('-0 normalization', () => {
    it('(-0)^3 returns 0, not -0', () => {
      // 0^3 = 0; Object.is(0, -0) is false, should normalize
      const out = computeExponentiation(0, 3);
      expect(out).toHaveProperty('result');
      if ('result' in out) {
        expect(out.result).toBe(0);
        expect(Object.is(out.result, -0)).toBe(false);
      }
    });
    it('(-2)^3 = -8 is not normalized to 0', () => {
      const out = computeExponentiation(-2, 3);
      expect(out).toHaveProperty('result');
      if ('result' in out) {
        expect(out.result).toBe(-8);
      }
    });
  });

  describe('edge cases near MAX_SAFE_INTEGER', () => {
    it('base = MAX_SAFE_INTEGER, exponent 1 returns MAX_SAFE_INTEGER', () => {
      expectSuccess(Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
    });
    it('base = MAX_SAFE_INTEGER, exponent 2 overflows', () => {
      expectError(Number.MAX_SAFE_INTEGER, 2, 'OVERFLOW');
    });
    it('base = -MAX_SAFE_INTEGER, exponent 1 returns -MAX_SAFE_INTEGER', () => {
      expectSuccess(-Number.MAX_SAFE_INTEGER, 1, -Number.MAX_SAFE_INTEGER);
    });
  });

  describe('explanation text', () => {
    it('includes sign explanation for negative base', () => {
      const out = computeExponentiation(-2, 3);
      if ('result' in out) {
        expect(out.explanation).toContain('negative base raised to an odd exponent yields a negative result');
      }
    });
    it('includes zero exponent explanation', () => {
      const out = computeExponentiation(5, 0);
      if ('result' in out) {
        expect(out.explanation).toContain('raised to zero is one');
      }
    });
    it('0^0 explanation mentions undefined', () => {
      const out = computeExponentiation(0, 0);
      if ('error' in out) {
        expect(out.explanation).toContain('undefined');
      }
    });
    it('overflow explanation mentions safe integer range', () => {
      const out = computeExponentiation(2, 100);
      if ('error' in out) {
        expect(out.explanation).toContain('safe integer range');
      }
    });
  });
});
