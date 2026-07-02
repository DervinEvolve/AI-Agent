// cap_primality_9: single-integer primality determination.
//
// Scope: decide whether exactly one finite integer n within the safe integer
// range (±(2^53 - 1)) is prime, composite, or neither. To keep computation
// practical and bounded, primality is decided by deterministic trial division
// only up to a hard cap: if |n| exceeds 10,000,000 (10^7) the request is
// rejected as out of scope rather than running an impractical loop.
//
// Classification rules:
//   - Integers < 2 (i.e. 0, 1, and all negatives) are "not prime" (neither
//     prime nor composite for the purposes of this educational agent).
//   - 2 and 3 are prime.
//   - Any n >= 4 with a divisor d (2 <= d <= floor(sqrt(n))) is composite.
//   - Otherwise n is prime.

export const PRIMALITY_CAP = 10_000_000; // 10^7

export type Primality = 'prime' | 'composite' | 'not prime';

export interface PrimalityResult {
  n: number;
  primality: Primality;
  isPrime: boolean;
  explanation: string;
}

function validateInteger(n: number): void {
  if (typeof n !== 'number' || Number.isNaN(n)) {
    throw new Error('primality: input must be a number');
  }
  if (!Number.isFinite(n)) {
    throw new Error('primality: input must be a finite number');
  }
  if (!Number.isInteger(n)) {
    throw new Error('primality: input must be an integer (no floating-point values)');
  }
  if (!Number.isSafeInteger(n)) {
    throw new Error(
      'primality: input must be within the safe integer range (±(2^53 - 1))',
    );
  }
}

/**
 * Determine whether a single finite integer n is prime, composite, or neither.
 *
 * Uses deterministic trial division (odd-only) up to floor(sqrt(n)). Rejects
 * non-integers, non-finite values, values outside the safe integer range, and
 * values whose absolute magnitude exceeds the hard practical cap of 10^7.
 */
export function isPrime(n: number): PrimalityResult {
  validateInteger(n);

  // Honor the "no impractical loop" intent: validate the cap BEFORE any looping.
  if (Math.abs(n) > PRIMALITY_CAP) {
    throw new Error(
      `primality: |n| exceeds the supported cap of ${PRIMALITY_CAP} (10^7); ` +
        'primality testing of very large integers is beyond this educational agent',
    );
  }

  // Integers below 2 are neither prime nor composite here.
  if (n < 2) {
    return {
      n,
      primality: 'not prime',
      isPrime: false,
      explanation:
        `${n} is not prime: primes are defined only for integers >= 2, ` +
        'so 0, 1, and negative integers are classified as "not prime".',
    };
  }

  // 2 and 3 are prime (short-circuit before the loop).
  if (n === 2 || n === 3) {
    return {
      n,
      primality: 'prime',
      isPrime: true,
      explanation: `${n} is prime: it has no positive divisors other than 1 and itself.`,
    };
  }

  // Quick even/multiple-of-3 rejection.
  if (n % 2 === 0) {
    return {
      n,
      primality: 'composite',
      isPrime: false,
      explanation: `${n} is composite: it is divisible by 2.`,
    };
  }
  if (n % 3 === 0) {
    return {
      n,
      primality: 'composite',
      isPrime: false,
      explanation: `${n} is composite: it is divisible by 3.`,
    };
  }

  // Trial division by odd candidates only. Use i*i <= n to avoid float
  // rounding at perfect-square boundaries (safe since n <= 10^7).
  for (let i = 5; i * i <= n; i += 2) {
    if (n % i === 0) {
      return {
        n,
        primality: 'composite',
        isPrime: false,
        explanation: `${n} is composite: it is divisible by ${i}.`,
      };
    }
  }

  return {
    n,
    primality: 'prime',
    isPrime: true,
    explanation: `${n} is prime: it has no positive divisors other than 1 and itself.`,
  };
}
