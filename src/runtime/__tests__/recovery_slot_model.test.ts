import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALLOWANCE,
  initState,
  isRealRunCodeSuccess,
  runSequence,
  step,
  STRICT_ORACLE,
  type SlotEvent,
  type ToolSpec,
} from "../recovery_slot/slot_model";

const T: ToolSpec = { id: "T", idempotent: false, readOnly: false };
const R: ToolSpec = { id: "R", idempotent: true, readOnly: true };
const W: ToolSpec = { id: "W", idempotent: true, readOnly: false };

const timeout: SlotEvent = { kind: "timeout", tool: "T" };

describe("recovery slot model (strict oracle)", () => {
  it("mints the slot with the fixed allowance on a non-idempotent timeout and sets unknown_outcome(T)", () => {
    const s = step(initState(), timeout, STRICT_ORACLE);
    expect(s.slotOpen).toBe(true);
    expect(s.markTool).toBe("T");
    expect(s.allowance).toBe(DEFAULT_ALLOWANCE);
  });

  it("refuses any dispatch of the marked tool T with no allowance consumed", () => {
    const after = runSequence(
      [timeout, { kind: "dispatch", tool: "T", spec: T, success: true }],
      STRICT_ORACLE
    );
    expect(after.lastRefusal).toBe("blocked:unknown_outcome");
    expect(after.allowance).toBe(DEFAULT_ALLOWANCE);
    expect(after.slotOpen).toBe(true);
    expect(after.markTool).toBe("T");
  });

  it("lets a different idempotent read-only tool run as reconciliation: costs a step, no allowance, never closes the slot", () => {
    for (const evidence of ["applied", "not_applied", "none"] as const) {
      const before = runSequence([timeout], STRICT_ORACLE);
      const after = step(
        before,
        { kind: "reconcile", tool: "R", spec: R, evidence, recorded: true },
        STRICT_ORACLE
      );
      expect(after.steps).toBe(before.steps + 1);
      expect(after.allowance).toBe(DEFAULT_ALLOWANCE);
      expect(after.slotOpen).toBe(true);
      expect(after.lastRefusal).toBeNull();
    }
  });

  it("clears the mark only on recorded evidence, and the slot stays open until a real repair", () => {
    const marked = runSequence([timeout], STRICT_ORACLE);

    const noEvidence = step(
      marked,
      { kind: "reconcile", tool: "R", spec: R, evidence: "none", recorded: true },
      STRICT_ORACLE
    );
    expect(noEvidence.markTool).toBe("T");

    const unrecorded = step(
      marked,
      {
        kind: "reconcile",
        tool: "R",
        spec: R,
        evidence: "applied",
        recorded: false,
      },
      STRICT_ORACLE
    );
    expect(unrecorded.markTool).toBe("T");

    const cleared = step(
      marked,
      {
        kind: "reconcile",
        tool: "R",
        spec: R,
        evidence: "not_applied",
        recorded: true,
      },
      STRICT_ORACLE
    );
    expect(cleared.markTool).toBeNull();
    expect(cleared.slotOpen).toBe(true);
  });

  it("refuses reconciliation against the marked tool itself or a non-read-only tool", () => {
    const marked = runSequence([timeout], STRICT_ORACLE);
    const selfProbe = step(
      marked,
      { kind: "reconcile", tool: "T", spec: T, evidence: "applied", recorded: true },
      STRICT_ORACLE
    );
    expect(selfProbe.lastRefusal).toBe("blocked:invalid_reconciliation");
    expect(selfProbe.markTool).toBe("T");

    const writeProbe = step(
      marked,
      { kind: "reconcile", tool: "W", spec: W, evidence: "applied", recorded: true },
      STRICT_ORACLE
    );
    expect(writeProbe.lastRefusal).toBe("blocked:invalid_reconciliation");
  });

  it("refuses delegate_task while the mark is set (child slot cannot bypass the parent's)", () => {
    const after = runSequence(
      [timeout, { kind: "delegate", childFinalFailure: true }],
      STRICT_ORACLE
    );
    expect(after.lastRefusal).toBe("blocked:delegate_under_mark");
    expect(after.allowance).toBe(DEFAULT_ALLOWANCE);
    expect(after.slotOpen).toBe(true);
  });

  it("counts a child's final failure (no mark) as one parent recovery dispatch but child successes/failures never otherwise touch allowance", () => {
    const open = runSequence([timeout], STRICT_ORACLE);
    const clearedMark = step(
      open,
      { kind: "reconcile", tool: "R", spec: R, evidence: "applied", recorded: true },
      STRICT_ORACLE
    );
    const childFail = step(
      clearedMark,
      { kind: "delegate", childFinalFailure: true },
      STRICT_ORACLE
    );
    expect(childFail.lastRefusal).toBe("child_failure_counted");
    expect(childFail.allowance).toBe(DEFAULT_ALLOWANCE - 1);

    const childOk = step(
      clearedMark,
      { kind: "delegate", childFinalFailure: false },
      STRICT_ORACLE
    );
    expect(childOk.lastRefusal).toBeNull();
    expect(childOk.allowance).toBe(DEFAULT_ALLOWANCE);
  });

  it("run_code real success requires all four flags", () => {
    expect(
      isRealRunCodeSuccess({
        outcome: "completed",
        exitCode: 0,
        terminationConfirmed: true,
        cleanupConfirmed: true,
      })
    ).toBe(true);
    expect(
      isRealRunCodeSuccess({
        outcome: "completed",
        exitCode: 0,
        terminationConfirmed: false,
        cleanupConfirmed: true,
      })
    ).toBe(false);
    expect(
      isRealRunCodeSuccess({
        outcome: "completed",
        exitCode: 0,
        terminationConfirmed: true,
        cleanupConfed: true,
      } as never)
    ).toBe(false);
  });

  it("run_code success with termination_confirmed=false leaves the slot open and consumes allowance", () => {
    const marked = runSequence([timeout], STRICT_ORACLE);
    const after = step(
      marked,
      {
        kind: "run_code",
        outcome: "completed",
        exitCode: 0,
        terminationConfirmed: false,
        cleanupConfirmed: true,
      },
      STRICT_ORACLE
    );
    expect(after.slotOpen).toBe(true);
    expect(after.allowance).toBe(DEFAULT_ALLOWANCE - 1);
    expect(after.markTool).toBe("T");
  });

  it("a real run_code success closes the slot as a verified repair", () => {
    const after = runSequence(
      [
        timeout,
        {
          kind: "run_code",
          outcome: "completed",
          exitCode: 0,
          terminationConfirmed: true,
          cleanupConfirmed: true,
        },
      ],
      STRICT_ORACLE
    );
    expect(after.slotOpen).toBe(false);
    expect(after.markTool).toBeNull();
  });

  it("recall steps never change the slot", () => {
    const marked = runSequence([timeout], STRICT_ORACLE);
    const after = step(marked, { kind: "recall" }, STRICT_ORACLE);
    expect(after.slotOpen).toBe(marked.slotOpen);
    expect(after.markTool).toBe(marked.markTool);
    expect(after.allowance).toBe(marked.allowance);
    expect(after.steps).toBe(marked.steps + 1);
  });

  it("refuses all recovery dispatches once allowance is exhausted; only finalize proceeds", () => {
    const drain: SlotEvent[] = [timeout];
    for (let i = 0; i < DEFAULT_ALLOWANCE; i++) {
      drain.push({ kind: "dispatch", tool: "W", spec: W, success: false });
    }
    const exhausted = runSequence(drain, STRICT_ORACLE);
    expect(exhausted.allowance).toBe(0);
    expect(exhausted.slotOpen).toBe(true);

    const refused = step(
      exhausted,
      { kind: "dispatch", tool: "W", spec: W, success: true },
      STRICT_ORACLE
    );
    expect(refused.lastRefusal).toBe("blocked:allowance_exhausted");
    expect(refused.allowance).toBe(0);
    expect(refused.slotOpen).toBe(true);

    const finalized = step(exhausted, { kind: "finalize" }, STRICT_ORACLE);
    expect(finalized.finalized).toBe(true);
  });
});
