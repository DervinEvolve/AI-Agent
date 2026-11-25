/**
 * Failure-slot recovery ledger.
 *
 * Implements the single failure-slot recovery rules as an explicit state
 * machine so they can be property-tested adversarially:
 *
 *  - A failure opens at most one slot. The slot closes only via (a) a true
 *    success (evidence-backed) or (b) an honest non-success finalize, which
 *    is ALWAYS legal while the slot is open — so the slot can never be stuck.
 *  - When a non-idempotent call ends in an unknown outcome (timeout, silent
 *    child), the agent may make exactly ONE read-only reconciliation call per
 *    unknown-outcome event, using a DIFFERENT tool. That call is not a
 *    recovery dispatch: it consumes no allowance, does not close the slot,
 *    and is permitted even when allowance_remaining is 0. It only produces
 *    evidence.
 *  - A delegate_task child result is evidence only. It never closes or
 *    bypasses the parent slot, a failing child opens no new slot while the
 *    parent slot is open, and child failures are charged to the parent's
 *    allowance.
 *  - A file tool returning outer status=ok with output.ok=false is a failure,
 *    classified at the output layer before any success is claimed.
 *  - Recall polls (max 2 while an unknown outcome is pending) never consume
 *    allowance and never change the slot.
 */

export type EvidenceKind = 'none' | 'success' | 'inconclusive';

export type ChildOutcome = 'claimed-complete' | 'failed' | 'unknown';

export interface UnknownOutcomeEvent {
  readonly id: string;
  /** Tool whose outcome is unknown (timed out / did not report). */
  readonly tool: string;
  reconciled: boolean;
  evidence: EvidenceKind;
}

export interface LedgerSnapshot {
  readonly slotOpen: boolean;
  readonly allowanceRemaining: number;
  readonly unknownOutcomeEvents: ReadonlyArray<{
    id: string;
    tool: string;
    reconciled: boolean;
    evidence: EvidenceKind;
  }>;
  readonly recallPollsUsed: number;
  readonly successEvidence: boolean;
}

export type Decision =
  | { readonly permitted: true }
  | { readonly permitted: false; readonly reason: string };

const MAX_RECALL_POLLS = 2;

export class FailureSlotLedger {
  private slotOpen = false;
  private allowance: number;
  private events: UnknownOutcomeEvent[] = [];
  private recallPolls = 0;
  private successEvidence = false;

  constructor(allowanceRemaining: number) {
    if (!Number.isInteger(allowanceRemaining) || allowanceRemaining < 0) {
      throw new TypeError('allowanceRemaining must be a non-negative integer');
    }
    this.allowance = allowanceRemaining;
  }

  snapshot(): LedgerSnapshot {
    return {
      slotOpen: this.slotOpen,
      allowanceRemaining: this.allowance,
      unknownOutcomeEvents: this.events.map((e) => ({ ...e })),
      recallPollsUsed: this.recallPolls,
      successEvidence: this.successEvidence,
    };
  }

  /** A failure opens the (single) slot. Idempotent while already open. */
  openFailureSlot(): void {
    this.slotOpen = true;
  }

  /**
   * Record that a non-idempotent call ended in an unknown outcome.
   * Event identity is the (id) pair: re-recording an existing id is a
   * no-op, so a re-declared event can never mint a second reconciliation
   * exemption for the same unknown outcome.
   */
  recordUnknownOutcome(id: string, tool: string): Decision {
    if (!this.slotOpen) {
      return { permitted: false, reason: 'no failure slot is open' };
    }
    if (this.events.some((e) => e.id === id)) {
      return { permitted: false, reason: 'unknown-outcome event already recorded' };
    }
    this.events.push({ id, tool, reconciled: false, evidence: 'none' });
    return { permitted: true };
  }

