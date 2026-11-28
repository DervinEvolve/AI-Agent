/**
 * Recovery slot state machine (capability 31).
 *
 * One open failure slot per intent, allowance 3, inherited by every
 * repair / retry / alternative dispatch. When allowance reaches 0 while
 * the slot is open, the slot enters the terminal `exhausted` state:
 * further repair/retry/alternative dispatches are REFUSED with a
 * structured refusal that never consumes allowance and never mints a new
 * slot. Only read-only reconcile or recall may still run, and neither can
 * close or reset the slot. Exhaustion never downgrades an unknown outcome
 * (non-idempotent timeout) to "failed". A child sub-agent's fresh ledger
 * inherits the parent's remaining allowance and pending-unknown flag, so
 * delegation cannot launder allowance.
 */

export const RECOVERY_ALLOWANCE = 3;

export type SlotState = 'open' | 'exhausted';

/** Three-state evidence model for reconciliation. */
export type Evidence = 'established' | 'established-absent' | 'unknown';

export type DispatchKind = 'repair' | 'retry' | 'alternative';

export interface Refusal {
  refused: true;
  reason: 'allowance_exhausted' | 'unknown_outcome_pending' | 'policy_authorization_required';
  intent_id: string;
  original_call_id: string;
}

export interface DispatchAdmission {
  refused: false;
  admitted: true;
  kind: DispatchKind;
  tool: string;
  remainingAllowance: number;
  attempts: number;
}

export type DispatchResult = Refusal | DispatchAdmission;

export interface RecoverySlot {
  intentId: string;
  originalCallId: string;
  originalTool: string;
  state: SlotState;
  remainingAllowance: number;
  /** True while a non-idempotent timeout left the outcome unknown. */
  pendingUnknown: boolean;
  evidence: Evidence;
  /** Terminal resolution: only same-tool success or authorized policy. */
  resolved: boolean;
  /** Attempts admitted (incremented on admission, not on success). */
  attempts: number;
  /** Success via a substitute tool: recorded, but does NOT close the slot. */
  workaround: { tool: string; kind: DispatchKind } | null;
  /** Journal of admitted attempts and first-time refusals only. */
  journal: string[];
  refusalKeys: string[];
  steps: number;
  episodes: number;
}

export function openRecoverySlot(
  intentId: string,
  originalCallId: string,
  originalTool: string,
): RecoverySlot {
  return {
    intentId,
    originalCallId,
    originalTool,
    state: 'open',
    remainingAllowance: RECOVERY_ALLOWANCE,
    pendingUnknown: false,
    evidence: 'unknown',
    resolved: false,
    attempts: 0,
    workaround: null,
    journal: [`open:${intentId}:${originalCallId}`],
    refusalKeys: [],
    steps: 0,
    episodes: 1,
  };
}

function isRefused(slot: RecoverySlot): Refusal | null {
  if (slot.pendingUnknown) {
    return {
      refused: true,
      reason: 'unknown_outcome_pending',
      intent_id: slot.intentId,
      original_call_id: slot.originalCallId,
    };
  }
  if (slot.state === 'exhausted' || slot.remainingAllowance <= 0) {
    return {
      refused: true,
      reason: 'allowance_exhausted',
      intent_id: slot.intentId,
      original_call_id: slot.originalCallId,
    };
  }
  return null;
}

/**
 * Attempt a repair / retry / alternative dispatch against the slot.
 * Refusals are structured and idempotent: a repeated refused attempt
 * returns the same refusal and mints no new journal entry.
 */
