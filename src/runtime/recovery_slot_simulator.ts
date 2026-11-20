/**
 * Deterministic simulator of the runtime-owned recovery slot ledger.
 *
 * Spec under test (recovery-slot design):
 *  - one open failure slot per intent, shared allowance of 3, closes only on true success
 *  - every dispatch carries an intent tag: repair_of=<slot.intentId> or new_intent
 *  - a new_intent dispatch while a slot is open does NOT consume the old slot's allowance;
 *    the old slot is suspended (not closed, not reset; remaining count and unknown_outcome
 *    flag preserved) and the new intent gets its own slot if it fails
 *  - at most one active slot; at most 2 suspended-or-active slots per turn; on cap, further
 *    new_intent work is refused and an honest partial-failure report is required
 *  - tools in a suspended slot's tool_blocked set stay blocked for every intent until a
 *    supervisor reconciles them
 *  - a plan revision, a recall call, or a child sub-agent's failure cannot create a
 *    new_intent tag or reset a slot
 *  - a delegate_task child's recovery failures debit the parent's slot for the delegated
 *    intent, so the child cannot bypass an exhausted allowance
 *  - the final answer must list every suspended or exhausted slot with its unknown-outcome tool
 *
 * This module is a pure, seeded-deterministic state machine so it can be adversarially
 * fuzzed (see src/runtime/__tests__/recovery_slot_simulator.adversarial.test.ts).
 */

export const SLOT_ALLOWANCE = 3;
export const MAX_OPEN_SLOTS = 2;
export const RECONCILIATION_POLL_CAP = 2;

export type OutcomeKind =
  | 'success'
  | 'invalid_args'
  | 'timeout'
  | 'nonzero_exit';

export type IntentTag =
  | { kind: 'repair_of'; intentId: string }
  | { kind: 'new_intent'; intentId: string };

export type SimEvent =
  | {
      type: 'tool_result';
      tool: string;
      outcome: OutcomeKind;
      idempotent: boolean;
      tag: IntentTag;
    }
  | { type: 'recall' }
  | { type: 'plan_revision'; attemptedRelabel?: IntentTag }
  | {
      type: 'delegate_task';
      childId: string;
      parentIntentId: string;
      tool: string;
      outcome: OutcomeKind;
      idempotent: boolean;
    }
  | {
      type: 'reconcile';
      tool: string;
      evidence: 'success' | 'failure';
    };

export type SlotStatus = 'active' | 'suspended';

export interface RecoverySlot {
  intentId: string;
  status: SlotStatus;
  /** number of repair dispatches charged to this intent */
  debits: number;
  /** SLOT_ALLOWANCE - debits */
  remaining: number;
  /** tool whose outcome is UNKNOWN (timeout on a non-idempotent tool), if any */
  unknownOutcomeTool: string | null;
  /** tools that produced non-success outcomes in this slot */
  failedTools: string[];
  /** blocked for every intent until a supervisor reconciles (populated on suspension) */
  toolBlocked: string[];
  /** recall polls issued while unknownOutcomeTool is pending */
  reconciliationPolls: number;
}

export interface DispatchResult {
  admitted: boolean;
  reason: string;
  requiresHonestFailureReport: boolean;
  slotIntentId?: string;
}

export interface FinalAnswer {
  honestPartialFailure: boolean;
  slots: Array<{
    intentId: string;
    status: SlotStatus | 'exhausted';
    remaining: number;
    unknownOutcomeTool: string | null;
  }>;
}

