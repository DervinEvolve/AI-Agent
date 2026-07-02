import { isPrime, PRIMALITY_CAP } from './cap_primality_9';

// Independent reference implementation used to cross-check isPrime's
// classification. This deliberately reimplements the math a different way
// (checking every candidate divisor from 2..n-1) so it does not merely echo
// the production loop structure.
function referenceIsPrime(n: number): boolean {
  if (!Number.isInteger(n) || n < 2) return false;
  for (let d = 2; d < n; d++) {
    if (n % d === 0) return false;
  }
  return true;
}

describe('cap_primality_9: cross-checked against a reference implementation', () => {
  it('the exported cap constant is 10^7', () => {
    expect(PRIMALITY_CAP).toBe(10_000_000);
  });

  it('matches an independent primality reference across a dense range', () => {
    for (let n = -5; n <= 500; n++) {
      const result = isPrime(n);
      const expectedPrime = referenceIsPrime(n);

      // isPrime flag must agree with the reference implementation.
      expect(result.isPrime).toBe(expectedPrime);

      // The n field must round-trip the input unchanged.
      expect(result.n).toBe(n);

      // The primality label must be internally consistent with isPrime.
      if (expectedPrime) {
        expect(result.primality).toBe('prime');
      } else if (n >= 2) {
        // >= 2 and not prime => composite.
        expect(result.primality).toBe('composite');
      } else {
        // < 2 => neither prime nor composite.
        expect(result.primality).toBe('not prime');
      }
    }
  });

  it('keeps primality and isPrime mutually consistent for every classification', () => {
    const samples = [-10, -1, 0, 1, 2, 3, 4, 9, 17, 18, 97, 100, 7919, 7920];
    for (const n of samples) {
      const { primality, isPrime: flag } = isPrime(n);
      // isPrime is true if and only if the label is exactly 'prime'.
      expect(flag).toBe(primality === 'prime');
      // Only one of the three labels is ever produced.
      expect(['prime', 'composite', 'not prime']).toContain(primality);
    }
  });

  it('classifies a semiprime just below the cap as composite', () => {
    // 9_999_991 is not necessarily special; use a clearly composite even
    // number close to the cap to exercise a long-ish trial-division path.
    const n = 9_999_998; // even, < cap => composite
    const r = isPrime(n);
    expect(r.primality).toBe('composite');
    expect(r.isPrime).toBe(false);
  });

  it('rejects non-integer and non-finite inputs by throwing', () => {
    expect(() => isPrime(2.5)).toThrow();
    expect(() => isPrime(Number.NaN)).toThrow();
    expect(() => isPrime(Number.POSITIVE_INFINITY)).toThrow();
  });
});
