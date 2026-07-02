import { isPrime, PRIMALITY_CAP } from './cap_primality_9';

describe('cap_primality_9: primality determination', () => {
  describe('classification of small integers', () => {
    it('classifies 2 and 3 as prime (short-circuit before loop)', () => {
      expect(isPrime(2).primality).toBe('prime');
      expect(isPrime(2).isPrime).toBe(true);
      expect(isPrime(3).primality).toBe('prime');
      expect(isPrime(3).isPrime).toBe(true);
    });

    it('classifies 0, 1, and negatives as "not prime"', () => {
      for (const n of [0, 1, -1, -2, -7, -100]) {
        const r = isPrime(n);
        expect(r.primality).toBe('not prime');
        expect(r.isPrime).toBe(false);
        expect(r.explanation).toMatch(/integers >= 2/);
      }
    });
  });

  describe('primes', () => {
    const primes = [5, 7, 11, 13, 17, 19, 23, 29, 31, 97, 101, 7919, 104729];
    it.each(primes)('recognizes %i as prime', (p) => {
      const r = isPrime(p);
      expect(r.primality).toBe('prime');
      expect(r.isPrime).toBe(true);
    });
  });

  describe('composites', () => {
    const composites = [4, 6, 8, 9, 15, 21, 25, 27, 49, 100, 1000, 999983 * 2];
    it.each(composites)('recognizes %i as composite', (c) => {
      const r = isPrime(c);
      expect(r.primality).toBe('composite');
      expect(r.isPrime).toBe(false);
    });
  });

  describe('perfect-square boundaries (i*i <= n correctness)', () => {
    it('classifies perfect squares of primes as composite', () => {
      expect(isPrime(25).primality).toBe('composite');
      expect(isPrime(49).primality).toBe('composite');
      expect(isPrime(121).primality).toBe('composite');
      expect(isPrime(169).primality).toBe('composite');
    });
  });

  describe('cap enforcement', () => {
    it('accepts n exactly at the cap', () => {
      expect(() => isPrime(PRIMALITY_CAP)).not.toThrow();
      // 10^7 is even -> composite
      expect(isPrime(PRIMALITY_CAP).primality).toBe('composite');
    });

    it('rejects |n| just above the cap before looping', () => {
      expect(() => isPrime(PRIMALITY_CAP + 1)).toThrow(/cap/);
      expect(() => isPrime(-(PRIMALITY_CAP + 1))).toThrow(/cap/);
    });

    it('exposes the cap constant as 10^7', () => {
      expect(PRIMALITY_CAP).toBe(10_000_000);
    });
  });

  describe('input validation', () => {
    it('rejects non-integer / floating-point inputs', () => {
      expect(() => isPrime(3.5)).toThrow(/integer/);
      expect(() => isPrime(2.0001)).toThrow(/integer/);
    });

    it('rejects NaN and Infinity', () => {
      expect(() => isPrime(NaN)).toThrow();
      expect(() => isPrime(Infinity)).toThrow(/finite/);
      expect(() => isPrime(-Infinity)).toThrow(/finite/);
    });

    it('rejects non-number inputs', () => {
      // @ts-expect-error deliberately wrong type
      expect(() => isPrime('7')).toThrow();
      // @ts-expect-error deliberately wrong type
      expect(() => isPrime(null)).toThrow();
    });

    it('rejects unsafe integers (beyond safe range they also exceed the cap)', () => {
      expect(() => isPrime(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    });
  });

  describe('result shape', () => {
    it('returns n, primality, isPrime, and an explanation', () => {
      const r = isPrime(7);
      expect(r.n).toBe(7);
      expect(r.primality).toBe('prime');
      expect(r.isPrime).toBe(true);
      expect(typeof r.explanation).toBe('string');
      expect(r.explanation.length).toBeGreaterThan(0);
    });
  });
});
