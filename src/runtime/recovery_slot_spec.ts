/**
 * Reference state machine for the single recovery-slot specification.
 *
 * Rules implemented (see docs/recovery-slot-fuzz-findings.md):
 *  (1) One open failure slot, opened by the first non-success outcome, carrying
 *      intent_id, origin_call_id and remaining=3. Only repair / retry /
 *      alternative / reconciliation dispatches for that intent consume
 *      allowance. recall is free and never touches the slot. replan never
 *      resets the slot.
 *  (2) A reconciliation dispatch is charged one allowance when dispatched. If
 *      the reconciliation call itself fails, the failure is absorbed into the
 *      SAME slot: no extra allowance, no nested slot. A second independent
 *      failure arriving while a slot is open is attached as a sub-failure.
 *      Independent work is refused until the slot closes.
 *  (3) The slot closes only on true success of a repair, or on finalize.
 *      At allowance 0 all recovery dispatches are refused (must finalize with
 *      an explicit failure report).
 *  (4) A truncated output while the slot is open triggers the auto-inserted
 *      recall step, which is free. truncated_success is not a true success and
 *      does not close the slot.
 *  (5) Non-idempotent timeouts refuse same-tool redispatch (outcome unknown,
 *      liability reservation persists even after the slot closes, until a
 *      reconciliation succeeds or the episode finalizes). run_code is true
 *      success only if completed AND exit_code==0 AND termination_confirmed,
 *      and is redispatchable only after termination_confirmed and
 *      cleanup_confirmed.
 *  (6) delegate_task is refused while a slot is open or an outcome is unknown.
 *
 * The machine is a pure function over (state, event) so the property-based
 * fuzzer in recovery_slot_fuzzer.ts can cross-check it against the invariants.
 */

export type DispatchKind =
  | 'repair'
  | 'retry'
  | 'alternative'
  | 'reconciliation'
  | 'independent';

export type FailureCode = 'invalid_args' | 'rejected' | 'unknown_tool' | 'timeout';

export type Outcome =
  | { kind: 'success' }
  | { kind: 'failure'; code: FailureCode }
  | { kind: 'truncated_success' }
  | {
      kind: 'run_code';
      completed: boolean;
      exitCode: number;
      terminationConfirmed: boolean;
      cleanupConfirmed: boolean;
    };

export type SlotEvent =
  | {
      type: 'dispatch';
      tool: string;
      idempotent: boolean;
      kind: DispatchKind;
      intentId: string;
      callId: string;
    }
  | { type: 'outcome'; callId: string; outcome: Outcome }
  | { type: 'external_failure'; callId: string; intentId: string }
  | {
      type: 'termination_report';
      callId: string;
      terminationConfirmed: boolean;
      cleanupConfirmed: boolean;
    }
  | { type: 'recall' }
  | { type: 'replan' }
  | { type: 'delegate_request' }
  | { type: 'finalize'; successClaim: boolean };

/** Tags for cases the prose spec leaves undecidable; each becomes a spec-clarification entry. */
export type GapTag =
  | 'truncated_reconciliation_undecidable'
  | 'subfailure_unknown_at_close'
  | 'success_claim_without_true_success';

export type DecisionAction =
  | 'admitted'
  | 'refused'
  | 'free'
  | 'absorbed'
  | 'attached'
  | 'opened'
  | 'closed'
  | 'finalized'
  | 'ignored';

export interface Decision {
  eventType: string;
  action: DecisionAction;
  reason: string;
  gap?: GapTag;
}

export interface SubFailure {
  callId: string;
  settled: boolean;
}

export interface RecoverySlot {
  intentId: string;
  originCallId: string;
  remaining: number;
  subFailures: SubFailure[];
}

export interface AdmittedCall {
  tool: string;
  idempotent: boolean;
  kind: DispatchKind;
  intentId: string;
}

export interface MachineState {
  slot: RecoverySlot | null;
  /** Liability reservation: an unknown outcome for a non-idempotent tool. */
  nonIdemTimeoutTool: string | null;
  outcomeUnknown: boolean;
  pendingRunCode: { terminationConfirmed: boolean; cleanupConfirmed: boolean } | null;
  finalized: boolean;
  hadTrueSuccess: boolean;
  admitted: Record<string, AdmittedCall>;
  decisions: Decision[];
  gaps: GapTag[];
}

export function initialSlotState(): MachineState {
  return {
    slot: null,
    nonIdemTimeoutTool: null,
    outcomeUnknown: false,
    pendingRunCode: null,
    finalized: false,
    hadTrueSuccess: false,
    admitted: {},
    decisions: [],
    gaps: [],
  };
}

export function classifyOutcome(o: Outcome): 'true_success' | 'failure' | 'truncated' | 'unknown' {
  if (o.kind === 'success') return 'true_success';
  if (o.kind === 'failure') return 'failure';
  if (o.kind === 'truncated_success') return 'truncated';
  // run_code
  if (o.completed && o.exitCode === 0 && o.terminationConfirmed) return 'true_success';
  if (!o.terminationConfirmed) return 'unknown';
  return 'failure'; // completed with nonzero exit, or uncompleted but terminated
}

