import { describe, it, expect } from 'vitest';
import {
  RecoverySlotSimulator,
  INITIAL_ALLOWANCE,
  fuzzRecoverySlot,
  runSeed,
  mulberry32,
  generateEvent,
  type SimEvent,
} from '../recovery_slot_fuzzer';

describe('RecoverySlotSimulator core rules', () => {
  it('starts with the issued allowance and no open slot', () => {
    const sim = new RecoverySlotSimulator();
    expect(sim.remaining).toBe(INITIAL_ALLOWANCE);
    expect(sim.snapshot().slotOpen).toBe(false);
  });

  it('first failure opens the slot and charges one unit', () => {
    const sim = new RecoverySlotSimulator();
    const r = sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    expect(r.slotOpened).toBe(true);
    expect(r.terminalFailure).toBe(false);
    expect(sim.remaining).toBe(INITIAL_ALLOWANCE - 1);
    expect(sim.snapshot().slotTool).toBe('write_file');
  });

  it('run_code outer ok with exit_code != 0 is a failure that opens the slot', () => {
    const sim = new RecoverySlotSimulator();
    const r = sim.apply({ type: 'run_code', outerOk: true, exitCode: 1 });
    expect(r.slotOpened).toBe(true);
    expect(sim.snapshot().slotTool).toBe('run_code');
    expect(sim.remaining).toBe(INITIAL_ALLOWANCE - 1);
  });

  it('run_code outer ok with exit_code 0 is a success', () => {
    const sim = new RecoverySlotSimulator();
    const r = sim.apply({ type: 'run_code', outerOk: true, exitCode: 0 });
    expect(r.slotOpened).toBe(false);
    expect(r.terminalFailure).toBe(false);
    expect(sim.remaining).toBe(INITIAL_ALLOWANCE);
  });

  it('closes the slot only on a true-success repair of the opening tool', () => {
    const sim = new RecoverySlotSimulator();
    sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    const r = sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'success' });
    expect(r.slotClosed).toBe(true);
    expect(sim.snapshot().slotOpen).toBe(false);
    expect(sim.remaining).toBe(INITIAL_ALLOWANCE - 1); // success never raises the count
  });

  it('a different idempotent tool success does NOT close a non-idempotent timeout slot', () => {
    const sim = new RecoverySlotSimulator();
    sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    const r = sim.apply({
      type: 'tool',
      tool: 'reconcile_index',
      idempotent: true,
      outcome: 'success',
    });
    expect(r.slotClosed).toBe(false);
    expect(sim.snapshot().slotOpen).toBe(true);
    expect(sim.snapshot().slotTool).toBe('write_file');
  });

  it('recall is free and never opens, closes or resets the slot', () => {
    const sim = new RecoverySlotSimulator();
    sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    const before = sim.snapshot();
    const r = sim.apply({ type: 'recall' });
    expect(r.charged).toBe(0);
    expect(r.dispatched).toBe(true);
    expect(sim.snapshot()).toEqual(before);
  });

  it('replan never resets the allowance', () => {
    const sim = new RecoverySlotSimulator();
    sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    const before = sim.snapshot();
    sim.apply({ type: 'replan' });
    expect(sim.snapshot()).toEqual(before);
    expect(sim.remaining).toBe(INITIAL_ALLOWANCE - 1);
  });

  it('exhausted allowance: a further failure is terminal with no dispatch and no slot', () => {
    const sim = new RecoverySlotSimulator();
    // burn the whole budget with failures
    for (let i = 0; i < INITIAL_ALLOWANCE; i++) {
      sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    }
    expect(sim.remaining).toBe(0);
    const r = sim.apply({ type: 'tool', tool: 'search_api', idempotent: true, outcome: 'invalid_args' });
    expect(r.dispatched).toBe(false);
    expect(r.refused).toBe(true);
    expect(r.terminalFailure).toBe(true);
    expect(r.slotOpened).toBe(false);
    expect(sim.remaining).toBe(0); // never negative
  });
});