export function requestDispatch(
  slot: RecoverySlot,
  kind: DispatchKind,
  tool: string,
): DispatchResult {
  const refusal = isRefused(slot);
  if (refusal) {
    const key = `${refusal.reason}:${slot.intentId}`;
    if (!slot.refusalKeys.includes(key)) {
      // Only the first refusal per (reason, intent) is journaled, so
      // repeated refusals cannot be mistaken for attempts.
      slot.refusalKeys.push(key);
      slot.journal.push(`refused:${refusal.reason}:${slot.intentId}`);
    }
    return refusal;
  }
  slot.remainingAllowance -= 1;
  slot.attempts += 1;
  slot.journal.push(`dispatch:${kind}:${tool}:${slot.attempts}`);
  if (slot.remainingAllowance <= 0) {
    // Allowance reached 0 while the slot is open: terminal exhausted state.
    slot.state = 'exhausted';
  }
  return {
    refused: false,
    admitted: true,
    kind,
    tool,
    remainingAllowance: slot.remainingAllowance,
    attempts: slot.attempts,
  };
}

/**
 * Record the outcome of an admitted dispatch.
 *
 * Spec clarification (found by fuzzing the prose): success via a DIFFERENT
 * tool than the failed intent records a workaround but does NOT close the
 * slot — only success via the original tool (or authorized policy)
 * resolves it. Otherwise a substitute-tool success could be used to
 * launder closure of an unresolved failure.
 */
export function recordOutcome(
  slot: RecoverySlot,
  result: 'success' | 'failure',
  tool: string,
  kind: DispatchKind = 'repair',
): void {
  if (result === 'success') {
    if (tool === slot.originalTool) {
      slot.resolved = true;
      slot.evidence = 'established';
      slot.journal.push(`resolved:${tool}`);
    } else {
      slot.workaround = { tool, kind };
      slot.journal.push(`workaround:${tool}`);
    }
  } else {
    slot.journal.push(`failed:${tool}`);
  }
}

/**
 * Record a timeout. An idempotent timeout is safe to treat as a failure;
 * a non-idempotent timeout leaves the outcome UNKNOWN and blocks further
 * dispatches on this slot until settlement.
 */
export function recordTimeout(slot: RecoverySlot, idempotent: boolean): void {
  if (idempotent) {
    slot.journal.push('timeout:idempotent');
  } else {
    slot.pendingUnknown = true;
    slot.evidence = 'unknown';
    slot.journal.push('timeout:unknown-non-idempotent');
  }
}

/**
 * Read-only reconcile. Always allowed — even under exhaustion or a
 * pending unknown outcome — but it can never close or reset the slot.
 * It may settle the three-state evidence (established /
 * established-absent / unknown) which the final report uses.
 */
export function reconcile(slot: RecoverySlot, evidence: Evidence): {
  allowed: true;
  closed: false;
  resetAllowance: false;
  evidence: Evidence;
} {
  slot.steps += 1;
  if (evidence !== 'unknown') {
    // Settlement of evidence; pendingUnknown flag itself is sticky so the
    // slot is never silently reopened for dispatch by a reconcile.
    slot.evidence = evidence;
    slot.journal.push(`reconcile:${evidence}`);
  } else {
    slot.journal.push('reconcile:unknown');
  }
  return {
    allowed: true,
    closed: false,
    resetAllowance: false,
    evidence: slot.evidence,
  };
}

/**
 * Recall. Costs a step but no allowance; allowed under exhaustion and
 * under a pending unknown outcome; can never close or reset the slot.
 */
export function recall(slot: RecoverySlot): {
  allowed: true;
  cost: 'step';
  allowanceDelta: 0;
  closed: false;
} {
  slot.steps += 1;
  slot.journal.push('recall');
  return { allowed: true, cost: 'step', allowanceDelta: 0, closed: false };
}

/**
 * A child sub-agent gets its own recovery ledger, but it inherits the
 * parent's remaining allowance and the parent's pending-unknown flag for
 * the same intent_id — a child cannot widen inherited limits, so
 * delegation cannot launder allowance.
 */
