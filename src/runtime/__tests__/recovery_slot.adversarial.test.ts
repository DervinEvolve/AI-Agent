import { describe, it, expect } from 'vitest';
import {
  RecoverySlotMachine,
  MAX_RECOVERY_ALLOWANCE,
  type RecoveryEvent,
} from '../recovery_slot';

describe('recovery slot: intent binding (unrelated-failure rule)', () => {
  it('an unrelated failure while a slot is open is never charged and is logged AMBIGUOUS_INTENT_MERGE', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'write_file',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    const before = m.getState();
    const res = m.apply({
      kind: 'dispatch',
      tool: 'delegate_task',
      idempotent: false,
      declaration: 'unrelated',
      outcome: 'tool_error',
    });
    expect(res.refused).toBeUndefined();
    const after = m.getState();
    expect(after.allowance).toBe(before.allowance);
    expect(after.chargedTotal).toBe(before.chargedTotal);
    expect(after.open).toBe(true);
    expect(after.intentId).toBe(before.intentId);
    const entry = m.getLog()[m.getLog().length - 1];
    expect(entry.effect).toBe('ambiguous-intent-merge');
    expect(entry.note).toContain('AMBIGUOUS_INTENT_MERGE');
    expect(entry.charged).toBe(0);
  });

  it('an undeclared failure while a slot is open is also AMBIGUOUS_INTENT_MERGE and uncharged', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'write_file',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    const before = m.getState();
    m.apply({
      kind: 'dispatch',
      tool: 'http_post',
      idempotent: false,
      declaration: 'undeclared',
      outcome: 'invalid_args',
    });
    expect(m.getState().allowance).toBe(before.allowance);
    expect(m.getLog().at(-1)?.effect).toBe('ambiguous-intent-merge');
  });

  it('an unrelated success does not close the open slot', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'write_file',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    m.apply({
      kind: 'dispatch',
      tool: 'read_file',
      idempotent: true,
      declaration: 'unrelated',
      outcome: 'success',
    });
    expect(m.getState().open).toBe(true);
  });

  it('block policy refuses unrelated work as BLOCKED_BY_OPEN_RECOVERY without charging', () => {
    const m = new RecoverySlotMachine({ unrelatedPolicy: 'block' });
    m.apply({
      kind: 'dispatch',
      tool: 'write_file',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    const before = m.getState();
    const res = m.apply({
      kind: 'dispatch',
      tool: 'search',
      idempotent: true,
      declaration: 'unrelated',
      outcome: 'success',
    });
    expect(res.refused).toBe('BLOCKED_BY_OPEN_RECOVERY');
    expect(m.getState().allowance).toBe(before.allowance);
  });

  it('a repair_of dispatch inherits the open intent and consumes allowance', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'write_file',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    const id = m.getState().intentId;
    m.apply({
      kind: 'dispatch',
      tool: 'write_file',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'tool_error',
    });
    expect(m.getState().intentId).toBe(id);
    expect(m.getState().chargedTotal).toBe(2);
  });
});

describe('recovery slot: reconciliation close path', () => {
  it('confirmed_applied closes the slot as true success', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    expect(m.getState().unknownOutcome).toBe(true);
    m.apply({
      kind: 'dispatch',
      tool: 'get_status',
      idempotent: true,
      declaration: 'repair_of',
      outcome: 'success',
      isReconciliation: true,
      reconciliation: 'confirmed_applied',
    });
    const s = m.getState();
    expect(s.open).toBe(false);
    expect(s.closedAs).toBe('success');
    expect(s.unknownOutcome).toBe(false);
    expect(s.blockedTools).toHaveLength(0);
  });

  it('confirmed_not_applied clears unknown, unblocks the tool, keeps the slot open with retry budget', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    m.apply({
      kind: 'dispatch',
      tool: 'get_status',
      idempotent: true,
      declaration: 'repair_of',
      outcome: 'success',
      isReconciliation: true,
      reconciliation: 'confirmed_not_applied',
    });
    const s = m.getState();
    expect(s.open).toBe(true);
    expect(s.unknownOutcome).toBe(false);
    expect(s.blockedTools).toHaveLength(0);
    // One unit spent on the mint + one on reconciliation; retry still has budget.
    expect(s.allowance).toBe(MAX_RECOVERY_ALLOWANCE - 2);
    // The retry of the previously timed-out tool is now legal.
    const res = m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'success',
    });
    expect(res.refused).toBeUndefined();
    expect(m.getState().closedAs).toBe('success');
  });

  it('inconclusive reconciliation keeps unknown set and eventually forces finalize-unknown instead of draining forever', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    // Reconciliation attempts: each charged, each inconclusive.
    for (let i = 0; i < 2; i++) {
      m.apply({
        kind: 'dispatch',
        tool: 'get_status',
        idempotent: true,
        declaration: 'repair_of',
        outcome: 'success',
        isReconciliation: true,
        reconciliation: 'inconclusive',
      });
    }
    const s = m.getState();
    expect(s.allowance).toBe(0);
    expect(s.unknownOutcome).toBe(true);
    expect(s.mustFinalizeUnknown).toBe(true);
    // Further reconciliation is refused: no more allowance drain.
    const res = m.apply({
      kind: 'dispatch',
      tool: 'get_status',
      idempotent: true,
      declaration: 'repair_of',
      outcome: 'success',
      isReconciliation: true,
      reconciliation: 'inconclusive',
    });
    expect(res.refused).toBe('MUST_FINALIZE_UNKNOWN_OUTCOME');
    expect(m.getState().chargedTotal).toBe(MAX_RECOVERY_ALLOWANCE);
  });

  it('a reconciliation that itself times out is classified inconclusive (reconciliation of the reconciliation)', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    m.apply({
      kind: 'dispatch',
      tool: 'get_status',
      idempotent: true,
      declaration: 'repair_of',
      outcome: 'timeout',
      isReconciliation: true,
    });
    expect(m.getState().unknownOutcome).toBe(true);
    expect(m.getLog().at(-1)?.effect).toBe('reconciliation-inconclusive');
  });
});

