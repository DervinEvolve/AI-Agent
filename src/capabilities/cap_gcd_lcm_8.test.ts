import { describe, it, expect } from "vitest";
import { gcd, lcm, capabilityDescription } from "./cap_gcd_lcm_8";

describe("cap_gcd_lcm_8", () => {
  describe("gcd", () => {
    it("computes gcd of two coprime positive integers", () => {
      const out = gcd(8, 15);
      expect(out.result).toBe(1);
      expect(out.explanation).toContain("1");
    });

    it("computes gcd of two non-coprime positive integers", () => {
      const out = gcd(54, 24);
      expect(out.result).toBe(6);
      expect(out.explanation).toContain("6");
    });

    it("normalizes negatives via absolute values", () => {
      expect(gcd(-54, -24).result).toBe(6);
      expect(gcd(-54, 24).result).toBe(6);
      expect(gcd(54, -24).result).toBe(6);
    });

    it("returns the absolute value when one operand is zero", () => {
      expect(gcd(0, 7).result).toBe(7);
      expect(gcd(7, 0).result).toBe(7);
      expect(gcd(0, -7).result).toBe(7);
    });

    it("returns 0 by convention for gcd(0, 0) and notes it is undefined", () => {
      const out = gcd(0, 0);
      expect(out.result).toBe(0);
      expect(out.explanation.toLowerCase()).toContain("undefined");
    });

    it("handles large integers within safe range", () => {
      const out = gcd(123456789, 987654321);
      expect(out.result).toBe(9);
    });

    it("throws on non-integer input", () => {
      expect(() => gcd(3.5, 4)).toThrow();
    });

    it("throws on non-finite input", () => {
      expect(() => gcd(Infinity, 4)).toThrow();
    });
  });

  describe("lcm", () => {
    it("computes lcm of two positive integers", () => {
      const out = lcm(4, 6);
      expect(out.result).toBe(12);
      expect(out.explanation).toContain("12");
    });

    it("computes lcm of two coprime integers", () => {
      expect(lcm(7, 11).result).toBe(77);
    });

    it("normalizes negatives via absolute values", () => {
      expect(lcm(-4, 6).result).toBe(12);
      expect(lcm(4, -6).result).toBe(12);
      expect(lcm(-4, -6).result).toBe(12);
    });

    it("returns 0 when either operand is zero", () => {
      expect(lcm(0, 5).result).toBe(0);
      expect(lcm(5, 0).result).toBe(0);
      expect(lcm(0, 0).result).toBe(0);
    });

    it("handles large integers within safe range", () => {
      const out = lcm(123456, 789012);
      // lcm = (a / gcd(a,b)) * b
      const g = gcdInner(123456, 789012);
      expect(out.result).toBe((123456 / g) * 789012);
    });

    it("throws on non-integer input", () => {
      expect(() => lcm(2.5, 4)).toThrow();
    });

    it("throws on non-finite input", () => {
      expect(() => lcm(NaN, 4)).toThrow();
    });
  });

  describe("capabilityDescription", () => {
    it("contains the literal words purpose and domain", () => {
      expect(capabilityDescription.toLowerCase()).toContain("purpose");
      expect(capabilityDescription.toLowerCase()).toContain("domain");
    });
  });
});

// Local Euclidean helper to keep the lcm large-number test independent of the
// exported gcd's explanation wording while still validating the value.
function gcdInner(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const r = x % y;
    x = y;
    y = r;
  }
  return x;
}
