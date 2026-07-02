import { describe, it, expect } from "vitest";
import {
  widenedIdentity,
  isSafeIntegerInScope,
  SAFE_INTEGER_LIMIT,
} from "./identity-widened";

describe("widenedIdentity", () => {
  it("declares the bounded number-relation domain", () => {
    expect(widenedIdentity.domain).toContain(
      "single-integer number-property queries"
    );
    expect(widenedIdentity.domain).toContain(
      "bounded elementary integer arithmetic"
    );
  });

  it("retains the safe-integer bound in the purpose", () => {
    expect(widenedIdentity.purpose).toContain("2^53 - 1");
    expect(widenedIdentity.purpose).toContain("safe integer range");
  });

  it("retains the educational, non-general-calculator framing", () => {
    expect(widenedIdentity.purpose).toContain("educational assistant");
    expect(widenedIdentity.purpose).toContain(
      "unbounded number-theory engine"
    );
  });

  it("mentions single-integer divisibility/primality analysis", () => {
    expect(widenedIdentity.purpose).toContain(
      "single-integer divisibility/primality analysis"
    );
  });
});

describe("SAFE_INTEGER_LIMIT", () => {
  it("equals Number.MAX_SAFE_INTEGER (2^53 - 1)", () => {
    expect(SAFE_INTEGER_LIMIT).toBe(9007199254740991);
    expect(SAFE_INTEGER_LIMIT).toBe(Math.pow(2, 53) - 1);
  });
});

describe("isSafeIntegerInScope", () => {
  it("accepts finite integers inside the safe range", () => {
    expect(isSafeIntegerInScope(0)).toBe(true);
    expect(isSafeIntegerInScope(1)).toBe(true);
    expect(isSafeIntegerInScope(-1)).toBe(true);
    expect(isSafeIntegerInScope(42)).toBe(true);
    expect(isSafeIntegerInScope(SAFE_INTEGER_LIMIT)).toBe(true);
    expect(isSafeIntegerInScope(-SAFE_INTEGER_LIMIT)).toBe(true);
  });

  it("rejects values outside the safe range", () => {
    expect(isSafeIntegerInScope(SAFE_INTEGER_LIMIT + 1)).toBe(false);
    expect(isSafeIntegerInScope(-SAFE_INTEGER_LIMIT - 1)).toBe(false);
    expect(isSafeIntegerInScope(2 ** 53)).toBe(false);
  });

  it("rejects non-integers and non-numbers", () => {
    expect(isSafeIntegerInScope(1.5)).toBe(false);
    expect(isSafeIntegerInScope(NaN)).toBe(false);
    expect(isSafeIntegerInScope(Infinity)).toBe(false);
    expect(isSafeIntegerInScope(-Infinity)).toBe(false);
    expect(isSafeIntegerInScope("7")).toBe(false);
    expect(isSafeIntegerInScope(null)).toBe(false);
    expect(isSafeIntegerInScope(undefined)).toBe(false);
    expect(isSafeIntegerInScope(7n as unknown)).toBe(false);
  });
});
