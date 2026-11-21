import { describe, it, expect } from 'vitest';
import { RecoverySlotSimulator, INITIAL_ALLOWANCE, type SimEvent } from '../recovery_slot_fuzzer';

/**
 * Targeted tests for the child-run inheritance rule: a delegate_task child
 * borrows the parent's slot and allowance; it never mints its own.
 *
 * These complement the randomized fuzzer by pinning the exact interleavings
 * the spec flagged as ambiguous (child failure with parent slot closed,
 * child recovery after parent exhaustion, nested grandchild delegation).
 */

describe('delegate_task child inherits parent slot and allowance', () => {
  it('a child first failure opens the SHARED slot and charges the parent allowance exactly once', () => {
    const sim = new RecoverySlotSimulator();
    const before = sim.remaining;
    sim.apply({
      type: 'delegate_task',
      child: [
        { type: 'tool', tool: 'search_index', idempotent: true, outcome: 'timeout' },
      ],
    });
    // one failure inside the child == one charged unit on the shared ledger
    expect(sim.remaining).toBe(before - 1);
    const snap = sim.snapshot();
    expect(snap.slotOpen).toBe(true);
    expect(snap.slotTool).toBe('search_index');
    expect(snap.slotIdempotent).toBe(true);
  });

  it('a nested grandchild failure also charges the single shared ledger, not a fresh one', () => {
    const sim = new RecoverySlotSimulator();
    sim.apply({
      type: 'delegate_task',
      child: [
        { type: 'tool', tool: 'a', idempotent: false, outcome: 'success' },
        {
          type: 'delegate_task',
          child: [
            { type: 'tool', tool: 'b', idempotent: false, outcome: 'invalid_args' },
          ],
        },
      ],
    });
    // grandchild failure charged exactly one unit against the tree's budget
    expect(sim.remaining).toBe(INITIAL_ALLOWANCE - 1);
    expect(sim.snapshot().slotTool).toBe('b');
  });

  it('child failures never raise the parent allowance, and successes never mint units', () => {
    const sim = new RecoverySlotSimulator();
    // burn the whole budget in the parent
    for (let i = 0; i < INITIAL_ALLOWANCE; i++) {
      sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    }
    expect(sim.remaining).toBe(0);

    sim.apply({
      type: 'delegate_task',
      child: [
        { type: 'tool', tool: 'c', idempotent: true, outcome: 'success' },
        { type: 'tool', tool: 'd', idempotent: true, outcome: 'rejected' },
      ],
    });
    // success cannot refill; failure cannot push the count negative or up
    expect(sim.remaining).toBe(0);
    expect(sim.remaining).toBeGreaterThanOrEqual(0);
  });

  it('after parent exhaustion, a child failure does not open a new slot or change the opening tool', () => {
    const sim = new RecoverySlotSimulator();
    sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    const snapBefore = sim.snapshot();
    expect(snapBefore.allowance).toBe(0);

    sim.apply({
      type: 'delegate_task',
      child: [
        { type: 'tool', tool: 'child_tool', idempotent: true, outcome: 'timeout' },
      ],
    });
    const snapAfter = sim.snapshot();
    // the exhausted parent state is inherited: no new slot, same opening tool,
    // allowance still exactly 0.
    expect(snapAfter.allowance).toBe(0);
    expect(snapAfter.slotOpen).toBe(true);
    expect(snapAfter.slotTool).toBe(snapBefore.slotTool);
  });

  it('recall and replan inside a child run leave the shared ledger byte-for-byte unchanged', () => {
    const sim = new RecoverySlotSimulator();
    sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    const before = JSON.stringify(sim.snapshot());

    sim.apply({
      type: 'delegate_task',
      child: [
        { type: 'recall' },
        { type: 'replan' },
        { type: 'recall' },
      ],
    });
    expect(JSON.stringify(sim.snapshot())).toBe(before);
    expect(sim.remaining).toBe(INITIAL_ALLOWANCE - 1);
  });

  it('a different idempotent tool succeeding inside the child does not close the parent slot', () => {
    const sim = new RecoverySlotSimulator();
    sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    expect(sim.snapshot().slotOpen).toBe(true);

    sim.apply({
      type: 'delegate_task',
      child: [
        { type: 'tool', tool: 'read_file', idempotent: true, outcome: 'success' },
      ],
    });
    // only a true-success repair of write_file may close the slot
    expect(sim.snapshot().slotOpen).toBe(true);
    expect(sim.snapshot().slotTool).toBe('write_file');
  });

  it('a true-success repair dispatched by the child closes the shared slot under the normal rule', () => {
    const sim = new RecoverySlotSimulator();
    sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    expect(sim.snapshot().slotOpen).toBe(true);

    sim.apply({
      type: 'delegate_task',
      child: [
        { type: 'tool', tool: 'write_file', idempotent: false, outcome: 'success' },
      ],
    });
    expect(sim.snapshot().slotOpen).toBe(false);
    expect(sim.snapshot().slotTool).toBeNull();
  });

  it('every failure outcome kind inside a child charges exactly one shared unit', () => {
    const kinds: Array<'invalid_args' | 'rejected' | 'timeout'> = [
      'invalid_args',
      'rejected',
      'timeout',
    ];
    for (const kind of kinds) {
      for (const idempotent of [true, false]) {
        const sim = new RecoverySlotSimulator();
        const events: SimEvent[] = [
          { type: 'delegate_task', child: [{ type: 'tool', tool: 't', idempotent, outcome: kind }] },
          {
            type: 'delegate_task',
            child: [{ type: 'run_code', outerOk: true, exitCode: 2 }],
          },
        ];
        for (const e of events) sim.apply(e);
        // two child failures -> exactly two units off the shared budget
        expect(sim.remaining).toBe(INITIAL_ALLOWANCE - 2);
      }
    }
  });

  it('a long adversarial child script can never push the shared allowance negative or above budget', () => {
    const sim = new RecoverySlotSimulator();
    const child: SimEvent[] = [];
    for (let i = 0; i < 20; i++) {
      child.push({ type: 'tool', tool: `t${i}`, idempotent: i % 2 === 0, outcome: 'timeout' });
      child.push({ type: 'recall' });
      child.push({ type: 'replan' });
    }
    child.push({
      type: 'delegate_task',
      child: [{ type: 'tool', tool: 'deep', idempotent: true, outcome: 'rejected' }],
    });
    sim.apply({ type: 'delegate_task', child });

    expect(sim.remaining).toBeGreaterThanOrEqual(0);
    expect(sim.remaining).toBeLessThanOrEqual(INITIAL_ALLOWANCE);
    expect(sim.remaining).toBe(0);
  });
});
