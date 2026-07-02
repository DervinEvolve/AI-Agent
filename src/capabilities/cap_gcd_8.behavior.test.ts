import { describe, expect, it } from "vitest";

import { computeGreatestCommonDivisor } from "./cap_gcd_8";

describe("computeGreatestCommonDivisor behavior", () => {
  it("uses the Euclidean algorithm to compute a non-negative gcd across signs and operand order", () => {
    expect(computeGreatestCommonDivisor(1071, 462)).toBe(21);
    expect(computeGreatestCommonDivisor(462, 1071)).toBe(21);
    expect(computeGreatestCommonDivisor(-1071, 462)).toBe(21);
    expect(computeGreatestCommonDivisor(1071, -462)).toBe(21);
    expect(computeGreatestCommonDivisor(-1071, -462)).toBe(21);
  });

  it("supports exactly one zero operand by returning the absolute value of the other operand", () => {
    expect(computeGreatestCommonDivisor(0, -84)).toBe(84);
    expect(computeGreatestCommonDivisor(84, 0)).toBe(84);
  });

  it("rejects inputs outside the capability scope", () => {
    expect(() => computeGreatestCommonDivisor(0, 0)).toThrow(RangeError);
    expect(() => computeGreatestCommonDivisor(12)).toThrow(TypeError);
    expect(() => computeGreatestCommonDivisor(12, 18, 24)).toThrow(TypeError);
    expect(() => computeGreatestCommonDivisor(12.5, 5)).toThrow(TypeError);
    expect(() => computeGreatestCommonDivisor(Number.MAX_SAFE_INTEGER + 1, 1)).toThrow(TypeError);
  });
});