describe('child-run inheritance (delegate_task)', () => {
  it("child's first failure with parent allowance 0 is terminal, no slot, no dispatch", () => {
    const sim = new RecoverySlotSimulator();
    // parent exhausts the allowance first
    for (let i = 0; i < INITIAL_ALLOWANCE; i++) {
      sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    }
    const before = sim.snapshot();
    const r = sim.apply({
      type: 'delegate_task',
      child: [{ type: 'tool', tool: 'search_api', idempotent: true, outcome: 'invalid_args' }],
    });
    expect(r.terminalFailure).toBe(true);
    expect(r.slotOpened).toBe(false);
    expect(r.dispatched).toBe(false);
    expect(sim.snapshot()).toEqual(before); // ledger untouched: no minting
  });

  it("child's first failure with an open parent slot borrows the parent slot (no fresh allowance of 3)", () => {
    const sim = new RecoverySlotSimulator();
    sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    const r = sim.apply({
      type: 'delegate_task',
      child: [{ type: 'tool', tool: 'search_api', idempotent: true, outcome: 'timeout' }],
    });
    expect(r.slotOpened).toBe(false); // slot was already open, child did not mint one
    expect(r.charged).toBe(1); // charged to the shared parent allowance
    expect(sim.remaining).toBe(INITIAL_ALLOWANCE - 2);
    expect(sim.snapshot().slotTool).toBe('write_file'); // still the parent's slot
  });

  it("child's success never raises the parent's remaining count", () => {
    const sim = new RecoverySlotSimulator();
    sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    sim.apply({
      type: 'delegate_task',
      child: [{ type: 'tool', tool: 'search_api', idempotent: true, outcome: 'success' }],
    });
    expect(sim.remaining).toBe(INITIAL_ALLOWANCE - 1);
  });

  it("child's true-success repair of the slot's opening tool closes the slot under the normal rule", () => {
    const sim = new RecoverySlotSimulator();
    sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    const r = sim.apply({
      type: 'delegate_task',
      child: [{ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'success' }],
    });
    expect(r.slotClosed).toBe(true);
    expect(sim.snapshot().slotOpen).toBe(false);
    expect(sim.remaining).toBe(INITIAL_ALLOWANCE - 1); // closing does not refund
  });

  it('nested delegation (grandchild) inherits the exhausted state transitively', () => {
    const sim = new RecoverySlotSimulator();
    for (let i = 0; i < INITIAL_ALLOWANCE; i++) {
      sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    }
    const before = sim.snapshot();
    const r = sim.apply({
      type: 'delegate_task',
      child: [
        {
          type: 'delegate_task',
          child: [{ type: 'run_code', outerOk: true, exitCode: 2 }],
        },
      ],
    });
    expect(r.terminalFailure).toBe(true);
    expect(r.dispatched).toBe(false);
    expect(sim.snapshot()).toEqual(before);
    expect(sim.remaining).toBe(0);
  });

  it('a child can never dispatch a recovery call the parent would be refused', () => {
    const sim = new RecoverySlotSimulator();
    sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    expect(sim.remaining).toBe(0);
    const r = sim.apply({
      type: 'delegate_task',
      child: [{ type: 'tool', tool: 'search_api', idempotent: true, outcome: 'timeout' }],
    });
    expect(r.refused).toBe(true);
    expect(r.dispatched).toBe(false);
    expect(sim.remaining).toBe(0);
  });

  it('recall inside a child run stays free', () => {
    const sim = new RecoverySlotSimulator();
    sim.apply({ type: 'tool', tool: 'write_file', idempotent: false, outcome: 'timeout' });
    const before = sim.snapshot();
    sim.apply({ type: 'delegate_task', child: [{ type: 'recall' }, { type: 'replan' }] });
    expect(sim.snapshot()).toEqual(before);
  });
});

describe('deterministic seeded fuzzer', () => {
  it('is deterministic: the same seed yields the same event sequence', () => {
    const a: SimEvent[] = [];
    const b: SimEvent[] = [];
    const ra = mulberry32(42);
    const rb = mulberry32(42);
    for (let i = 0; i < 50; i++) {
      a.push(generateEvent(ra, 2));
      b.push(generateEvent(rb, 2));
    }
    expect(a).toEqual(b);
  });

  it('runSeed is reproducible', () => {
    expect(runSeed(7, 40)).toEqual(runSeed(7, 40));
  });

  it('finds no invariant violations across adversarial interleavings', () => {
    const violations = fuzzRecoverySlot(600, 40);
    expect(violations).toEqual([]);
  });

  it('the fuzzer actually exercises exhaustion and delegation', () => {
    // Sanity: across seeds the simulator must reach exhausted states and
    // produce delegate_task events, otherwise the property test is vacuous.
    let sawExhausted = 0;
    let sawDelegate = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const rand = mulberry32(seed);
      const sim = new RecoverySlotSimulator();
      let delegated = false;
      for (let step = 0; step < 40; step++) {
        const ev = generateEvent(rand, 2);
        if (ev.type === 'delegate_task') delegated = true;
        sim.apply(ev);
      }
      if (sim.exhausted) sawExhausted++;
      if (delegated) sawDelegate++;
    }
    expect(sawExhausted).toBeGreaterThan(20);
    expect(sawDelegate).toBeGreaterThan(20);
  });
});
