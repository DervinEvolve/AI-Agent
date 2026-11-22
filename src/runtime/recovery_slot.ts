/**
 * Reference implementation of the recovery-slot state machine.
 *
 * Spec rules encoded here:
 *  - At most one open failure slot; shared allowance of 3 charged attempts per slot.
 *  - The slot closes only on true success (a successful repair dispatch, or a
 *    reconciliation classified `confirmed_applied`) or on finalize.
 *  - A timeout on a non-idempotent tool sets unknown_outcome and blocks further
 *    non-idempotent dispatches of that same tool (idempotent calls remain legal —
 *    that is the reconciliation path).
 *  - Recall calls are always free and never mutate slot state.
 *  - Replanning never resets the slot, the allowance, or unknown_outcome.
 *  - While a slot is open, every non-recall dispatch must declare intent:
 *    `repair_of` (charged, inherits the open intent) or `unrelated` (not
 *    charged, does not mint or close anything). Undeclared or unrelated
 *    failures are logged as AMBIGUOUS_INTENT_MERGE and never charged.
 *  - After a non-idempotent timeout, an idempotent reconciliation whose result
 *    is `confirmed_applied` closes the slot as success; `confirmed_not_applied`
 *    clears unknown_outcome, unblocks the tool and keeps the slot open;
 *    `inconclusive` keeps unknown_outcome set. Reconciliation is itself charged.
 *  - If allowance reaches 0 while unknown_outcome is true, the machine refuses
 *    all non-recall work: the agent must finalize reporting an unknown outcome,
 *    claiming neither success nor failure, and no new slot may be minted after
 *    that (the machine is terminal).
 */

export const MAX_RECOVERY_ALLOWANCE = 3;

export type DispatchOutcome =
  | 'success'
  | 'invalid_args'
  | 'tool_error'
  | 'timeout'
  | 'exit_code_nonzero';

export type ReconciliationClass =
  | 'confirmed_applied'
  | 'confirmed_not_applied'
  | 'inconclusive';

export type IntentDeclaration = 'repair_of' | 'unrelated' | 'undeclared';

export interface DispatchInput {
  tool: string;
  idempotent: boolean;
  declaration: IntentDeclaration;
  outcome: DispatchOutcome;
  /** Marks this dispatch as an idempotent reconciliation (read/status/verify). */
  isReconciliation?: boolean;
  /** Classification of the reconciliation readback, when applicable. */
  reconciliation?: ReconciliationClass;
}

export type RecoveryEvent =
  | ({ kind: 'dispatch' } & DispatchInput)
  | { kind: 'recall' }
  | { kind: 'replan' }
  | { kind: 'finalize' };

export type Refusal =
  | 'BLOCKED_BY_OPEN_RECOVERY'
  | 'TOOL_BLOCKED_UNKNOWN_OUTCOME'
  | 'MUST_FINALIZE_UNKNOWN_OUTCOME'
  | 'ALLOWANCE_EXHAUSTED'
  | 'NO_RECOVERY_SLOT_AVAILABLE';

export type CloseClaim = 'success' | 'failure' | 'unknown';

export interface SlotSnapshot {
  open: boolean;
  intentId: number | null;
  allowance: number;
  chargedTotal: number;
  unknownOutcome: boolean;
  blockedTools: readonly string[];
  closedAs: CloseClaim | null;
  finalized: boolean;
  /** True once allowance hit 0 with unknown_outcome still set. */
  mustFinalizeUnknown: boolean;
  /** True after finalizing with an unknown claim: no new slot may be minted. */
  terminal: boolean;
}

export interface LogEntry {
  index: number;
  event: RecoveryEvent;
  charged: number;
  effect: string;
  note?: string;
}

export interface ApplyResult {
  refused?: Refusal;
}

export interface MachineOptions {
  /**
   * Policy for unrelated dispatches while a slot is open.
   * 'execute' runs them uncharged (failures logged AMBIGUOUS_INTENT_MERGE);
   * 'block' refuses them outright as BLOCKED_BY_OPEN_RECOVERY.
   */
  unrelatedPolicy?: 'execute' | 'block';
}

interface InternalState {
  open: boolean;
  intentId: number | null;
  allowance: number;
  chargedTotal: number;
  unknownOutcome: boolean;
  blockedTools: string[];
  closedAs: CloseClaim | null;
  finalized: boolean;
  mustFinalizeUnknown: boolean;
  terminal: boolean;
}

