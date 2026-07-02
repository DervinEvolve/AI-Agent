import { describe, it, expect } from "vitest";
import {
  isSafeIntegerInScope,
  SAFE_INTEGER_LIMIT,
} from "./identity-widened";

// These tests exercise the branches of isSafeIntegerInScope that the
// parent's test suite does not cover: non-number inputs, non-integer
// numbers, and the special numeric values NaN / Infinity. Each of these
// must be rejected because the widened identity only admits finite
// integers within the safe range.
describe("isSafeIntegerInScope: non-number inputs", () => {
  it("rejects strings even if they look numeric", () => {
    expect(isSafeIntegerInScope("1")).toBe(false);
    expect(isSafeIntegerInScope("42")).toBe(false);
    expect(isSafeIntegerInScope("")).toBe(false);
  });

  it("rejects nullish and boolean values", () => {
    expect(isSafeIntegerInScope(null)).toBe(false);
    expect(isSafeIntegerInScope(undefined)).toBe(false);
    expect(isSafeIntegerInScope(true)).toBe(false);
    expect(isSafeIntegerInScope(false)).toBe(false);
  });

  it("rejects objects and arrays", () => {
    expect(isSafeIntegerInScope({})).toBe(false);
    expect(isSafeIntegerInScope([])).toBe(false);
    expect(isSafeIntegerInScope([1])).toBe(false);
  });

  it("rejects bigints (they are not typeof number)", () => {
    expect(isSafeIntegerInScope(1n)).toBe(false);
    expect(isSafeIntegerInScope(BigInt(SAFE_INTEGER_LIMIT))).toBe(false);
  });
});

describe("isSafeIntegerInScope: non-integer numbers", () => {
  it("rejects fractional numbers", () => {
    expect(isSafeIntegerInScope(1.5)).toBe(false);
    expect(isSafeIntegerInScope(-0.1)).toBe(false);
    expect(isSafeIntegerInScope(42.0000001)).toBe(false);
  });

  it("treats integer-valued floats as integers", () => {
    // 42.0 is === 42 and Number.isSafeInteger(42.0) is true.
    expect(isSafeIntegerInScope(42.0)).toBe(true);
    expect(isSafeIntegerInScope(-7.0)).toBe(true);
  });

  it("treats negative zero as in scope", () => {
    // -0 is a safe integer and lies within the range.
    expect(isSafeIntegerInScope(-0)).toBe(true);
  });
});

describe("isSafeIntegerInScope: special numeric values", () => {
  it("rejects NaN", () => {
    expect(isSafeIntegerInScope(NaN)).toBe(false);
    expect(isSafeIntegerInScope(Number.NaN)).toBe(false);
  });

  it("rejects infinities", () => {
    expect(isSafeIntegerInScope(Infinity)).toBe(false);
    expect(isSafeIntegerInScope(-Infinity)).toBe(false);
    expect(isSafeIntegerInScope(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isSafeIntegerInScope(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it("rejects Number.MAX_VALUE (beyond safe integer range)", () => {
    expect(isSafeIntegerInScope(Number.MAX_VALUE)).toBe(false);
  });
});
