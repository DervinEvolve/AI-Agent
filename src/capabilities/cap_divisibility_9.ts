// cap_divisibility_9
//
// Divisibility check for exactly two finite integers within the safe integer
// range (±(2^53 - 1)). Given a and b, determine whether b divides a evenly.
//
// Reuses the safe non-negative-remainder integer-division logic: compute the
// non-negative remainder r; b divides a iff r === 0. A zero divisor is rejected
// with an educational explanation (nothing is divisible by zero).
//
// This is an educational assistant, not a general-purpose calculator.

export interface DivisibilityResult {
  ok: boolean;
  a?: number;
  b?: number;
  divisible?: boolean;
  // Non-negative remainder (mathematical modulo) of a by b.
  remainder?: number;
  // Exact integer quotient when divisible (a === b * quotient); undefined otherwise.
  quotient?: number;
  message: string;
  error?: string;
}

const SAFE_MAX = Number.MAX_SAFE_INTEGER; // 2^53 - 1

function isValidInteger(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n);
}

/**
 * Non-negative remainder (mathematical modulo). JS `%` is a truncated remainder
 * whose sign follows the dividend, so `((a % b) + b) % b` normalizes it to the
 * range [0, |b|) using |b| for the modulus.
 */
function nonNegativeRemainder(a: number, b: number): number {
  const m = Math.abs(b);
  return ((a % m) + m) % m;
}

/**
 * Determine whether integer b evenly divides integer a.
 */
export function isDivisible(a: number, b: number): DivisibilityResult {
  if (!isValidInteger(a) || !isValidInteger(b)) {
    return {
      ok: false,
      message:
        'I can only check divisibility for finite integers within the safe integer range (±(2^53 - 1)).',
      error: 'INVALID_INPUT',
    };
  }

  if (Math.abs(a) > SAFE_MAX || Math.abs(b) > SAFE_MAX) {
    return {
      ok: false,
      message:
        'I can only check divisibility for integers within the safe integer range (±(2^53 - 1)).',
      error: 'OUT_OF_RANGE',
    };
  }

  if (b === 0) {
    return {
      ok: false,
      a,
      b,
      message:
        'Division by zero is undefined: nothing is divisible by zero, so I cannot check divisibility by 0.',
      error: 'DIVIDE_BY_ZERO',
    };
  }

  const remainder = nonNegativeRemainder(a, b);
  const divisible = remainder === 0;

  if (divisible) {
    // Exact integer quotient. Since remainder is 0, a is an exact multiple of b,
    // and a / b is an exact integer (no float rounding for safe integers here).
    const quotient = a / b;
    return {
      ok: true,
      a,
      b,
      divisible: true,
      remainder: 0,
      quotient,
      message: `${a} is divisible by ${b} because ${a} = ${b} × ${quotient}.`,
    };
  }

  return {
    ok: true,
    a,
    b,
    divisible: false,
    remainder,
    message: `${a} is not divisible by ${b} (remainder ${remainder}).`,
  };
}

export default isDivisible;
