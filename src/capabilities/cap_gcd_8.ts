export const capGcd8Capability = {
  id: "cap_gcd_8",
  scope:
    "greatest common divisor of exactly two finite integers; no floating-point inputs, no chained operations, no lists of more than two integers, no operands exceeding safe integer range (±(2^53 - 1)). Returns a non-negative integer GCD. GCD(0, n) and GCD(n, 0) are supported for nonzero n and return |n|. GCD(0, 0) is rejected as undefined for this educational agent.",
  status: "active",
  added_epoch: 8,
  description:
    "Compute the greatest common divisor of two finite integers to assist users with basic educational divisibility and number-relation queries.",
} as const;

export const capability = capGcd8Capability;
export const cap_gcd_8 = capGcd8Capability;

function assertExactlyTwoOperands(operands: readonly unknown[]): asserts operands is readonly [unknown, unknown] {
  if (operands.length !== 2) {
    throw new TypeError("GCD requires exactly two operands.");
  }
}

function assertSafeIntegerOperand(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a finite safe integer Number.`);
  }
}

/**
 * Computes the greatest common divisor of exactly two finite, safe JavaScript integers.
 *
 * The result is always non-negative. Zero is accepted with a nonzero counterpart
 * (gcd(0, n) = |n|), while gcd(0, 0) is rejected as undefined for this capability.
 */
export function computeGreatestCommonDivisor(...operands: unknown[]): number {
  assertExactlyTwoOperands(operands);

  const [left, right] = operands;
  assertSafeIntegerOperand(left, "First operand");
  assertSafeIntegerOperand(right, "Second operand");

  if (left === 0 && right === 0) {
    throw new RangeError("GCD(0, 0) is undefined.");
  }

  let a = Math.abs(left);
  let b = Math.abs(right);

  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }

  return a;
}

export const gcd = computeGreatestCommonDivisor;
export const computeGcd = computeGreatestCommonDivisor;
export const calculateGcd = computeGreatestCommonDivisor;
export const greatestCommonDivisor = computeGreatestCommonDivisor;
export const calculateGreatestCommonDivisor = computeGreatestCommonDivisor;
export const execute = computeGreatestCommonDivisor;

export default {
  ...capGcd8Capability,
  compute: computeGreatestCommonDivisor,
  execute: computeGreatestCommonDivisor,
  gcd: computeGreatestCommonDivisor,
};
