import { describe, it, expect } from "vitest";
import { multiply, capabilityDescription } from "./cap_basic_multiplication_6";

describe("cap_basic_multiplication_6", () => {
  describe("multiply", () => {
    it("multiplies two positive integers", () => {
      const out = multiply(3, 4);
      expect(out.result).toBe(12);
      expect(out.explanation).toContain("12");
    });

    it("multiplies a positive and a negative integer", () => {
      const out = multiply(3, -4);
      expect(out.result).toBe(-12);
      expect(out.explanation).toContain("-12");
    });

    it("multiplies two negative integers", () => {
      const out = multiply(-3, -4);
      expect(out.result).toBe(12);
    });

    it("multiplies by zero", () => {
      const out = multiply(7, 0);
      expect(out.result).toBe(0);
    });

    it("multiplies large integers within safe range", () => {
      const out = multiply(123456, 789012);
      expect(out.result).toBe(123456 * 789012);
    });

    it("throws on non-integer input", () => {
      expect(() => multiply(3.5, 4)).toThrow();
    });

    it("throws on non-finite input", () => {
      expect(() => multiply(Infinity, 4)).toThrow();
    });
  });

  describe("capabilityDescription", () => {
    it("contains the literal words purpose and domain", () => {
      expect(capabilityDescription.toLowerCase()).toContain("purpose");
      expect(capabilityDescription.toLowerCase()).toContain("domain");
    });
  });
});
