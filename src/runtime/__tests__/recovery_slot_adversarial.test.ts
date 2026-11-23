/**
 * Adversarial tests combining the single recovery slot's nesting rules with
 * the truncation/recall rules, driven both at the rule level (reference
 * machine) and through the seeded fuzzer.
 *
 * Only behaviors already pinned by the existing tests and the written spec
 * are asserted: slot identity (intent_id / origin_call_id), allowance
 * arithmetic (3, charged at admission), recall being free, replan never
 * resetting the slot, sub-failure absorption into the open slot, and the
 * fuzzer's contract (determinism, trace counts, zero violations, known gaps).
 */
import { describe, it, expect } from 'vitest';
import {
  step,
  initialSlotState,
  type MachineState,
  type SlotEvent,
} from '../recovery_slot_spec';
import { fuzz, generateTrace, mulberry32 } from '../recovery_slot_fuzzer';

function run(events: SlotEvent[]): MachineState {
  return events.reduce(step, initialSlotState());
}

const openSlot: SlotEvent = {
  type: 'external_failure',
  callId: 'x0',
  intentId: 'intent-1',
};

const secondFailure: SlotEvent = {
  type: 'external_failure',
  callId: 'x1',
  intentId: 'intent-2',
};

const reconcile: SlotEvent = {
  type: 'dispatch',
  tool: 'http_get',
  idempotent: true,
  kind: 'reconciliation',
  intentId: 'intent-1',
  callId: 'r1',
};

describe('recovery slot: nesting rules (adversarial)', () => {
  it('a second independent failure while a slot is open is absorbed: no new slot, no fresh allowance', () => {
    const s = run([openSlot, secondFailure]);
    // Single slot, still the original intent, allowance untouched.
    expect(s.slot).not.toBeNull();
    expect(s.slot?.intentId).toBe('intent-1');
    expect(s.slot?.originCallId).toBe('x0');
    expect(s.slot?.remaining).toBe(3);
  });

  it('a reconciliation dispatch is charged exactly one allowance', () => {
    const s = run([openSlot, reconcile]);
    expect(s.slot?.remaining).toBe(2);
  });

  it('a failure of the reconciliation call itself consumes no allowance beyond the dispatch charge', () => {
    // Reconciliation dispatched (3 -> 2), then it fails: the failure is
    // absorbed into the same slot, so remaining must stay at 2.
    const s = run([openSlot, reconcile, secondFailure]);
    expect(s.slot).not.toBeNull();
    expect(s.slot?.intentId).toBe('intent-1');
    expect(s.slot?.remaining).toBe(2);
  });

  it('recall stays free even after allowance has been partially consumed', () => {
    const s = run([openSlot, reconcile, { type: 'recall' }, { type: 'recall' }]);
    expect(s.slot?.remaining).toBe(2);
  });

  it('replan after a consumed reconciliation still never resets the slot', () => {
    const s = run([openSlot, reconcile, { type: 'replan' }, { type: 'replan' }]);
    expect(s.slot).not.toBeNull();
    expect(s.slot?.remaining).toBe(2);
    expect(s.slot?.intentId).toBe('intent-1');
  });

  it('sub-failure absorption holds even after the allowance is exhausted', () => {
    const events: SlotEvent[] = [openSlot];
    for (let i = 0; i < 3; i++) {
      events.push({
        type: 'dispatch',
        tool: 'http_get',
        idempotent: true,
        kind: 'repair',
        intentId: 'intent-1',
        callId: 'c' + i,
      });
    }
    // Allowance exhausted; a late independent failure must not go negative
    // and must not fork the slot.
    events.push(secondFailure);
    const s = run(events);
    expect(s.slot?.remaining).toBe(0);
    expect(s.slot?.intentId).toBe('intent-1');
    expect(s.slot?.originCallId).toBe('x0');
  });
});

describe('recovery slot: fuzzer contract (adversarial)', () => {
  it('fuzz is deterministic: identical seeds produce identical results', () => {
    const a = fuzz([101, 102], 200);
    const b = fuzz([101, 102], 200);
    expect(a.traces).toBe(b.traces);
    expect(a.violations).toEqual(b.violations);
    expect(a.gaps).toEqual(b.gaps);
  });

  it('reports the exact trace count and zero invariant violations across a broad seed sweep', () => {
    const seeds = [7, 8, 9, 10, 11, 12, 13, 14];
    const result = fuzz(seeds, 250);
    expect(result.traces).toBe(seeds.length * 250);
    expect(result.violations).toEqual([]);
  });

  it('generateTrace is deterministic per seed and varies across seeds', () => {
    expect(generateTrace(999)).toEqual(generateTrace(999));
    expect(generateTrace(999)).not.toEqual(generateTrace(998));
  });

  it('mulberry32 streams from equal seeds stay in lockstep within [0,1)', () => {
    const a = mulberry32(31337);
    const b = mulberry32(31337);
    for (let i = 0; i < 500; i++) {
      const v = a();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(v).toBe(b());
    }
  });
});
