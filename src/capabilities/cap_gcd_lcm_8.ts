import { describeCapability } from "../identity/identity";

/**
 * Capability: greatest common divisor (GCD) and least common multiple (LCM)
 * of exactly two finite integers.
 *
 * These two related operations extend the agent's currently supported basic
 * arithmetic capabilities. Both accept exactly two finite integers and return
 * a numeric answer followed by an educational explanation. Negatives are
 * normalized to their absolute values before computation.
 */

export interface GcdLcmResult {
  /** The numeric answer. */
  result: number;
  /** A human-readable explanation of the computation. */
  explanation: string;
}

/**
 * Compute the greatest common divisor of two finite integers using the
 * Euclidean algorithm.
 *
 * Conventions used here:
 *  - gcd(a, b) = gcd(|a|, |b|); negatives are normalized via absolute values.
 *  - gcd(0, n) = |n| for any integer n.
 *  - gcd(0, 0) is mathematically undefined; by convention we return 0 and
 *    note the undefined nature in the explanation.
 *
 * @param a - The first finite integer operand.
 * @param b - The second finite integer operand.
 * @returns An object containing the GCD and an explanation.
 * @throws {Error} If either argument is not a finite integer.
 */
export function gcd(a: number, b: number): GcdLcmResult {
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    throw new Error("gcd requires exactly two finite integer operands");
  }
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error("gcd requires exactly two finite integer operands");
  }

  const absA = Math.abs(a);
  const absB = Math.abs(b);

  // Euclidean algorithm on absolute values.
  let x = absA;
  let y = absB;
  while (y !== 0) {
    const r = x % y;
    x = y;
    y = r;
  }
  const result = x;

  let explanation: string;
  if (absA === 0 && absB === 0) {
    explanation =
      "gcd(0, 0) is mathematically undefined because every integer divides " +
      "0. By convention, gcd(0, 0) = 0 is returned here.";
  } else {
    explanation =
      `The greatest common divisor of ${a} and ${b} is ${result}, found using ` +
      `the Euclidean algorithm on their absolute values (${absA} and ${absB}). ` +
      `This is the largest positive integer that divides both inputs exactly.`;
  }

  return { result, explanation };
}

/**
 * Compute the least common multiple of two finite integers using the
 * identity lcm(a, b) = |a * b| / gcd(a, b).
 *
 * Conventions used here:
 *  - lcm(a, b) = lcm(|a|, |b|); negatives are normalized via absolute values.
 *  - If either operand is 0, lcm(a, b) = 0 by standard convention (since 0 is
 *    the only common multiple of an integer and zero).
 *
 * @param a - The first finite integer operand.
 * @param b - The second finite integer operand.
 * @returns An object containing the LCM and an explanation.
 * @throws {Error} If either argument is not a finite integer.
 */
export function lcm(a: number, b: number): GcdLcmResult {
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    throw new Error("lcm requires exactly two finite integer operands");
  }
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error("lcm requires exactly two finite integer operands");
  }

  const absA = Math.abs(a);
  const absB = Math.abs(b);

  // Zero operand => lcm is 0 by convention.
  if (absA === 0 || absB === 0) {
    return {
      result: 0,
      explanation:
        `The least common multiple of ${a} and ${b} is 0, since any integer ` +
        `that has 0 as a factor has 0 as its only common multiple.`,
    };
  }

  // gcd via Euclidean algorithm.
  let x = absA;
  let y = absB;
  while (y !== 0) {
    const r = x % y;
    x = y;
    y = r;
  }
  const gcdValue = x;

  // lcm(a, b) = |a * b| / gcd(a, b). Divide first to keep the intermediate
  // value smaller and reduce the risk of precision loss for large inputs.
  const result = (absA / gcdValue) * absB;

  const explanation =
    `The least common multiple of ${a} and ${b} is ${result}, computed from ` +
    `the identity lcm(a, b) = |a * b| / gcd(a, b). With gcd(${absA}, ${absB}) ` +
    `= ${gcdValue}, we get (${absA} / ${gcdValue}) * ${absB} = ${result}. ` +
    `This is the smallest positive integer divisible by both inputs.`;

  return { result, explanation };
}

/**
 * Self-description fragment for the GCD/LCM capability.
 *
 * The purpose of this capability is to compute greatest common divisors and
 * least common multiples of two integers. The domain is basic two-integer
 * arithmetic education.
 */
export const capabilityDescription =
  "Capability: greatest common divisor (gcd) and least common multiple (lcm). " +
  "Purpose: compute the gcd and lcm of exactly two finite integers, including " +
  "negatives, zero, and large numbers. Domain: basic two-integer arithmetic " +
  "education.";

describeCapability(capabilityDescription);