function isUnknownOutcome(outcome: OutcomeKind, idempotent: boolean): boolean {
  // A timeout on a non-idempotent tool leaves the effect's final state UNKNOWN.
  // A timeout on an idempotent tool is a known failure (safe to retry).
  return outcome === 'timeout' && !idempotent;
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

export class RecoverySlotSimulator {
  private slots: RecoverySlot[] = [];
  private honestFailureRequired = false;
  private eventsProcessed = 0;

  /** structural clone of the ledger, for invariant assertions */
  snapshot(): RecoverySlot[] {
    return this.slots.map((s) => ({
      intentId: s.intentId,
      status: s.status,
      debits: s.debits,
      remaining: s.remaining,
      unknownOutcomeTool: s.unknownOutcomeTool,
      failedTools: [...s.failedTools],
      toolBlocked: [...s.toolBlocked],
      reconciliationPolls: s.reconciliationPolls,
    }));
  }

  get eventsProcessedCount(): number {
    return this.eventsProcessed;
  }

  private findSlot(intentId: string): RecoverySlot | undefined {
    return this.slots.find((s) => s.intentId === intentId);
  }

  private activeSlot(): RecoverySlot | undefined {
    return this.slots.find((s) => s.status === 'active');
  }

  private isToolBlocked(tool: string): boolean {
    return this.slots.some((s) => s.toolBlocked.includes(tool));
  }

  private suspendActive(): void {
    const active = this.activeSlot();
    if (!active) return;
    active.status = 'suspended';
    // tools that failed inside the suspended slot become blocked for every intent
    active.toolBlocked = [...new Set(active.failedTools)];
  }

  private createSlot(intentId: string): RecoverySlot {
    const slot: RecoverySlot = {
      intentId,
      status: 'active',
      debits: 0,
      remaining: SLOT_ALLOWANCE,
      unknownOutcomeTool: null,
      failedTools: [],
      toolBlocked: [],
      reconciliationPolls: 0,
    };
    this.slots.push(slot);
    return slot;
  }

  private debit(slot: RecoverySlot): void {
    slot.debits += 1;
    slot.remaining = SLOT_ALLOWANCE - slot.debits;
  }

  dispatch(event: SimEvent): DispatchResult {
    this.eventsProcessed += 1;
    switch (event.type) {
      case 'tool_result':
        return this.dispatchToolResult(event);
      case 'recall':
        return this.dispatchRecall();
      case 'plan_revision':
        // A plan revision cannot create a new_intent tag, relabel a dispatch,
        // reset a slot, or close a slot. attemptedRelabel is deliberately ignored.
        return { admitted: true, reason: 'plan_revision_no_slot_effect', requiresHonestFailureReport: false };
      case 'delegate_task':
        return this.dispatchDelegateTask(event);
      case 'reconcile':
        return this.dispatchReconcile(event);
    }
  }

  private dispatchToolResult(event: Extract<SimEvent, { type: 'tool_result' }>): DispatchResult {
    const { tool, outcome, idempotent, tag } = event;

    // blocked tools are blocked for every intent, regardless of tag
    if (this.isToolBlocked(tool)) {
      this.honestFailureRequired = this.honestFailureRequired || this.slots.length > 0;
      return {
        admitted: false,
        reason: 'tool_blocked_pending_reconciliation',
        requiresHonestFailureReport: this.slots.length > 0,
      };
    }

    if (tag.kind === 'new_intent') {
      // cap: further new_intent work is refused once MAX_OPEN_SLOTS slots exist
      if (this.slots.length >= MAX_OPEN_SLOTS) {
        this.honestFailureRequired = true;
        return {
          admitted: false,
          reason: 'slot_cap_reached_new_intent_refused',
          requiresHonestFailureReport: true,
        };
      }
      if (outcome === 'success') {
        // a successful new intent needs no slot and closes nothing
        return { admitted: true, reason: 'new_intent_success_no_slot', requiresHonestFailureReport: false };
      }
      // suspend the old slot (preserving debits / unknown_outcome) and give the new
      // intent its own slot. The old slot's allowance is NOT consumed.
      this.suspendActive();
      const slot = this.createSlot(tag.intentId);
      this.debit(slot);
      if (outcome !== 'success') pushUnique(slot.failedTools, tool);
      if (isUnknownOutcome(outcome, idempotent)) {
        slot.unknownOutcomeTool = tool;
      }
      return {
        admitted: true,
        reason: 'new_intent_slot_opened',
        requiresHonestFailureReport: false,
        slotIntentId: slot.intentId,
      };
    }

    // repair_of dispatch
    const slot = this.findSlot(tag.intentId);
    if (!slot) {
      return {
        admitted: false,
        reason: 'repair_of_unknown_intent',
        requiresHonestFailureReport: false,
      };
    }
    if (slot.status === 'suspended') {
      // fail-closed: a suspended intent cannot start a fresh physical retry;
      // only a new_intent dispatch (own slot) or supervisor reconciliation proceeds.
      this.honestFailureRequired = true;
      return {
        admitted: false,
        reason: 'repair_of_suspended_slot_forbidden',
        requiresHonestFailureReport: true,
        slotIntentId: slot.intentId,
      };
    }
    if (slot.remaining <= 0) {
      this.honestFailureRequired = true;
      return {
        admitted: false,
        reason: 'allowance_exhausted',
        requiresHonestFailureReport: true,
        slotIntentId: slot.intentId,
      };
    }
    this.debit(slot);
    if (outcome !== 'success') pushUnique(slot.failedTools, tool);
    if (isUnknownOutcome(outcome, idempotent)) {
      slot.unknownOutcomeTool = tool;
    }
    if (outcome === 'success') {
      // closes only on true success
      this.slots = this.slots.filter((s) => s !== slot);
      return {
        admitted: true,
        reason: 'repair_success_slot_closed',
        requiresHonestFailureReport: false,
        slotIntentId: tag.intentId,
      };
    }
    return {
      admitted: true,
      reason: 'repair_debited_slot_open',
      requiresHonestFailureReport: false,
      slotIntentId: slot.intentId,
    };
  }

  private dispatchRecall(): DispatchResult {
    // A recall call can never create a new_intent tag, open, reset, or close a slot.
    // Recall during pending reconciliation is bounded by RECONCILIATION_POLL_CAP polls
    // per slot with an unknown outcome; beyond the cap the recall is refused and the
    // agent must report honestly (the unknown_outcome slot stays open until a
    // supervisor reconciles with target-side evidence).
    const pending = this.slots.filter((s) => s.unknownOutcomeTool !== null);
    if (pending.length === 0) {
      return { admitted: true, reason: 'recall_no_pending_reconciliation', requiresHonestFailureReport: false };
    }
    const atCap = pending.filter((s) => s.reconciliationPolls >= RECONCILIATION_POLL_CAP);
    if (atCap.length > 0) {
      this.honestFailureRequired = true;
      return {
        admitted: false,
        reason: 'reconciliation_poll_cap_reached',
        requiresHonestFailureReport: true,
        slotIntentId: atCap[0].intentId,
      };
    }
    for (const slot of pending) slot.reconciliationPolls += 1;
    return {
      admitted: true,
      reason: 'recall_reconciliation_pending',
      requiresHonestFailureReport: false,
    };
  }

  private dispatchDelegateTask(
    event: Extract<SimEvent, { type: 'delegate_task' }>
  ): DispatchResult {
    const { parentIntentId, tool, outcome, idempotent } = event;
    if (outcome === 'success') {
      return { admitted: true, reason: 'delegate_child_success', requiresHonestFailureReport: false };
    }
    if (this.isToolBlocked(tool)) {
      this.honestFailureRequired = true;
      return {
        admitted: false,
        reason: 'tool_blocked_pending_reconciliation',
        requiresHonestFailureReport: true,
      };
    }
    let parent = this.findSlot(parentIntentId);
    if (!parent) {
      // a child failure cannot create a new_intent tag, but the runtime opens the
      // parent's slot for the delegated intent (subject to the cap)
      if (this.slots.length >= MAX_OPEN_SLOTS) {
        this.honestFailureRequired = true;
        return {
          admitted: false,
          reason: 'slot_cap_reached_child_failure_refused',
          requiresHonestFailureReport: true,
        };
      }
      this.suspendActive();
      parent = this.createSlot(parentIntentId);
    } else if (parent.remaining <= 0) {
      // the child cannot bypass an exhausted parent allowance
      this.honestFailureRequired = true;
      return {
        admitted: false,
        reason: 'parent_allowance_exhausted_child_refused',
        requiresHonestFailureReport: true,
        slotIntentId: parent.intentId,
      };
    }
    // debit the parent's slot for the delegated intent (even while suspended:
    // the child must not bypass the parent's allowance via a separate ledger)
    this.debit(parent);
    pushUnique(parent.failedTools, tool);
    if (isUnknownOutcome(outcome, idempotent)) {
      parent.unknownOutcomeTool = tool;
    }
    return {
      admitted: true,
      reason: parent.status === 'suspended' ? 'child_failure_debited_suspended_parent_slot' : 'child_failure_debited_parent_slot',
      requiresHonestFailureReport: false,
      slotIntentId: parent.intentId,
    };
  }

  private dispatchReconcile(
    event: Extract<SimEvent, { type: 'reconcile' }>
  ): DispatchResult {
    const { tool, evidence } = event;
    // supervisor reconciliation unblocks the tool for every intent
    for (const slot of this.slots) {
      slot.toolBlocked = slot.toolBlocked.filter((t) => t !== tool);
    }
    if (evidence === 'success') {
      // authoritative target-side evidence of success closes the unknown_outcome slot
      const closed = this.slots.filter((s) => s.unknownOutcomeTool === tool);
      this.slots = this.slots.filter((s) => s.unknownOutcomeTool !== tool);
      return {
        admitted: true,
        reason: closed.length > 0 ? 'reconcile_success_closed_slots' : 'reconcile_success_no_pending_slot',
        requiresHonestFailureReport: false,
      };
    }
    // target-side evidence of failure resolves the UNKNOWN to a known failure;
    // the slot stays open with its remaining allowance
    for (const slot of this.slots) {
      if (slot.unknownOutcomeTool === tool) {
        slot.unknownOutcomeTool = null;
        slot.reconciliationPolls = 0;
      }
    }
    return {
      admitted: true,
      reason: 'reconcile_failure_unknown_resolved_slot_open',
      requiresHonestFailureReport: false,
    };
  }

  finalAnswer(): FinalAnswer {
    const open = this.snapshot();
    return {
      honestPartialFailure: this.honestFailureRequired || open.length > 0,
      slots: open.map((s) => ({
        intentId: s.intentId,
        status: s.remaining <= 0 ? ('exhausted' as const) : s.status,
        remaining: s.remaining,
        unknownOutcomeTool: s.unknownOutcomeTool,
      })),
    };
  }
}