export function spawnChildLedger(parent: RecoverySlot): RecoverySlot {
  return {
    intentId: parent.intentId,
    originalCallId: parent.originalCallId,
    originalTool: parent.originalTool,
    state: parent.remainingAllowance <= 0 ? 'exhausted' : 'open',
    remainingAllowance: parent.remainingAllowance,
    pendingUnknown: parent.pendingUnknown,
    evidence: parent.evidence,
    resolved: false,
    attempts: 0,
    workaround: null,
    // Telemetry is inherited: the child's ledger is part of the parent's
    // repair episode history.
    journal: [...parent.journal, `child-ledger:${parent.intentId}`],
    refusalKeys: [],
    steps: 0,
    episodes: parent.episodes,
  };
}

export interface PolicyAuthorization {
  authorizedBy: 'policy-modification';
  newAllowance: number;
  settleUnknown?: boolean;
  resolve?: boolean;
}

/**
 * Only an authorized policy modification opens a new episode. The new
 * episode inherits all telemetry (journal, attempt counter) and, unless
 * the authorization explicitly settles it, the pending-unknown flag.
 */
export function policyAuthorizedReset(
  slot: RecoverySlot,
  authorization: PolicyAuthorization | { authorizedBy: 'user' | 'agent' },
): RecoverySlot | Refusal {
  if (authorization.authorizedBy !== 'policy-modification') {
    return {
      refused: true,
      reason: 'policy_authorization_required',
      intent_id: slot.intentId,
      original_call_id: slot.originalCallId,
    };
  }
  const next: RecoverySlot = {
    ...slot,
    state: authorization.newAllowance > 0 ? 'open' : 'exhausted',
    remainingAllowance: authorization.newAllowance,
    pendingUnknown: authorization.settleUnknown ? false : slot.pendingUnknown,
    resolved: authorization.resolve === true ? true : slot.resolved,
    workaround: slot.workaround,
    journal: [...slot.journal, `policy-episode:${slot.episodes + 1}`],
    refusalKeys: [...slot.refusalKeys],
    episodes: slot.episodes + 1,
  };
  return next;
}

export interface FinalReport {
  intent_id: string;
  original_call_id: string;
  slot_state: SlotState | 'resolved';
  remaining_allowance: number;
  outcome: 'success' | 'failed' | 'outcome-unknown' | 'established-absent';
  attempts: number;
  workaround: { tool: string; kind: DispatchKind } | null;
  message: string;
}

/**
 * The report the agent must give the user. Exhaustion never downgrades an
 * unknown outcome: if a non-idempotent timeout is pending and the
 * evidence has not settled, the report says "outcome unknown", never
 * "did not happen".
 */
export function finalReport(slot: RecoverySlot): FinalReport {
  const base = {
    intent_id: slot.intentId,
    original_call_id: slot.originalCallId,
    remaining_allowance: slot.remainingAllowance,
    attempts: slot.attempts,
    workaround: slot.workaround,
  };
  if (slot.resolved) {
    return {
      ...base,
      slot_state: 'resolved',
      outcome: 'success',
      message: `Intent ${slot.intentId} recovered successfully after ${slot.attempts} attempt(s).`,
    };
  }
  if (slot.pendingUnknown) {
    if (slot.evidence === 'established') {
      return {
        ...base,
        slot_state: slot.state,
        outcome: 'success',
        message: `Intent ${slot.intentId}: effect confirmed by reconciliation.`,
      };
    }
    if (slot.evidence === 'established-absent') {
      return {
        ...base,
        slot_state: slot.state,
        outcome: 'established-absent',
        message: `Intent ${slot.intentId}: reconciliation established the effect did not happen.`,
      };
    }
    return {
      ...base,
      slot_state: slot.state,
      outcome: 'outcome-unknown',
      message: `Intent ${slot.intentId}: recovery allowance is ${slot.remainingAllowance} and the outcome is UNKNOWN (non-idempotent timeout). Reporting to user: outcome unknown — not "did not happen". No further attempts will be made without policy authorization.`,
    };
  }
  return {
    ...base,
    slot_state: slot.state,
    outcome: 'failed',
    message: `Intent ${slot.intentId}: recovery allowance exhausted (${slot.attempts} attempt(s)); unresolved failure reported to the user.`,
  };
}
