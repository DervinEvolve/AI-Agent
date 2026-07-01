export class SafeIntegerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeIntegerError';
  }
}

/**
 * Validate that a value is a finite integer within the safe integer range.
 */
export function validateInteger(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new SafeIntegerError(
      `${label} must be a finite number, received ${value}. ` +
        `Integers are whole numbers like ..., -2, -1, 0, 1, 2, ...`
    );
  }
  if (!Number.isInteger(value)) {
    throw new SafeIntegerError(
      `${label} must be an integer (whole number), received ${value}. ` +
        `For division, we work with whole numbers and return a quotient and remainder.`
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new SafeIntegerError(
      `${label} ${value} is outside the safe integer range (±${Number.MAX_SAFE_INTEGER}). ` +
        `Please use numbers between -9,007,199,254,740,991 and 9,007,199,254,740,991.`
    );
  }
}

/**
 * Validate that a divisor is non-zero, providing an educational explanation
 * for why division by zero is undefined.
 */
export function validateDivisor(divisor: number): void {
  if (divisor === 0) {
    throw new SafeIntegerError(
      `Division by zero is undefined. ` +
        `If we try to compute a ÷ 0, we would need a number q such that 0 × q = a. ` +
        `But 0 × q is always 0, so there is no solution when a ≠ 0, and infinitely many ` +
        `solutions when a = 0. Mathematicians therefore leave division by zero undefined ` +
        `to keep arithmetic consistent. Try dividing by a non-zero integer instead!`
    );
  }
}
