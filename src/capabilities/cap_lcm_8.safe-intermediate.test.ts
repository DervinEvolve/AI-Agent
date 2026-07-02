import { describe, expect, it } from "vitest";
import { computeLeastCommonMultiple, explainLeastCommonMultiple } from "./cap_lcm_8";

describe("cap_lcm_8 safe intermediate arithmetic", () => {
  it("accepts large operands whose raw product is unsafe but whose reduced LCM is safe", () => {
    const a = 4_000_000_000;
    const b = 6_000_000_000;

    expect(BigInt(a) * BigInt(b) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(computeLeastCommonMultiple(a, b)).toBe(12_000_000_000);

    const explanation = explainLeastCommonMultiple(a, b);
    expect(explanation).toMatchObject({
      operation: "least_common_multiple",
      operands: [a, b],
      gcdOfAbsoluteValues: 2_000_000_000,
      result: 12_000_000_000,
    });
    expect(explanation.steps.length).toBeGreaterThan(0);
  });

  it("rejects when the reduced exact LCM exceeds the safe integer range", () => {
    expect(() => computeLeastCommonMultiple(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError);
  });
});