const initialState = (): InternalState => ({
  open: false,
  intentId: null,
  allowance: 0,
  chargedTotal: 0,
  unknownOutcome: false,
  blockedTools: [],
  closedAs: null,
  finalized: false,
  mustFinalizeUnknown: false,
  terminal: false,
});

export class RecoverySlotMachine {
  private intentCounter = 0;
  private state: InternalState = initialState();
  private log: LogEntry[] = [];
  private readonly unrelatedPolicy: 'execute' | 'block';

  constructor(options: MachineOptions = {}) {
    this.unrelatedPolicy = options.unrelatedPolicy ?? 'execute';
  }

  getState(): SlotSnapshot {
    const s = this.state;
    return {
      open: s.open,
      intentId: s.intentId,
      allowance: s.allowance,
      chargedTotal: s.chargedTotal,
      unknownOutcome: s.unknownOutcome,
      blockedTools: [...s.blockedTools],
      closedAs: s.closedAs,
      finalized: s.finalized,
      mustFinalizeUnknown: s.mustFinalizeUnknown,
      terminal: s.terminal,
    };
  }

  getLog(): readonly LogEntry[] {
    return this.log;
  }

  apply(event: RecoveryEvent): ApplyResult {
    switch (event.kind) {
      case 'dispatch':
        return this.dispatch(event);
      case 'recall':
        return this.recall();
      case 'replan':
        return this.replan();
      case 'finalize':
        return this.finalize();
    }
  }

