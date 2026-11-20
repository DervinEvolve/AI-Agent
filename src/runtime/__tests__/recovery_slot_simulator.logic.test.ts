import { describe, it, expect } from 'vitest';
import {
  RecoverySlotSimulator,
  SLOT_ALLOWANCE,
  MAX_OPEN_SLOTS,
  RECONCILIATION_POLL_CAP,
  type SimEvent,
  type IntentTag,
} from '../recovery_slot_simulator';

/**
 * Targeted edge tests for the recovery-slot ledger simulator.
 * These complement the fuzz harness by pinning down the specific
 * intent-boundary edges the adversarial campaign was designed to probe:
 *   (a) unrelated new_intent failures while a slot is open
 *   (b) unknown-outcome slots and the recall polling cap
 *   (c) delegate_task child failures debiting the parent's slot
 *   (d) nonzero-exit run_code not closing a slot
 */

const newIntent = (intentId: string): IntentTag => ({ kind: 'new_intent', intentId });
const repairOf = (intentId: string): IntentTag => ({ kind: 'repair_of', intentId });

const failNew = (intentId: string): SimEvent => ({
  type: 'tool_result',
  tool: 'write_file',
  outcome: 'invalid_args',
  idempotent: false,
  tag: newIntent(intentId),
});

const failRepair = (intentId: string): SimEvent => ({
  type: 'tool_result',
  tool: 'write_file',
  outcome: 'invalid_args',
  idempotent: false,
  tag: repairOf(intentId),
});

const succeedRepair = (intentId: string): SimEvent => ({
  type: 'tool_result',
  tool: 'write_file',
  outcome: 'success',
  idempotent: true,
  tag: repairOf(intentId),
});

const timeoutNonIdempotentNew = (intentId: string): SimEvent => ({
  type: 'tool_result',
  tool: 'run_code',
  outcome: 'timeout',
  idempotent: false,
  tag: newIntent(intentId),
});

const delegateFail = (parentIntentId: string): SimEvent => ({
  type: 'delegate_task',
  childId: 'child-0',
  parentIntentId,
  tool: 'search_api',
  outcome: 'invalid_args',
  idempotent: false,
});

function slotFor(sim: RecoverySlotSimulator, intentId: string) {
  const snap = sim.snapshot();
  const slots: any[] = (snap as any).slots ?? (snap as any).openSlots ?? [];
  return slots.find((s: any) => s.intentId === intentId);
}

function openSlots(sim: RecoverySlotSimulator): any[] {
  const snap = sim.snapshot();
  return (snap as any).slots ?? (snap as any).openSlots ?? [];
}

describe('recovery slot simulator: intent-boundary edges', () => {
  it('a new_intent failure while a slot is open preserves the old slot exactly', () => {
    const sim = new RecoverySlotSimulator();
    sim.apply(failNew('intent-A'));
    const before = slotFor(sim, 'intent-A');
    expect(before).toBeDefined();

    sim.apply(failNew('intent-B'));

    const after = slotFor(sim, 'intent-A');
    expect(after).toBeDefined();
    // suspended, not closed, not reset
    expect(after.status).not.toBe('closed');
    expect(after.debits).toBe(before.debits);
    expect(after.remaining).toBe(before.remaining);
    expect(!!after.unknownOutcome).toBe(!!before.unknownOutcome);
    // and the new intent got its own slot
    expect(slotFor(sim, 'intent-B')).toBeDefined();
  });

  it('allowance accounting is exact for every slot (debits + remaining === 3)', () => {
    const sim = new RecoverySlotSimulator();
    sim.apply(failNew('intent-A'));
    sim.apply(failNew('intent-B'));
    sim.apply(failRepair('intent-A'));
    sim.apply(failRepair('intent-A'));
    for (const slot of openSlots(sim)) {
      expect(slot.debits + slot.remaining).toBe(SLOT_ALLOWANCE);
    }
    const a = slotFor(sim, 'intent-A');
    // one opening failure + two failed repairs = 3 debits, allowance exhausted
    expect(a.debits).toBe(SLOT_ALLOWANCE);
    expect(a.remaining).toBe(0);
  });

  it('refuses further new_intent work once the slot cap is hit', () => {
    const sim = new RecoverySlotSimulator();
    sim.apply(failNew('intent-A'));
    sim.apply(failNew('intent-B'));
    expect(openSlots(sim).length).toBe(MAX_OPEN_SLOTS);

    // a third unrelated intent cannot open another slot
    sim.apply(failNew('intent-C'));
    expect(openSlots(sim).length).toBeLessThanOrEqual(MAX_OPEN_SLOTS);
    expect(slotFor(sim, 'intent-C')).toBeUndefined();
  });

  it('a delegate_task child failure debits the parent slot for the delegated intent', () => {
    const sim = new RecoverySlotSimulator();
    sim.apply(failNew('intent-A'));
    const before = slotFor(sim, 'intent-A');

    sim.apply(delegateFail('intent-A'));

    const after = slotFor(sim, 'intent-A');
    // the child's failure was charged to the parent's slot, not bypassed
    expect(after.debits).toBeGreaterThan(before.debits);
    expect(after.debits + after.remaining).toBe(SLOT_ALLOWANCE);
    // and no separate child slot was created
    expect(openSlots(sim).length).toBe(1);
  });

  it('an unknown-outcome slot survives the recall polling cap without closing', () => {
    const sim = new RecoverySlotSimulator();
    // non-idempotent timeout => outcome unknown
    sim.apply(timeoutNonIdempotentNew('intent-A'));
    const slot = slotFor(sim, 'intent-A');
    expect(slot).toBeDefined();
    expect(slot.unknownOutcome).toBe(true);

    // exhaust the reconciliation polling cap with recall calls
    for (let i = 0; i < RECONCILIATION_POLL_CAP + 2; i++) {
      sim.apply({ type: 'recall' });
    }

    const after = slotFor(sim, 'intent-A');
    // recall alone never closes an unknown-outcome slot
    expect(after).toBeDefined();
    expect(after.status).not.toBe('closed');
    expect(after.unknownOutcome).toBe(true);
  });

  it('run_code nonzero exit does not close a slot; a true repair success does', () => {
    const sim = new RecoverySlotSimulator();
    sim.apply(failNew('intent-A'));

    // outer-ok with nonzero exit is not a true success
    sim.apply({
      type: 'tool_result',
      tool: 'run_code',
      outcome: 'nonzero_exit',
      idempotent: true,
      tag: repairOf('intent-A'),
    });
    let slot = slotFor(sim, 'intent-A');
    expect(slot).toBeDefined();
    expect(slot.status).not.toBe('closed');

    // a genuine success closes the slot
    sim.apply(succeedRepair('intent-A'));
    const snap: any = sim.snapshot();
    const slots: any[] = snap.slots ?? snap.openSlots ?? [];
    const closed = slots.find((s: any) => s.intentId === 'intent-A');
    if (closed) {
      expect(closed.status).toBe('closed');
    } else {
      // a closed slot may be removed from the open-slot list entirely
      expect(slots.length).toBe(0);
    }
  });

  it('a plan revision carrying a relabel attempt never mutates the ledger', () => {
    const sim = new RecoverySlotSimulator();
    sim.apply(failNew('intent-A'));
    const before = JSON.stringify(sim.snapshot());

    sim.apply({
      type: 'plan_revision',
      attemptedRelabel: newIntent('intent-B'),
    });

    expect(JSON.stringify(sim.snapshot())).toBe(before);
  });
});