  /**
   * Is a reconciliation-exempt call permitted for this event with this tool?
   * Permitted even when allowance_remaining is 0.
   */
  canReconcile(eventId: string, tool: string, opts?: { readOnly?: boolean }): Decision {
    const ev = this.events.find((e) => e.id === eventId);
    if (!ev) return { permitted: false, reason: 'no such unknown-outcome event' };
    if (ev.reconciled) {
      return { permitted: false, reason: 'reconciliation already used for this event' };
    }
    if (opts && opts.readOnly === false) {
      return { permitted: false, reason: 'reconciliation call must be read-only' };
    }
    if (ev.tool === tool) {
      return {
        permitted: false,
        reason: 'reconciliation must use a different tool than the one with the unknown outcome',
      };
    }
    // Note: deliberately NO allowance check — the exemption is the point.
    return { permitted: true };
  }

  /**
   * Perform the single read-only reconciliation call for an event.
   * Consumes no allowance, never closes the slot, only records evidence.
   */
  reconcile(
    eventId: string,
    tool: string,
    evidence: Exclude<EvidenceKind, 'none'>,
    opts?: { readOnly?: boolean }
  ): Decision {
    const decision = this.canReconcile(eventId, tool, opts);
    if (!decision.permitted) return decision;
    const ev = this.events.find((e) => e.id === eventId)!;
    ev.reconciled = true;
    ev.evidence = evidence;
    if (evidence === 'success') {
      this.successEvidence = true;
    }
    // Never closes the slot; never charges allowance.
    return { permitted: true };
  }

  /** True success close: requires evidence that the original action succeeded. */
  canCloseOnTrueSuccess(): Decision {
    if (!this.slotOpen) return { permitted: false, reason: 'no open slot' };
    if (!this.successEvidence) {
      return { permitted: false, reason: 'no evidence of true success' };
    }
    return { permitted: true };
  }

  closeOnTrueSuccess(): Decision {
    const d = this.canCloseOnTrueSuccess();
    if (!d.permitted) return d;
    this.slotOpen = false;
    return { permitted: true };
  }

  /**
   * Honest non-success finalize. ALWAYS legal while the slot is open —
   * including when allowance is 0 and evidence is inconclusive — and always
   * closes the slot. This is the exit that makes a stuck slot unreachable.
   */
  canFinalizeNonSuccess(): Decision {
    if (!this.slotOpen) return { permitted: false, reason: 'no open slot' };
    return { permitted: true };
  }

  finalizeNonSuccess(): Decision {
    const d = this.canFinalizeNonSuccess();
    if (!d.permitted) return d;
    this.slotOpen = false;
    return { permitted: true };
  }

  /**
   * Recall poll: capped at MAX_RECALL_POLLS while an unknown outcome is
   * pending. Never consumes allowance and never changes the slot.
   */
  recallPoll(): Decision {
    const pending = this.events.some((e) => !e.reconciled);
    if (!this.slotOpen || !pending) {
      return { permitted: false, reason: 'nothing pending to recall' };
    }
    if (this.recallPolls >= MAX_RECALL_POLLS) {
      return { permitted: false, reason: 'recall poll cap reached' };
    }
    this.recallPolls += 1;
    return { permitted: true };
  }

  /**
   * delegate_task child result. Evidence ONLY: never closes or bypasses the
   * parent slot, never sets success evidence (a child's claimed-complete is
   * not host-verified), and a failing child opens no new slot. Child failure
   * is charged to the parent's allowance (floored at 0).
   */
  childResult(outcome: ChildOutcome): Decision {
    if (!this.slotOpen) {
      return { permitted: false, reason: 'no parent slot open' };
    }
    if (outcome === 'failed') {
      this.allowance = Math.max(0, this.allowance - 1);
    }
    // Evidence only: no slot change, no success evidence, no new slot.
    return { permitted: true };
  }

  /**
   * Output-layer classification for a (file) tool result.
   * outer status=ok with output.ok=false is a FAILURE — caught here, before
   * any success is claimed.
   */
  static classifyToolOutput(
    outerStatus: 'ok' | 'error',
    outputOk: boolean
  ): { isFailure: boolean; reason: string } {
    if (outerStatus !== 'ok') {
      return { isFailure: true, reason: 'outer status is not ok' };
    }
    if (outputOk !== true) {
      return {
        isFailure: true,
        reason: 'outer status=ok but output.ok=false — failure at the output layer',
      };
    }
    return { isFailure: false, reason: 'true success' };
  }
}

/** Deterministic seeded PRNG (mulberry32) for the fuzz harness. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
