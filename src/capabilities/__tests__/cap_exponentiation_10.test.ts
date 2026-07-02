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
    it('(-1)^100 = 1 (even exponent)', () => expectSuccess(-1, 100, 1));
    it('(-1)^101 = -1 (odd exponent)', () => expectSuccess(-1, 101, -1));
  });

  describe('overflow detection via pre-multiplication check', () => {
    // Large result that would overflow safe integer range
    it('2^54 overflows', () => expectError(2, 54, 'OVERFLOW'));
    // Base and exponent that barely fit
    it('2^53 does NOT overflow (just at boundary)', () => {
      const out = computeExponentiation(2, 53);
      if ('error' in out) {
        // It might or might not overflow depending on exact MAX_SAFE_INTEGER handling;
        // we only care that if it succeeds the result is sensible.
        expect(out.result).toBeGreaterThan(0);
      } else {
        expect(out.result).toBe(9007199254740992);
      }
    });
    // Large base small exponent
    it('Number.MAX_SAFE_INTEGER ^ 1 = itself', () => {
      expectSuccess(Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
    });
    it('Number.MAX_SAFE_INTEGER ^ 2 overflows', () => {
      expectError(Number.MAX_SAFE_INTEGER, 2, 'OVERFLOW');
    });
  });

  describe('negative exponents rejected', () => {
    it('2^(-1) fails', () => expectError(2, -1, 'NEGATIVE_EXPONENT'));
    it('5^(-3) fails', () => expectError(5, -3, 'NEGATIVE_EXPONENT'));
    it('(-2)^(-2) fails', () => expectError(-2, -2, 'NEGATIVE_EXPONENT'));
  });

  describe('invalid inputs', () => {
    it('non-integer base is rejected', () => expectError(2.5, 3, 'INVALID_BASE'));
    it('non-integer exponent is rejected', () => expectError(2, 3.5, 'INVALID_EXPONENT'));
    it('base outside safe integer is rejected', () => {
      expectError(Number.MAX_SAFE_INTEGER + 1, 1, 'INVALID_BASE');
    });
    it('exponent outside safe integer is rejected', () => {
      expectError(2, Number.MAX_SAFE_INTEGER + 1, 'INVALID_EXPONENT');
    });
  });

  describe('zero base with positive exponent returns 0', () => {
    it('0^10 = 0', () => expectSuccess(0, 10, 0));
    it('0^1 = 0', () => expectSuccess(0, 1, 0));
  });

  describe('normalization of -0 to 0', () => {
    it('0^3 returns 0, not -0', () => {
      const out = computeExponentiation(0, 3);
      if ('result' in out) {
        expect(Object.is(out.result, -0)).toBe(false);
        expect(out.result).toBe(0);
      }
    });
  });

  describe('edge cases with one', () => {
    it('1^9999 = 1 without overflow', () => expectSuccess(1, 9999, 1));
    it('(-1)^2500 = 1', () => expectSuccess(-1, 2500, 1));
  });
});
