import { validateInteger, validateDivisor, SafeIntegerError } from '../constraints/constraints';

/**
 * Euclidean division result: a = b * quotient + remainder
 * where 0 ≤ remainder < |b|
 */
export interface DivisionResult {
  quotient: number;
  remainder: number;
}

/**
 * Perform Euclidean division of two finite integers within the safe integer range.
 * Division by zero is rejected with an educational explanation.
 *
 * @param dividend - The number to be divided (a)
 * @param divisor - The number to divide by (b), must not be zero
 * @returns The integer quotient and non-negative remainder
 * @throws {SafeIntegerError} If either operand is not a safe integer or divisor is zero
 */
export function divide(dividend: number, divisor: number): DivisionResult {
  // Validate operands — divisor check includes zero rejection with educational message
  validateInteger(dividend, 'dividend');
  validateInteger(divisor, 'divisor');
  validateDivisor(divisor);

  // Euclidean division: a = b * q + r, with 0 ≤ r < |b|
  // For negative dividends, Math.floor ensures quotient is rounded down,
  // giving a non-negative remainder.
  const quotient = Math.floor(dividend / divisor);
  const remainder = dividend - quotient * divisor;

  return { quotient, remainder };
}

/**
 * Format a division result into an educational explanation string.
 */
export function formatDivisionExplanation(
  dividend: number,
  divisor: number,
  result: DivisionResult
): string {
  return (
    `${dividend} ÷ ${divisor} = ${result.quotient} with remainder ${result.remainder}\n` +
    `Because ${divisor} × ${result.quotient} + ${result.remainder} = ${dividend}, ` +
    `and 0 ≤ ${result.remainder} < ${Math.abs(divisor)}.`
  );
}
