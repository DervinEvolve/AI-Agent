import { describe, expect, it } from "vitest";

import gcdCapability, {
  capGcd8Capability,
  computeGreatestCommonDivisor,
  gcd,
  greatestCommonDivisor,
} from "./cap_gcd_8";

describe("cap_gcd_8", () => {
  it("declares the active GCD capability metadata", () => {
    expect(capGcd8Capability).toMatchObject({
      id: "cap_gcd_8",
      status: "active",
      added_epoch: 8,
      description:
        "Compute the greatest common divisor of two finite integers to assist users with basic educational divisibility and number-relation queries.",
    });
    expect(capGcd8Capability.scope).toContain("exactly two finite integers");
    expect(capGcd8Capability.scope).toContain("GCD(0, 0) is rejected");
    expect(gcdCapability.id).toBe("cap_gcd_8");
    expect(gcdCapability.compute(-18, 24)).toBe(6);
  });

  it("computes non-negative greatest common divisors for two safe integers", () => {
    expect(computeGreatestCommonDivisor(54, 24)).toBe(6);
    expect(computeGreatestCommonDivisor(-18, 24)).toBe(6);
    expect(computeGreatestCommonDivisor(18, -24)).toBe(6);
    expect(computeGreatestCommonDivisor(-18, -24)).toBe(6);
    expect(computeGreatestCommonDivisor(17, 31)).toBe(1);
