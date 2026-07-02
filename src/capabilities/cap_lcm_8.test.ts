import { describe, expect, it } from "vitest";
import {
  cap_lcm_8,
  computeLeastCommonMultiple,
  explainLeastCommonMultiple,
  leastCommonMultiple,
  lcm,
} from "./cap_lcm_8";

describe("cap_lcm_8", () => {
  it("declares the active least-common-multiple capability metadata", () => {
    expect(cap_lcm_8).toMatchObject({
      id: "cap_lcm_8",
      status: "active",
      added_epoch: 8,
    });
    expect(cap_lcm_8.description).toContain("least common multiple");
  });

  it("computes the LCM of exactly two finite integers", () => {
    expect(computeLeastCommonMultiple(12, 18)).toBe(36);
    expect(computeLeastCommonMultiple(21, 6)).toBe(42);
    expect(leastCommonMultiple(8, 9)).toBe(72);
    expect(lcm(7, 7)).toBe(7);
  });

  it("returns a non-negative LCM for negative operands", () => {
    expect(computeLeastCommonMultiple(-12, 18)).toBe(36);
    expect(computeLeastCommonMultiple(12, -18)).toBe(36);
    expect(computeLeastCommonMultiple(-12, -18)).toBe(36);
  });

  it("supports zero with one nonzero operand", () => {
    expect(computeLeastCommonMultiple(0, 5)).toBe(0);
    expect(computeLeastCommonMultiple(-7, 0)).toBe(0);
  });

  it("rejects LCM(0, 0) as undefined", () => {
    expect(() => computeLeastCommonMultiple(0, 0)).toThrow(RangeError);
  });

  it("rejects non-integers, NaN, infinity, and unsafe integer inputs", () => {
    expect(() => computeLeastCommonMultiple(1.5, 2)).toThrow(TypeError);
    expect(() => computeLeastCommonMultiple(2, Number.NaN)).toThrow(TypeError);
    expect(() => computeLeastCommonMultiple(Number.POSITIVE_INFINITY, 2)).toThrow(TypeError);
    expect(() => computeLeastCommonMultiple(Number.MAX_SAFE_INTEGER + 1, 1)).toThrow(RangeError);
    expect(() => computeLeastCommonMultiple(-(Number.MAX_SAFE_INTEGER + 1), 1)).toThrow(RangeError);
  });

  it("allows a result exactly equal to Number.MAX_SAFE_INTEGER", () => {
    expect(computeLeastCommonMultiple(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(computeLeastCommonMultiple(-Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects safe inputs whose LCM would exceed the safe integer range", () => {
    expect(() => computeLeastCommonMultiple(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1)).toThrow(RangeError);
  });

  it("returns educational computation details", () => {
    expect(explainLeastCommonMultiple(12, 18)).toEqual({
      operation: "least_common_multiple",
      operands: [12, 18],
      gcdOfAbsoluteValues: 6,
      result: 36,
      steps: [
        "Use absolute values: |12| = 12 and |18| = 18.",
        "Compute gcd(12, 18) = 6.",
        "Compute (|a| / gcd) × |b| = (12 / 6) × 18 = 36.",
      ],
    });
  });
});
