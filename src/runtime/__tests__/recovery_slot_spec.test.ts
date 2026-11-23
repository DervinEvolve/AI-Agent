import { describe, it, expect } from 'vitest';
import {
  step,
  initialSlotState,
  classifyOutcome,
  isRunCodeTrueSuccess,
  type MachineState,
  type SlotEvent,
} from '../recovery_slot_spec';

function run(events: SlotEvent[]): MachineState {
  return events.reduce(step, initialSlotState());
}

const lastDecision = (s: MachineState) => s.decisions[s.decisions.length - 1];

const openSlot: SlotEvent = {
  type: 'external_failure',
  callId: 'x0',
  intentId: 'intent-1',
};

describe('recovery slot reference machine', () => {
  it('opens a single slot on the first non-success outcome with allowance 3', () => {
    const s = run([
      openSlot,
      {
        type: 'dispatch',
        tool: 'http_post',
        idempotent: false,
        kind: 'retry',
        intentId: 'intent-1',
        callId: 'c1',
      },
    ]);
    expect(s.slot).not.toBeNull();
    expect(s.slot?.intentId).toBe('intent-1');
    expect(s.slot?.originCallId).toBe('x0');
    expect(s.slot?.remaining).toBe(2); // charged at admission
  });

  it('invariant 1: recall is free and never changes allowance', () => {
    const s = run([openSlot, { type: 'recall' }, { type: 'recall' }]);
    expect(s.slot?.remaining).toBe(3);
    expect(lastDecision(s).action).toBe('free');
  });

  it('invariant 2: replan never resets or closes the slot', () => {
    const s = run([
      openSlot,
      {
        type: 'dispatch',
        tool: 'http_get',
        idempotent: true,
        kind: 'repair',
        intentId: 'intent-1',
        callId: 'c1',
      },
      { type: 'replan' },
    ]);
    expect(s.slot).not.toBeNull();
    expect(s.slot?.remaining).toBe(2);
  });

  it('invariant 3: exhausted allowance refuses every recovery dispatch', () => {
    const exhaust: SlotEvent[] = [openSlot];
    for (let i = 0; i < 3; i++) {
      exhaust.push({
        type: 'dispatch',
        tool: 'http_get',
        idempotent: true,
        kind: 'repair',
        intentId: 'intent-1',
        callId: 'c' + i,
      });
    }
    const s0 = run(exhaust);
    expect(s0.slot?.remaining).toBe(0);
    const s = step(s0, {
      type: 'dispatch',
      tool: 'search',
      idempotent: true,
      kind: 'alternative',
      intentId: 'intent-1',
      callId: 'c9',
    });
    expect(lastDecision(s).action).toBe('refused');
    expect(s.slot?.remaining).toBe(0);
    expect(s.admitted['c9']).toBeUndefined();
  });

  it('invariant 4: non-idempotent timeout refuses same-tool redispatch, different tool is fine', () => {
    const timeout: SlotEvent[] = [
      {
        type: 'dispatch',
        tool: 'http_post',
        idempotent: false,
        kind: 'independent',
        intentId: 'intent-1',
        callId: 'c0',
      },
      { type: 'outcome', callId: 'c0', outcome: { kind: 'failure', code: 'timeout' } },
    ];
    const s0 = run(timeout);
    expect(s0.slot).not.toBeNull();
    expect(s0.outcomeUnknown).toBe(true);
    const same = step(s0, {
      type: 'dispatch',
      tool: 'http_post',
      idempotent: false,
      kind: 'retry',
      intentId: 'intent-1',
      callId: 'c1',
    });
    expect(lastDecision(same).action).toBe('refused');
    const other = step(s0, {
      type: 'dispatch',
      tool: 'write_file',
      idempotent: false,
      kind: 'alternative',
      intentId: 'intent-1',
      callId: 'c2',
    });
    expect(lastDecision(other).action).toBe('admitted');
  });

  it('a successful reconciliation settles the unknown and releases the reservation', () => {
    const s = run([
      {
        type: 'dispatch',
        tool: 'http_post',
        idempotent: false,
        kind: 'independent',
        intentId: 'intent-1',
        callId: 'c0',
      },
      { type: 'outcome', callId: 'c0', outcome: { kind: 'failure', code: 'timeout' } },
      {
        type: 'dispatch',
        tool: 'http_get',
        idempotent: true,
        kind: 'reconciliation',
        intentId: 'intent-1',
        callId: 'c1',
      },
      { type: 'outcome', callId: 'c1', outcome: { kind: 'success' } },
    ]);
    expect(s.outcomeUnknown).toBe(false);
    expect(s.nonIdemTimeoutTool).toBeNull();
    expect(s.slot).toBeNull(); // true success of the repair closed the slot
  });

  it('rule 2: a failed reconciliation is absorbed into the same slot (no extra allowance, no nested slot)', () => {
    const s = run([
      openSlot, // remaining 3
      {
        type: 'dispatch',
        tool: 'http_get',
        idempotent: true,
        kind: 'reconciliation',
        intentId: 'intent-1',
        callId: 'c1',
      }, // charged -> remaining 2
      { type: 'outcome', callId: 'c1', outcome: { kind: 'failure', code: 'invalid_args' } },
    ]);
    expect(s.slot?.remaining).toBe(2); // no extra charge for the failure itself
    expect(s.slot?.subFailures).toEqual([{ callId: 'c1', settled: false }]);
    expect(lastDecision(s).action).toBe('absorbed');
  });

  it('rule 2: a second independent failure attaches as a sub-failure with no new slot or allowance', () => {
    const s = run([openSlot, { type: 'external_failure', callId: 'x1', intentId: 'intent-2' }]);
    expect(s.slot?.remaining).toBe(3);
    expect(s.slot?.subFailures).toEqual([{ callId: 'x1', settled: false }]);
    expect(lastDecision(s).action).toBe('attached');
  });

  it('rule 2: independent dispatch is refused while the slot is open', () => {
    const s = step(run([openSlot]), {
      type: 'dispatch',
      tool: 'search',
      idempotent: true,
      kind: 'independent',
      intentId: 'intent-2',
      callId: 'c1',
    });
    expect(lastDecision(s).action).toBe('refused');
  });

  it('rule 4: truncated_success is not a true success and does not close the slot', () => {
    const s = run([
      openSlot,
      {
        type: 'dispatch',
        tool: 'http_get',
        idempotent: true,
        kind: 'repair',
        intentId: 'intent-1',
        callId: 'c1',
      },
      { type: 'outcome', callId: 'c1', outcome: { kind: 'truncated_success' } },
    ]);
    expect(s.slot).not.toBeNull();
    expect(lastDecision(s).reason).toContain('auto-inserted recall step is free');
  });

  it('rule 4 (gap): a truncated reconciliation is flagged as undecidable and absorbed without closing', () => {
    const s = run([
      openSlot,
      {
        type: 'dispatch',
        tool: 'http_get',
        idempotent: true,
        kind: 'reconciliation',
        intentId: 'intent-1',
        callId: 'c1',
      },
      { type: 'outcome', callId: 'c1', outcome: { kind: 'truncated_success' } },
    ]);
    expect(s.slot).not.toBeNull();
    expect(s.slot?.subFailures).toContainEqual({ callId: 'c1', settled: false });
    expect(s.gaps).toContain('truncated_reconciliation_undecidable');
  });

  it('gap: closing the slot while a sub-failure is still unknown is flagged', () => {
    const s = run([
      openSlot,
      { type: 'external_failure', callId: 'x1', intentId: 'intent-2' },
      {
        type: 'dispatch',
        tool: 'http_get',
        idempotent: true,
        kind: 'repair',
        intentId: 'intent-1',
        callId: 'c1',
      },
      { type: 'outcome', callId: 'c1', outcome: { kind: 'success' } },
    ]);
    expect(s.slot).toBeNull();
    expect(s.gaps).toContain('subfailure_unknown_at_close');
  });

  it('invariant 5: run_code true success requires completed, exit 0 and termination confirmed', () => {
    expect(isRunCodeTrueSuccess({ kind: 'run_code', completed: true, exitCode: 0, terminationConfirmed: true, cleanupConfirmed: true })).toBe(true);
    expect(isRunCodeTrueSuccess({ kind: 'run_code', completed: true, exitCode: 0, terminationConfirmed: false, cleanupConfirmed: true })).toBe(false);
    expect(isRunCodeTrueSuccess({ kind: 'run_code', completed: true, exitCode: 1, terminationConfirmed: true, cleanupConfirmed: true })).toBe(false);
    expect(isRunCodeTrueSuccess({ kind: 'run_code', completed: false, exitCode: 0, terminationConfirmed: true, cleanupConfirmed: true })).toBe(false);
    expect(classifyOutcome({ kind: 'run_code', completed: true, exitCode: 0, terminationConfirmed: true, cleanupConfirmed: false })).toBe('true_success');
    expect(classifyOutcome({ kind: 'run_code', completed: true, exitCode: 1, terminationConfirmed: true, cleanupConfirmed: true })).toBe('failure');
    expect(classifyOutcome({ kind: 'run_code', completed: true, exitCode: 0, terminationConfirmed: false, cleanupConfirmed: true })).toBe('unknown');
  });

  it('run_code with unconfirmed termination opens the slot and blocks redispatch until confirmed', () => {
    const s0 = run([
      {
        type: 'dispatch',
        tool: 'run_code',
        idempotent: false,
        kind: 'independent',
        intentId: 'intent-1',
        callId: 'c0',
      },
      {
        type: 'outcome',
        callId: 'c0',
        outcome: { kind: 'run_code', completed: true, exitCode: 0, terminationConfirmed: false, cleanupConfirmed: false },
      },
    ]);
    expect(s0.slot).not.toBeNull();
    expect(s0.outcomeUnknown).toBe(true);
    const blocked = step(s0, {
      type: 'dispatch',
      tool: 'run_code',
      idempotent: false,
      kind: 'retry',
      intentId: 'intent-1',
      callId: 'c1',
    });
    expect(lastDecision(blocked).action).toBe('refused');
    const unblocked = step(s0, {
      type: 'termination_report',
      callId: 'c0',
      terminationConfirmed: true,
      cleanupConfirmed: true,
    });
    const ok = step(unblocked, {
      type: 'dispatch',
      tool: 'run_code',
      idempotent: false,
      kind: 'retry',
      intentId: 'intent-1',
      callId: 'c2',
    });
    expect(lastDecision(ok).action).toBe('admitted');
  });

  it('invariant 6: delegate_task refused while the slot is open or an outcome is unknown', () => {
    const open = step(run([openSlot]), { type: 'delegate_request' });
    expect(lastDecision(open).action).toBe('refused');

    // unknown outcome with no open slot: non-idem timeout closed by repair success
    const unknown = run([
      {
        type: 'dispatch',
        tool: 'http_post',
        idempotent: false,
        kind: 'independent',
        intentId: 'intent-1',
        callId: 'c0',
      },
      { type: 'outcome', callId: 'c0', outcome: { kind: 'failure', code: 'timeout' } },
      {
        type: 'dispatch',
        tool: 'write_file',
        idempotent: false,
        kind: 'alternative',
        intentId: 'intent-1',
        callId: 'c1',
      },
      { type: 'outcome', callId: 'c1', outcome: { kind: 'success' } },
    ]);
    expect(unknown.slot).toBeNull();
    expect(unknown.outcomeUnknown).toBe(true); // liability reservation survives slot close
    const refused = step(unknown, { type: 'delegate_request' });
    expect(lastDecision(refused).action).toBe('refused');
  });

  it('rule 3: finalize closes the slot; success claim without true success is flagged', () => {
    const s = run([openSlot, { type: 'finalize', successClaim: false }]);
    expect(s.slot).toBeNull();
    expect(s.finalized).toBe(true);
    expect(s.gaps).not.toContain('success_claim_without_true_success');

    const claimed = run([openSlot, { type: 'finalize', successClaim: true }]);
    expect(claimed.gaps).toContain('success_claim_without_true_success');
  });

  it('after finalize only recall is processed (and it stays free)', () => {
    const s = run([openSlot, { type: 'finalize', successClaim: false }, { type: 'recall' }]);
    expect(lastDecision(s).action).toBe('free');
    const s2 = step(s, {
      type: 'dispatch',
      tool: 'search',
      idempotent: true,
      kind: 'repair',
      intentId: 'intent-1',
      callId: 'c1',
    });
    expect(lastDecision(s2).action).toBe('refused');
  });
});