export function isRunCodeTrueSuccess(o: Extract<Outcome, { kind: 'run_code' }>): boolean {
  return o.completed && o.exitCode === 0 && o.terminationConfirmed;
}

const RECOVERY_KINDS: DispatchKind[] = ['repair', 'retry', 'alternative', 'reconciliation'];

export function isRecoveryKind(kind: DispatchKind): boolean {
  return RECOVERY_KINDS.includes(kind);
}

/** Pure transition function: (state, event) -> next state. */
export function step(prev: MachineState, ev: SlotEvent): MachineState {
  const s: MachineState = {
    slot: prev.slot
      ? { ...prev.slot, subFailures: prev.slot.subFailures.slice() }
      : null,
    nonIdemTimeoutTool: prev.nonIdemTimeoutTool,
    outcomeUnknown: prev.outcomeUnknown,
    pendingRunCode: prev.pendingRunCode,
    finalized: prev.finalized,
    hadTrueSuccess: prev.hadTrueSuccess,
    admitted: { ...prev.admitted },
    decisions: prev.decisions.slice(),
    gaps: prev.gaps.slice(),
  };

  const record = (action: DecisionAction, reason: string, gap?: GapTag) => {
    s.decisions.push({ eventType: ev.type, action, reason, gap });
    if (gap) s.gaps.push(gap);
  };

  // After finalize the episode is over; recall is still free (it is always free).
  if (s.finalized && ev.type !== 'recall') {
    record('refused', 'episode already finalized');
    return s;
  }

  switch (ev.type) {
    case 'recall': {
      // Rule (1)/(4): recall is free, never touches the slot, never resets or
      // refills allowance. The plan revision it produces is advisory.
      record('free', 'recall is free and never touches the slot');
      return s;
    }

    case 'replan': {
      // Rule (1): replan never resets the slot.
      record('admitted', 'replan accepted; slot untouched (plan revision is advisory)');
      return s;
    }

    case 'delegate_request': {
      // Rule (5)/(6): refused while a slot is open or an outcome is unknown.
      if (s.slot) {
        record('refused', 'delegate_task refused: recovery slot is open');
      } else if (s.outcomeUnknown) {
        record('refused', 'delegate_task refused: an outcome is unknown (liability reservation)');
      } else {
        record('admitted', 'delegate_task allowed');
      }
      return s;
    }

    case 'external_failure': {
      // Rule (2): a second independent failure while a slot is open is attached
      // as a sub-failure (logged with its call_id), no new slot, no fresh
      // allowance. With no slot open, it is the first failure and opens one.
      if (s.slot) {
        s.slot = {
          ...s.slot,
          subFailures: [...s.slot.subFailures, { callId: ev.callId, settled: false }],
        };
        record('attached', `independent failure ${ev.callId} attached as sub-failure to the open slot`);
      } else {
        s.slot = {
          intentId: ev.intentId,
          originCallId: ev.callId,
          remaining: 3,
          subFailures: [],
        };
        s.outcomeUnknown = true;
        record('opened', `first failure ${ev.callId} opened the recovery slot (allowance 3)`);
      }
      return s;
    }

    case 'termination_report': {
      if (ev.terminationConfirmed && ev.cleanupConfirmed) {
        s.pendingRunCode = null;
        if (s.nonIdemTimeoutTool === null) s.outcomeUnknown = false;
        record('admitted', 'termination and cleanup confirmed; run_code redispatchable');
      } else {
        record('ignored', 'termination report without full confirmation changes nothing');
      }
      return s;
    }

    case 'dispatch': {
      // Rule (2): independent work is refused while a slot is open.
      if (s.slot && ev.kind === 'independent') {
        record('refused', 'independent work refused while the recovery slot is open');
        return s;
      }
      // Rule (5): non-idempotent timeout refuses same-tool redispatch while
      // the outcome is unknown (settlement before retry).
      if (s.nonIdemTimeoutTool === ev.tool && !ev.idempotent) {
        record(
          'refused',
          `non-idempotent timeout on ${ev.tool}: same-tool redispatch refused (outcome unknown)`,
        );
        return s;
      }
      // Rule (5): run_code is redispatchable only after termination and cleanup
      // are confirmed.
      if (ev.tool === 'run_code' && s.pendingRunCode) {
        record('refused', 'run_code redispatch refused: termination/cleanup unconfirmed');
        return s;
      }
      // Rule (3): at allowance 0 all recovery dispatches are refused.
      if (s.slot && isRecoveryKind(ev.kind)) {
        if (s.slot.remaining <= 0) {
          record('refused', 'allowance exhausted; must finalize with an explicit failure report');
          return s;
        }
        // Rule (1)/(2): repair / retry / alternative / reconciliation consume
        // one allowance at dispatch (admission, not success).
        s.slot = { ...s.slot, remaining: s.slot.remaining - 1 };
      }
      s.admitted[ev.callId] = {
        tool: ev.tool,
        idempotent: ev.idempotent,
        kind: ev.kind,
        intentId: ev.intentId,
      };
      record(
        'admitted',
        s.slot
          ? `recovery dispatch admitted and charged (remaining=${s.slot.remaining})`
          : 'ordinary dispatch admitted (no slot open)',
      );
      return s;
    }

    case 'outcome': {
      const info = s.admitted[ev.callId];
      if (!info) {
        record('ignored', 'outcome for a call that was not admitted');
        return s;
      }
      const cls = classifyOutcome(ev.outcome);

      if (cls === 'true_success') {
        s.hadTrueSuccess = true;
        if (info.kind === 'reconciliation') {
          // Settlement: a successful idempotent read establishes the outcome,
          // releasing the liability reservation.
          s.nonIdemTimeoutTool = null;
          if (!s.pendingRunCode) s.outcomeUnknown = false;
        }
        if (s.slot && info.kind !== 'independent') {
          const unsettled = s.slot.subFailures.filter((f) => !f.settled);
          if (unsettled.length > 0) {
            record(
              'closed',
              'repair success closed the slot',
              'subfailure_unknown_at_close',
            );
          } else {
            record('closed', 'true success of the repair closed the slot');
          }
          s.slot = null;
        } else {
          record('admitted', 'true success recorded (no open slot to close)');
        }
        return s;
      }

      if (cls === 'truncated') {
        // Rule (4): truncated_success is not a true success and does not close
               // the slot; the auto-inserted recall step is free.
        if (s.slot && info.kind === 'reconciliation') {
          // Undecidable in the prose spec: a truncated reconciliation output is
          // neither a clean failure (rule 2: absorbed, no extra allowance) nor
          // a success (rule 4: does not close the slot). The machine resolves
          // it as absorbed-without-closure and flags the gap.
          s.slot = {
            ...s.slot,
            subFailures: [...s.slot.subFailures, { callId: ev.callId, settled: false }],
          };
          record(
            'absorbed',
            'truncated reconciliation absorbed into the same slot; slot stays open',
            'truncated_reconciliation_undecidable',
          );
        } else if (s.slot) {
          record(
            'admitted',
            'truncated_success is not a true success; slot stays open; auto-inserted recall step is free',
          );
        } else {
          s.slot = {
            intentId: info.intentId,
            originCallId: ev.callId,
            remaining: 3,
            subFailures: [],
          };
          record('opened', 'truncated output with no open slot opened a slot (non-success outcome)');
        }
        return s;
      }

      if (cls === 'unknown') {
        // run_code with unconfirmed termination.
        const o = ev.outcome as Extract<Outcome, { kind: 'run_code' }>;
        s.outcomeUnknown = true;
        s.pendingRunCode = {
          terminationConfirmed: o.terminationConfirmed,
          cleanupConfirmed: o.cleanupConfirmed,
        };
        if (!s.slot) {
          s.slot = {
            intentId: info.intentId,
            originCallId: ev.callId,
            remaining: 3,
            subFailures: [],
          };
          record('opened', 'unconfirmed termination opened the recovery slot (outcome unknown)');
        } else {
          record('admitted', 'unconfirmed termination; slot stays open, outcome unknown');
        }
        return s;
      }

      // Plain failure.
      const o = ev.outcome as Extract<Outcome, { kind: 'failure' }>;
      if (!info.idempotent && o.code === 'timeout') {
        s.nonIdemTimeoutTool = info.tool;
        s.outcomeUnknown = true;
      }
      if (!s.slot) {
        s.slot = {
          intentId: info.intentId,
          originCallId: ev.callId,
          remaining: 3,
          subFailures: [],
        };
        record('opened', `first non-success outcome ${ev.callId} opened the slot (allowance 3)`);
      } else if (info.kind === 'reconciliation' || info.kind === 'independent') {
        // Rule (2): reconciliation failure absorbed into the same slot — no
        // extra allowance beyond the dispatch charge, no nested slot. A late
        // independent failure is likewise attached as a sub-failure.
        s.slot = {
          ...s.slot,
          subFailures: [...s.slot.subFailures, { callId: ev.callId, settled: false }],
        };
        record(
          'absorbed',
          `${info.kind} failure ${ev.callId} absorbed into the same slot as a sub-failure (no extra allowance, no nested slot)`,
        );
      } else {
        record('admitted', 'failure during recovery; slot stays open (allowance already charged at dispatch)');
      }
      return s;
    }

    case 'finalize': {
      s.finalized = true;
      if (ev.successClaim && !s.hadTrueSuccess) {
        record('finalized', 'finalize with success claim but no true success on record',
          'success_claim_without_true_success');
      } else {
        record('finalized', ev.successClaim ? 'finalize with a justified success claim' : 'finalize with explicit failure report');
      }
      if (s.slot) {
        record('closed', 'finalize closed the slot without a success claim');
        s.slot = null;
      }
      s.outcomeUnknown = false;
      s.nonIdemTimeoutTool = null;
      s.pendingRunCode = null;
      return s;
    }
  }
}