  dispatch(input: DispatchInput & { kind?: 'dispatch' }): ApplyResult {
    const event = { ...input, kind: 'dispatch' as const };
    const s = this.state;

    if (s.terminal) {
      return this.record(event, 0, 'refused', {
        note: 'NO_RECOVERY_SLOT_AVAILABLE: unknown-outcome finalize is terminal',
        refused: 'NO_RECOVERY_SLOT_AVAILABLE',
      });
    }

    if (!s.open) {
      if (input.outcome === 'success') {
        return this.record(event, 0, 'no-slot-success');
      }
      // Mint a fresh slot on a failure with no slot open. The minting attempt
      // itself consumes one unit of the shared allowance.
      this.intentCounter += 1;
      s.open = true;
      s.intentId = this.intentCounter;
      s.allowance = MAX_RECOVERY_ALLOWANCE - 1;
      s.chargedTotal = 1;
      s.unknownOutcome = false;
      s.blockedTools = [];
      s.closedAs = null;
      s.finalized = false;
      s.mustFinalizeUnknown = false;
      if (input.outcome === 'timeout' && !input.idempotent) {
        s.unknownOutcome = true;
        s.blockedTools.push(input.tool);
      }
      return this.record(event, 1, 'slot-opened', {
        note: `intent_id=${s.intentId} allowance_left=${s.allowance}` +
          (s.unknownOutcome ? ' unknown_outcome=true' : ''),
      });
    }

    // A slot is open: intent must be declared.
    if (input.declaration === 'unrelated' || input.declaration === 'undeclared') {
      if (input.declaration === 'unrelated' && this.unrelatedPolicy === 'block') {
        return this.record(event, 0, 'refused', {
          note: 'BLOCKED_BY_OPEN_RECOVERY: finalize the open slot before new tasks',
          refused: 'BLOCKED_BY_OPEN_RECOVERY',
        });
      }
      const ambiguous = input.outcome !== 'success';
      return this.record(event, 0, ambiguous ? 'ambiguous-intent-merge' : 'unrelated-not-charged', {
        note: ambiguous
          ? 'AMBIGUOUS_INTENT_MERGE: failure not charged to the open slot'
          : 'unrelated success does not close the open slot',
      });
    }

    // declaration === 'repair_of': charged path.
    if (s.mustFinalizeUnknown) {
      return this.record(event, 0, 'refused', {
        note: 'MUST_FINALIZE_UNKNOWN_OUTCOME: allowance exhausted with unknown outcome',
        refused: 'MUST_FINALIZE_UNKNOWN_OUTCOME',
      });
    }
    if (s.allowance <= 0) {
      return this.record(event, 0, 'refused', {
        note: 'ALLOWANCE_EXHAUSTED: finalize the slot',
        refused: 'ALLOWANCE_EXHAUSTED',
      });
    }
    if (
      !input.isReconciliation &&
      !input.idempotent &&
      s.blockedTools.includes(input.tool)
    ) {
      return this.record(event, 0, 'refused', {
        note: `TOOL_BLOCKED_UNKNOWN_OUTCOME: non-idempotent dispatch of ${input.tool} blocked`,
        refused: 'TOOL_BLOCKED_UNKNOWN_OUTCOME',
      });
    }

    // Charge one unit of the shared allowance.
    s.allowance -= 1;
    s.chargedTotal += 1;
    const charged = 1;

    if (input.isReconciliation) {
      // Reconciliation of the reconciliation: a reconciliation that itself
      // times out (or is non-idempotent) is classified inconclusive — the
      // unknown outcome persists.
      const cls: ReconciliationClass =
        input.outcome === 'timeout'
          ? 'inconclusive'
          : input.reconciliation ?? 'inconclusive';
      if (cls === 'confirmed_applied') {
        s.unknownOutcome = false;
        s.blockedTools = [];
        s.open = false;
        s.closedAs = 'success';
        s.finalized = true;
        return this.record(event, charged, 'slot-closed', {
          note: 'confirmed_applied: reconciliation counts as true success of the intent',
        });
      }
      if (cls === 'confirmed_not_applied') {
        s.unknownOutcome = false;
        s.blockedTools = [];
        return this.record(event, charged, 'reconciliation-confirmed-not-applied', {
          note: `unknown cleared, tool unblocked, slot open, allowance_left=${s.allowance}`,
        });
      }
      // inconclusive
      if (s.allowance === 0 && s.unknownOutcome) s.mustFinalizeUnknown = true;
      return this.record(event, charged, 'reconciliation-inconclusive', {
        note: 'unknown_outcome retained' +
          (s.mustFinalizeUnknown ? '; must finalize reporting unknown' : ''),
      });
    }

    if (input.outcome === 'success') {
      s.unknownOutcome = false;
      s.blockedTools = [];
      s.open = false;
      s.closedAs = 'success';
      s.finalized = true;
      return this.record(event, charged, 'slot-closed', {
        note: 'true success of the intent',
      });
    }

    if (input.outcome === 'timeout' && !input.idempotent) {
      s.unknownOutcome = true;
      if (!s.blockedTools.includes(input.tool)) s.blockedTools.push(input.tool);
      if (s.allowance === 0) s.mustFinalizeUnknown = true;
      return this.record(event, charged, 'unknown-outcome-set', {
        note: `non-idempotent timeout on ${input.tool}; same-tool non-idempotent dispatch blocked`,
      });
    }

    // Known failure (invalid_args, tool_error, idempotent timeout, or
    // run_code outer ok but exit_code != 0): slot stays open.
    if (s.allowance === 0 && s.unknownOutcome) s.mustFinalizeUnknown = true;
    return this.record(event, charged, 'failure-slot-open', {
      note: `known failure (${input.outcome}); allowance_left=${s.allowance}`,
    });
  }

  recall(): ApplyResult {
    return this.record({ kind: 'recall' }, 0, 'recall-free', {
      note: 'recall is always free and never mutates slot state',
    });
  }

  replan(): ApplyResult {
    return this.record({ kind: 'replan' }, 0, 'replan-no-reset', {
      note: 'replanning cannot reset the slot, allowance, or unknown_outcome',
    });
  }

  finalize(): ApplyResult {
    const s = this.state;
    if (!s.open) {
      return this.record({ kind: 'finalize' }, 0, 'finalize-no-slot');
    }
    const claim: CloseClaim = s.unknownOutcome ? 'unknown' : 'failure';
    s.closedAs = claim;
    s.open = false;
    s.finalized = true;
    if (claim === 'unknown') s.terminal = true;
    return this.record({ kind: 'finalize' }, 0, 'slot-closed', {
      note: `finalize claim=${claim}` +
        (claim === 'unknown'
          ? '; no success/failure claim, no new slot may be minted'
          : ''),
    });
  }

  private record(
    event: RecoveryEvent,
    charged: number,
    effect: string,
    extra: { note?: string; refused?: Refusal } = {},
  ): ApplyResult {
    this.log.push({
      index: this.log.length,
      event,
      charged,
      effect,
      note: extra.note,
    });
    return extra.refused ? { refused: extra.refused } : {};
  }
}

/** Deterministic seeded PRNG (mulberry32) for the fuzz harness. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
