/**
 * Executable model of the recovery-slot spec (failure-slot with fixed allowance,
 * unknown_outcome(T) mark, reconciliation, delegation, recall, run_code).
 *
 * The model is deliberately small and pure so a seeded fuzzer can drive it with
 * random event sequences and compare two reasonable readings of the spec text.
 *
 * Strict reading (the contribution text, verbatim):
 *  - reconciliation costs a step and consumes NO allowance, never closes/resets
 *    the slot; the unknown_outcome mark clears only when reconciliation returns
 *    evidence of T's effect AND the agent records it.
 *  - delegate_task is refused outright while the mark is set, so a child's final
 *    failure cannot "count as one parent recovery dispatch" in that state.
 *
 * Alternative readings (flagged by the mlsysbook vol3 ch.12 Table 2 taxonomy,
 * where a reconciliation probe returning evidence is a *retry of the same
 * operation*, and by the arXiv 2611.23353 fault-injection adapters):
 *  - reconciliationConsumesAllowance: a reconciliation probe is a retry and
 *    therefore spends allowance like any recovery dispatch.
 *  - childFinalFailureCountsUnderMark: the "child's final failure counts as one
 *    parent recovery dispatch" rule fires even while delegate_task is refused
 *    under the unknown_outcome mark.
 */

export const DEFAULT_ALLOWANCE = 3;

export type Evidence = "applied" | "not_applied" | "none";

export interface ToolSpec {
  id: string;
  idempotent: boolean;
  readOnly: boolean;
}

export interface SlotState {
  /** The single runtime-owned failure slot. */
  slotOpen: boolean;
  /** unknown_outcome(tool=T) mark, null when cleared / never set. */
  markTool: string | null;
  /** Remaining recovery dispatches on the open slot. */
  allowance: number;
  /** Step counter (reconciliation costs a step). */
  steps: number;
  /** Episode finalized (only honest-failure finalization is allowed). */
  finalized: boolean;
  /** Refusal reason for the last step, null when the step was admitted. */
  lastRefusal: string | null;
}

export interface Oracle {
  reconciliationConsumesAllowance: boolean;
  childFinalFailureCountsUnderMark: boolean;
}

export const STRICT_ORACLE: Oracle = {
  reconciliationConsumesAllowance: false,
  childFinalFailureCountsUnderMark: false,
};

export type SlotEvent =
  | { kind: "timeout"; tool: string }
  | { kind: "dispatch"; tool: string; spec: ToolSpec; success: boolean }
  | {
      kind: "reconcile";
      tool: string;
      spec: ToolSpec;
      evidence: Evidence;
      recorded: boolean;
    }
  | { kind: "recall" }
  | { kind: "delegate"; childFinalFailure: boolean }
  | {
      kind: "run_code";
      outcome: "completed" | "failed";
      exitCode: number;
      terminationConfirmed: boolean;
      cleanupConfirmed: boolean;
    }
  | { kind: "finalize" };

export function initState(): SlotState {
  return {
    slotOpen: false,
    markTool: null,
    allowance: 0,
    steps: 0,
    finalized: false,
    lastRefusal: null,
  };
}

export function isRealRunCodeSuccess(ev: {
  outcome: "completed" | "failed";
  exitCode: number;
  terminationConfirmed: boolean;
  cleanupConfirmed: boolean;
}): boolean {
  return (
    ev.outcome === "completed" &&
    ev.exitCode === 0 &&
    ev.terminationConfirmed === true &&
    ev.cleanupConfirmed === true
  );
}

/** One pure transition of the slot state machine under a given oracle. */
export function step(s: SlotState, ev: SlotEvent, o: Oracle): SlotState {
  const n: SlotState = { ...s, lastRefusal: null };
  if (n.finalized) {
    n.lastRefusal = "blocked:finalized";
    n.steps++;
    return n;
  }
  switch (ev.kind) {
    case "timeout": {
      // Non-idempotent tool call timed out: mint the slot if none is open,
      // then mark it unknown_outcome(T).
      if (!n.slotOpen) {
        n.slotOpen = true;
        n.allowance = DEFAULT_ALLOWANCE;
      }
      n.markTool = ev.tool;
      n.steps++;
      return n;
    }
    case "dispatch": {
      n.steps++;
      if (n.slotOpen && n.markTool === ev.tool) {
        // Any dispatch of the marked tool T is refused, consumes no allowance.
        n.lastRefusal = "blocked:unknown_outcome";
        return n;
      }
      if (n.slotOpen && n.allowance <= 0) {
        n.lastRefusal = "blocked:allowance_exhausted";
        return n;
      }
      if (n.slotOpen) n.allowance -= 1;
      if (ev.success) {
        // A verified successful repair closes the slot and clears any mark.
        n.slotOpen = false;
        n.markTool = null;
      }
      return n;
    }
    case "reconcile": {
      n.steps++;
      const valid =
        ev.spec.idempotent &&
        ev.spec.readOnly &&
        ev.tool !== n.markTool;
      if (!valid) {
        n.lastRefusal = "blocked:invalid_reconciliation";
        return n;
      }
      if (o.reconciliationConsumesAllowance && n.slotOpen && n.allowance > 0) {
        n.allowance -= 1;
      }
      if (ev.evidence !== "none" && ev.recorded) {
        // Mark clears only on recorded evidence of T's effect; slot stays open.
        n.markTool = null;
      }
      // Never closes, resets or re-mints the slot, whatever it returns.
      return n;
    }
    case "recall": {
      // Recall steps never change the slot.
      n.steps++;
      return n;
    }
    case "delegate": {
      n.steps++;
      if (n.slotOpen && n.markTool) {
        // delegate_task is refused under the mark. The strict reading refuses
        // with no accounting; the alternative reading still counts the child's
        // final failure as one parent recovery dispatch (the contradiction).
        if (o.childFinalFailureCountsUnderMark && ev.childFinalFailure) {
          n.allowance = Math.max(0, n.allowance - 1);
          n.lastRefusal = "refused_but_counted";
        } else {
          n.lastRefusal = "blocked:delegate_under_mark";
        }
        return n;
      }
      if (n.slotOpen && ev.childFinalFailure) {
        // Child failures never consume the parent's allowance, but a child's
        // final failure result returned to the parent counts as one parent
        // recovery dispatch.
        n.allowance = Math.max(0, n.allowance - 1);
        n.lastRefusal = "child_failure_counted";
        return n;
      }
      return n;
    }
    case "run_code": {
      n.steps++;
      if (n.slotOpen && n.allowance <= 0) {
        n.lastRefusal = "blocked:allowance_exhausted";
        return n;
      }
      if (isRealRunCodeSuccess(ev)) {
        if (n.slotOpen) n.allowance -= 1;
        n.slotOpen = false;
        n.markTool = null;
        return n;
      }
      // Not a real success (e.g. termination_confirmed=false or
n      // cleanup_confirmed=false, or outer ok with output.ok=false): the slot
      // stays open and consumes allowance.
      if (n.slotOpen) n.allowance = Math.max(0, n.allowance - 1);
      return n;
    }
    case "finalize": {
      // Only honest-failure finalization is allowed once allowance is gone;
      // the model admits finalize at any point and records it as terminal.
      n.finalized = true;
      n.steps++;
      return n;
    }
  }
}

export function runSequence(
  events: SlotEvent[],
  o: Oracle,
  initial: SlotState = initState()
): SlotState {
  return events.reduce((s, ev) => step(s, ev, o), initial);
}

export function canonical(s: SlotState): string {
  return `${s.slotOpen}|${s.markTool}|${s.allowance}|${s.finalized}`;
}
