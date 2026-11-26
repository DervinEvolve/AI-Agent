import { describe, expect, it } from "vitest";

import { runFuzz } from "../recovery_slot/fuzz";

describe("recovery slot seeded fuzzer", () => {
  it("is deterministic: the same seed yields the identical report", () => {
    const a = runFuzz(20260213);
    const b = runFuzz(20260213);
    expect(a).toEqual(b);
  });

  it("different seeds still check a meaningful number of sequences", () => {
    for (const seed of [1, 42, 999, 123456]) {
      const r = runFuzz(seed);
      expect(r.sequencesChecked).toBeGreaterThanOrEqual(403);
    }
  });

  it("finds no invariant violations under the strict oracle", () => {
    const r = runFuzz(20260213, 800);
    expect(r.invariantViolations).toEqual([]);
  });

  it("surfaces the reconciliation-allowance ambiguity (mlsysbook Table 2 reading)", () => {
    const r = runFuzz(20260213);
    const d = r.divergences.find(
      (x) => x.variant === "reconciliation-costs-allowance"
    );
    expect(d).toBeDefined();
    expect(d!.sequence[0].kind).toBe("timeout");
    expect(d!.sequence[d!.eventIndex].kind).toBe("reconcile");
    // Strict: allowance untouched. Alternative: allowance decremented.
    expect(d!.strictState).not.toBe(d!.variantState);
  });

  it("surfaces the delegate-under-mark contradiction (child final failure vs. refused delegate_task)", () => {
    const r = runFuzz(20260213);
    const d = r.divergences.find(
      (x) => x.variant === "child-failure-counts-under-mark"
    );
    expect(d).toBeDefined();
    const kinds = d!.sequence.map((e) => e.kind);
    expect(kinds).toContain("timeout");
    expect(kinds).toContain("delegate");
    // The strict reading refuses the delegate with no accounting; the
    // alternative decrements the parent's allowance for the refused child.
    expect(d!.strictState).not.toBe(d!.variantState);
  });

  it("every divergence carries a minimal reproducing sequence and a description", () => {
    const r = runFuzz(7);
    expect(r.divergences.length).toBeGreaterThan(0);
    for (const d of r.divergences) {
      expect(d.sequence.length).toBeGreaterThan(0);
      expect(d.sequence.length).toBeLessThanOrEqual(13);
      expect(d.eventIndex).toBeLessThan(d.sequence.length);
      expect(d.description.length).toBeGreaterThan(20);
    }
  });
});
