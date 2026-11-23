import { describe, it, expect } from 'vitest';
import {
  generateTrace,
  runTrace,
  shrinkTrace,
  fuzz,
  mulberry32,
  type StepFn,
} from '../recovery_slot_fuzzer';
import { step, type MachineState, type SlotEvent } from '../recovery_slot_spec';

describe('recovery slot fuzzer', () => {
  it('generator is deterministic for a given seed', () => {
    expect(generateTrace(4242)).toEqual(generateTrace(4242));
    expect(generateTrace(1)).not.toEqual(generateTrace(2));
  });

  it('mulberry32 is deterministic and in [0,1)', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(v).toBe(b());
    }
  });

  it('5000 seeded traces: no invariant violations against the reference machine', () => {
    const result = fuzz([1, 2, 3, 4, 5], 1000);
    expect(result.traces).toBe(5000);
    expect(result.violations).toEqual([]);
  });

  it('the fuzzer surfaces the known undecidable cases as spec gaps', () => {
    const result = fuzz([11, 12, 13], 500);
    // The reference machine resolves ambiguities conservatively, so gaps — not
    // violations — are what the fuzz run must surface.
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(result.gaps).toContain('truncated_reconciliation_undecidable');
    expect(result.gaps).toContain('subfailure_unknown_at_close');
  });

  it('delta-debugging shrinker minimizes a violating trace for a broken machine', () => {
    // Broken machine: recall consumes one allowance when a slot is open
    // (violates invariant 1: recall is free).
    const brokenStep: StepFn = (prev: MachineState, ev: SlotEvent) => {
      const next = step(prev, ev);
      if (ev.type === 'recall' && next.slot) {
        next.slot = { ...next.slot, remaining: next.slot.remaining - 1 };
      }
      return next;
    };

    const trace: SlotEvent[] = [
      { type: 'external_failure', callId: 'x0', intentId: 'intent-1' },
      { type: 'replan' },
      { type: 'recall' },
      { type: 'recall' },
      { type: 'delegate_request' },
      { type: 'replan' },
      { type: 'recall' },
    ];

    const result = runTrace(trace, brokenStep);
    expect(result.violations.some((v) => v.invariant === 'inv1-recall-free')).toBe(true);

    const predicate = (cand: SlotEvent[]) =>
      runTrace(cand, brokenStep).violations.some((v) => v.invariant === 'inv1-recall-free');
    const shrunk = shrinkTrace(trace, predicate);
    expect(shrunk.length).toBeLessThanOrEqual(3);
    expect(predicate(shrunk)).toBe(true);
    // 1-minimality: removing any single event breaks the violation.
    for (let i = 0; i < shrunk.length; i++) {
      const smaller = shrunk.slice(0, i).concat(shrunk.slice(i + 1));
      if (smaller.length === 0) continue;
      expect(predicate(smaller)).toBe(false);
    }
  });

  it('shrinker leaves an already-minimal trace untouched', () => {
    const minimal: SlotEvent[] = [
      { type: 'external_failure', callId: 'x0', intentId: 'intent-1' },
      { type: 'recall' },
    ];
    const predicate = (cand: SlotEvent[]) => cand.length >= 2;
    expect(shrinkTrace(minimal, predicate)).toEqual(minimal);
  });

  it('random traces never crash the machine and always terminate', () => {
    for (let seed = 1000; seed < 1100; seed++) {
      const trace = generateTrace(seed);
      const { state } = runTrace(trace);
      expect(state.decisions.length).toBe(trace.length);
      expect(state.slot === null || state.slot.remaining >= 0).toBe(true);
    }
  });
});