describe('recovery slot: exhaustion with unknown outcome', () => {
  it('allowance 0 with unknown_outcome forces finalize reporting unknown, claiming neither success nor failure', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    const s = m.getState();
    expect(s.allowance).toBe(0);
    expect(s.unknownOutcome).toBe(true);
    expect(s.mustFinalizeUnknown).toBe(true);
    // Non-recall work is refused.
    expect(
      m.apply({
        kind: 'dispatch',
        tool: 'anything',
        idempotent: true,
        declaration: 'repair_of',
        outcome: 'success',
      }).refused,
    ).toBe('MUST_FINALIZE_UNKNOWN_OUTCOME');
    // Recall stays free.
    expect(m.apply({ kind: 'recall' }).refused).toBeUndefined();
    expect(m.getState().mustFinalizeUnknown).toBe(true);
    // Finalize claims unknown.
    m.apply({ kind: 'finalize' });
    expect(m.getState().closedAs).toBe('unknown');
  });

  it('after an unknown finalize no new slot may be minted (machine is terminal)', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    m.apply({ kind: 'finalize' });
    expect(m.getState().terminal).toBe(true);
    const res = m.apply({
      kind: 'dispatch',
      tool: 'fresh_task',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'tool_error',
    });
    expect(res.refused).toBe('NO_RECOVERY_SLOT_AVAILABLE');
    expect(m.getState().open).toBe(false);
  });

  it('a failure finalize (known outcome) does allow a later slot to be minted', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'write_file',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'tool_error',
    });
    m.apply({ kind: 'finalize' });
    expect(m.getState().closedAs).toBe('failure');
    const res = m.apply({
      kind: 'dispatch',
      tool: 'other_task',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'tool_error',
    });
    expect(res.refused).toBeUndefined();
    expect(m.getState().open).toBe(true);
    expect(m.getState().intentId).not.toBeNull();
  });
});

describe('recovery slot: baseline rules stay intact', () => {
  it('non-idempotent timeout blocks same-tool non-idempotent dispatch but allows idempotent calls', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    const blocked = m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'success',
    });
    expect(blocked.refused).toBe('TOOL_BLOCKED_UNKNOWN_OUTCOME');
    const idem = m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: true,
      declaration: 'repair_of',
      outcome: 'success',
    });
    expect(idem.refused).toBeUndefined();
  });

  it('run_code outer ok but exit_code != 0 is a known failure that keeps the slot open', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'run_code',
      idempotent: true,
      declaration: 'repair_of',
      outcome: 'exit_code_nonzero',
    });
    const s = m.getState();
    expect(s.open).toBe(true);
    expect(s.unknownOutcome).toBe(false);
    expect(m.getLog().at(-1)?.effect).toBe('failure-slot-open');
  });

  it('replan never resets the slot, allowance, or unknown_outcome', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    const before = JSON.stringify(m.getState());
    m.apply({ kind: 'replan' });
    m.apply({ kind: 'replan' });
    expect(JSON.stringify(m.getState())).toBe(before);
    expect(m.getLog().at(-1)?.effect).toBe('replan-no-reset');
  });

  it('recall is free and never mutates state, even at allowance 0 with unknown outcome', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    const before = JSON.stringify(m.getState());
    const res = m.apply({ kind: 'recall' });
    expect(res.refused).toBeUndefined();
    expect(JSON.stringify(m.getState())).toBe(before);
    expect(m.getLog().at(-1)?.charged).toBe(0);
  });

  it('slot closes only on true success or finalize — success of an unrelated dispatch never closes it', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'write_file',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'tool_error',
    });
    m.apply({
      kind: 'dispatch',
      tool: 'search',
      idempotent: true,
      declaration: 'unrelated',
      outcome: 'success',
    });
    m.apply({
      kind: 'dispatch',
      tool: 'search',
      idempotent: true,
      declaration: 'undeclared',
      outcome: 'success',
    });
    expect(m.getState().open).toBe(true);
    m.apply({
      kind: 'dispatch',
      tool: 'write_file',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'success',
    });
    expect(m.getState().closedAs).toBe('success');
    expect(m.getState().open).toBe(false);
  });

  it('delegate_task child failure must declare intent: unrelated is uncharged, repair_of is charged', () => {
    const uncharged = new RecoverySlotMachine();
    uncharged.apply({
      kind: 'dispatch',
      tool: 'write_file',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    const before = uncharged.getState().allowance;
    uncharged.apply({
      kind: 'dispatch',
      tool: 'delegate_task',
      idempotent: false,
      declaration: 'unrelated',
      outcome: 'tool_error',
    });
    expect(uncharged.getState().allowance).toBe(before);

    const charged = new RecoverySlotMachine();
    charged.apply({
      kind: 'dispatch',
      tool: 'write_file',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    const before2 = charged.getState().allowance;
    charged.apply({
      kind: 'dispatch',
      tool: 'delegate_task',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'tool_error',
    });
    expect(charged.getState().allowance).toBe(before2 - 1);
    expect(charged.getState().intentId).not.toBeNull();
  });
});
