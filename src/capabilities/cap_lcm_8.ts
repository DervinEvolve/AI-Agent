export const cap_lcm_8 = {
  id: "cap_lcm_8",
  scope:
    "least common multiple of exactly two finite integers; no floating-point inputs, no chained operations, no lists of more than two integers, no operands exceeding safe integer range (±(2^53 - 1)), and no LCM result exceeding safe integer range (±(2^53 - 1)). Returns a non-negative integer LCM. LCM(0, n) and LCM(n, 0) are supported for nonzero n and return 0. LCM(0, 0) is rejected as undefined for this educational agent. The implementation must avoid unsafe intermediate multiplication when checking or computing the result.",
  status: "active",
  added_epoch: 8,
  description:
    "Compute the least common multiple of two finite integers to assist users with basic educational divisibility and number-relation queries, provided the exact result remains within the safe integer range.",
} as const;

export const capability = cap_lcm_8;

export interface LeastCommonMultipleExplanation {
  operation: "least_common_multiple";
  operands: readonly [number, number];
  gcdOfAbsoluteValues: number;
  result: number;
  steps: readonly string[];
}

const SAFE_INTEGER_LIMIT = Number.MAX_SAFE_INTEGER;

function assertFiniteSafeInteger(value: number, name: string): void {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }

  if (!Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer; floating-point operands are not supported.`);
  }

  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `${name} must be within the JavaScript safe integer range ±${SAFE_INTEGER_LIMIT}.`,
    );
  }
}

function greatestCommonDivisorOfNonNegativeIntegers(a: number, b: number): number {
  let x = a;
  let y = b;

  while (y !== 0) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }

  return x;
}

export function computeLeastCommonMultiple(a: number, b: number): number {
  assertFiniteSafeInteger(a, "a");
  assertFiniteSafeInteger(b, "b");

  const absA = Math.abs(a);
  const absB = Math.abs(b);

  if (absA === 0 && absB === 0) {
    throw new RangeError("LCM(0, 0) is undefined for this educational capability.");
  }

  if (absA === 0 || absB === 0) {
    return 0;
  }

  const gcd = greatestCommonDivisorOfNonNegativeIntegers(absA, absB);
  const reducedA = absA / gcd;

  if (reducedA > SAFE_INTEGER_LIMIT / absB) {
    throw new RangeError(
      `The least common multiple exceeds the JavaScript safe integer range ±${SAFE_INTEGER_LIMIT}.`,
    );
  }

  const result = reducedA * absB;

  if (!Number.isSafeInteger(result)) {
    throw new RangeError(
      `The least common multiple exceeds the JavaScript safe integer range ±${SAFE_INTEGER_LIMIT}.`,
    );
  }

  return result;
}

export const leastCommonMultiple = computeLeastCommonMultiple;
export const lcm = computeLeastCommonMultiple;

export function explainLeastCommonMultiple(a: number, b: number): LeastCommonMultipleExplanation {
  const result = computeLeastCommonMultiple(a, b);
  const absA = Math.abs(a);
  const absB = Math.abs(b);
  const gcd = absA === 0 || absB === 0 ? Math.max(absA, absB) : greatestCommonDivisorOfNonNegativeIntegers(absA, absB);

  const steps =
    result === 0
      ? [
          `Use absolute values: |${a}| = ${absA} and |${b}| = ${absB}.`,
          "One operand is zero and the other is nonzero, so the supported extension gives LCM(0, n) = 0.",
        ]
      : [
          `Use absolute values: |${a}| = ${absA} and |${b}| = ${absB}.`,
          `Compute gcd(${absA}, ${absB}) = ${gcd}.`,
          `Compute (|a| / gcd) × |b| = (${absA} / ${gcd}) × ${absB} = ${result}.`,
        ];

  return {
    operation: "least_common_multiple",
    operands: [a, b],
    gcdOfAbsoluteValues: gcd,
    result,
    steps,
  };
}

export default cap_lcm_8;
