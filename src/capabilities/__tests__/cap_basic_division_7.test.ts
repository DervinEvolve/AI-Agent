import { safe_compute } from '../cap_basic_division_7.js';

describe('safe_compute (Euclidean division)', () => {
  test('basic positive division without remainder', () => {
    const result = safe_compute(10, 2);
    expect(result).toEqual({ quotient: 5, remainder: 0 });
  });

  test('positive division with remainder', () => {
    const result = safe_compute(10, 3);
    expect(result).toEqual({ quotient: 3, remainder: 1 });
  });

  test('dividend smaller than divisor (positive)', () => {
    const result = safe_compute(2, 5);
    expect(result).toEqual({ quotient: 0, remainder: 2 });
  });

  test('zero dividend', () => {
    const result = safe_compute(0, 5);
    expect(result).toEqual({ quotient: 0, remainder: 0 });
  });

  test('negative dividend, positive divisor', () => {
    const result = safe_compute(-10, 3);
    // Euclidean: quotient = floor(-10/3) = -4, remainder = 2
    expect(result).toEqual({ quotient: -4, remainder: 2 });
  });

  test('positive dividend, negative divisor', () => {
    const result = safe_compute(10, -3);
    // Euclidean: quotient = floor(10/(-3)) = -4, remainder = -2 + 3 = 1? Actually: rawQuotient = Math.trunc(10/-3) = -3, remainder = 10 - (-3)*(-3) = 10 - 9 = 1, remainder < 0? No. Result: quotient=-3, remainder=1? Check: -3 * -3 + 1 = 9+1=10. Euclidean remainder must be < |b|, so remainder 1 is fine, and quotient -3 works. So { quotient: -3, remainder: 1 }
    expect(result).toEqual({ quotient: -3, remainder: 1 });
  });

  test('both negative', () => {
    const result = safe_compute(-10, -3);
    // rawQuotient = Math.trunc(10/3) = 3, remainder = -10 - 3*(-3) = -10 + 9 = -1, negative => adjust: remainder += 3 => 2, quotient = 3 + 1 = 4
    expect(result).toEqual({ quotient: 4, remainder: 2 });
  });

  test('divisor is 1', () => {
    const result = safe_compute(42, 1);
    expect(result).toEqual({ quotient: 42, remainder: 0 });
  });

  test('divisor is -1', () => {
    const result = safe_compute(42, -1);
    expect(result).toEqual({ quotient: -42, remainder: 0 });
  });

  test('large safe integers', () => {
    const a = Number.MAX_SAFE_INTEGER - 1;
    const b = 2;
    const result = safe_compute(a, b);
    expect(result.quotient).toBe(a / 2); // MAX_SAFE_INTEGER - 1 is even, so division is exact.
    expect(result.remainder).toBe(0);
  });

  test('division by zero throws with clear message', () => {
    expect(() => safe_compute(5, 0)).toThrow('Division by zero is undefined. The divisor cannot be zero.');
  });

  test('non-integer dividend throws', () => {
    expect(() => safe_compute(3.5, 2)).toThrow('Both operands must be integers.');
  });

  test('non-integer divisor throws', () => {
    expect(() => safe_compute(3, 2.5)).toThrow('Both operands must be integers.');
  });

  test('non-finite operand (Infinity)', () => {
    expect(() => safe_compute(Infinity, 2)).toThrow('Both operands must be finite numbers.');
  });

  test('non-finite operand (NaN)', () => {
    expect(() => safe_compute(2, NaN)).toThrow('Both operands must be finite numbers.');
  });

  test('unsafe integer (too large) throws', () => {
    const huge = Number.MAX_SAFE_INTEGER + 1;
    expect(() => safe_compute(huge, 2)).toThrow(/Operands must be between/);
  });

  test('unsafe integer (too small) throws', () => {
    const tiny = Number.MIN_SAFE_INTEGER - 1;
    expect(() => safe_compute(1, tiny)).toThrow(/Operands must be between/);
  });

  test('exact division with negative numbers and zero remainder', () => {
    const result = safe_compute(-12, 4);
    // -12/4 = -3, remainder 0
    expect(result).toEqual({ quotient: -3, remainder: 0 });
  });

  test('edge case: dividend equals divisor (same signs)', () => {
    const result = safe_compute(7, 7);
    expect(result).toEqual({ quotient: 1, remainder: 0 });
  });

  test('edge case: dividend equals divisor (opposite signs)', () => {
    const result = safe_compute(-7, 7);
    expect(result).toEqual({ quotient: -1, remainder: 0 });
  });
});
