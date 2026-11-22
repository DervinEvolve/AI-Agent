import { describe, it, expect } from 'vitest';
import {
  RecoverySlotMachine,
  MAX_RECOVERY_ALLOWANCE,
  mulberry32,
  type RecoveryEvent,
  type SlotSnapshot,
} from '../recovery_slot';

/**
 * Property-based and scenario tests for the recovery-slot state machine.
 * All schedules are seeded so failures are replayable.
 */

const NON_IDEMPOTENT = ['write_file', 'charge_card', 'run_code', 'delegate_task', 'http_post'];
const IDEMPOTENT = ['read_file', 'get_status', 'search', 'verify'];
const OUTCOMES = ['success', 'invalid_args', 'tool_error', 'timeout', 'exit_code_nonzero'] as const;
const RECONCILIATIONS = ['confirmed_applied', 'confirmed_not_applied', 'inconclusive'] as const;
const DECLARATIONS = ['repair_of', 'repair_of', 'unrelated', 'undeclared'] as const;

function pick<T>(rand: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

function randomSchedule(seed: number, length: number): RecoveryEvent[] {
  const rand = mulberry32(seed);
  const events: RecoveryEvent[] = [];
  for (let i = 0; i < length; i++) {
    const roll = rand();
    if (roll < 0.1) {
      events.push({ kind: 'recall' });
    } else if (roll < 0.18) {
      events.push({ kind: 'replan' });
    } else if (roll < 0.24) {
      events.push({ kind: 'finalize' });
    } else {
      const isReconciliation = rand() < 0.25;
      const idempotent = isReconciliation || rand() < 0.4;
      events.push({
        kind: 'dispatch',
        tool: idempotent ? pick(rand, IDEMPOTENT) : pick(rand, NON_IDEMPOTENT),
        idempotent,
        declaration: pick(rand, DECLARATIONS),
        outcome: pick(rand, OUTCOMES),
        isReconciliation,
        reconciliation: isReconciliation ? pick(rand, RECONCILIATIONS) : undefined,
      });
    }
  }
  return events;
}

function checkCoreInvariants(m: RecoverySlotMachine) {
  const s = m.getState();
  expect(s.allowance).toBeGreaterThanOrEqual(0);
  expect(s.chargedTotal).toBeLessThanOrEqual(MAX_RECOVERY_ALLOWANCE);
  if (s.open) {
    expect(s.allowance + s.chargedTotal).toBe(MAX_RECOVERY_ALLOWANCE);
  }
  // I10: log indices are 0..n-1 with no gaps or duplicates.
  const log = m.getLog();
  const indices = log.map((e) => e.index);
  expect(new Set(indices).size).toBe(indices.length);
  for (let i = 0; i < indices.length; i++) {
    expect(indices).toContain(i);
  }
}

describe('recovery slot: randomized property-based invariants', () => {
  it('holds core invariants across 200 seeded random schedules', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const m = new RecoverySlotMachine();
      const events = randomSchedule(seed, 60);
      let intentIdWhileOpen: number | null = null;
      for (const ev of events) {
        const before = m.getState();
        m.apply(ev);
        const after = m.getState();

        // I4: recall is free and never mutates state.
        if (ev.kind === 'recall') {
          expect(after).toEqual(before);
        }

        // I5: replan never resets the slot, allowance, or unknown outcome.
        if (ev.kind === 'replan') {
          expect(after.open).toBe(before.open);
          expect(after.allowance).toBe(before.allowance);
          expect(after.unknownOutcome).toBe(before.unknownOutcome);
        }

        // I3: intent id is stable while the slot stays open.
        if (before.open && after.open) {
          if (intentIdWhileOpen === null) intentIdWhileOpen = before.intentId;
          expect(after.intentId).toBe(intentIdWhileOpen);
        } else {
          intentIdWhileOpen = null;
        }

        // I6: unrelated/undeclared failures are never charged while a slot is open.
        if (
          ev.kind === 'dispatch' &&
          before.open &&
          (ev.declaration === 'unrelated' || ev.declaration === 'undeclared') &&
          ev.outcome !== 'success'
        ) {
          expect(after.chargedTotal).toBe(before.chargedTotal);
        }

        // I8: at allowance 0 with unknown outcome, non-recall dispatches are refused.
        if (
          ev.kind === 'dispatch' &&
          before.allowance === 0 &&
          before.open &&
          before.unknownOutcome
        ) {
          const last = m.getLog().at(-1);
          expect(last?.effect).toBe('refused');
          expect(after).toEqual(before);
        }

        checkCoreInvariants(m);
      }
    }
  });
});

describe('recovery slot: reconciliation close path (hole a)', () => {
  it('confirmed_applied reconciliation closes the slot as true success after a non-idempotent timeout', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    expect(m.getState().open).toBe(true);
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
    expect(s.unknownOutcome).toBe(false);
    // Slot closed on true success: chargedTotal resets for the next slot.
    expect(s.chargedTotal).toBe(0);
    expect(s.allowance).toBe(MAX_RECOVERY_ALLOWANCE);
  });

  it('confirmed_not_applied clears unknown_outcome, unblocks the tool, keeps the slot open, and is charged once', () => {
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
      tool: 'read_file',
      idempotent: true,
      declaration: 'repair_of',
      outcome: 'success',
      isReconciliation: true,
      reconciliation: 'confirmed_not_applied',
    });
    const after = m.getState();
    expect(after.open).toBe(true);
    expect(after.unknownOutcome).toBe(false);
    expect(after.allowance).toBe(before.allowance - 1);

    // The timed-out tool is unblocked: a retry of the same tool is applied, not refused.
    const res = m.apply({
      kind: 'dispatch',
      tool: 'write_file',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'success',
    });
    expect(res.refused).toBeUndefined();
    expect(m.getState().open).toBe(false);
  });

  it('inconclusive reconciliation keeps unknown_outcome set and does not close the slot', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'http_post',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    m.apply({
      kind: 'dispatch',
      tool: 'verify',
      idempotent: true,
      declaration: 'repair_of',
      outcome: 'success',
      isReconciliation: true,
      reconciliation: 'inconclusive',
    });
    const s = m.getState();
    expect(s.open).toBe(true);
    expect(s.unknownOutcome).toBe(true);
  });

  it('a blocked non-idempotent tool cannot be re-dispatched while unknown_outcome is set, but idempotent calls can', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    const res = m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'success',
    });
    expect(res.refused).toBe('blocked-tool');
    const res2 = m.apply({
      kind: 'dispatch',
      tool: 'get_status',
      idempotent: true,
      declaration: 'repair_of',
      outcome: 'success',
      isReconciliation: true,
      reconciliation: 'inconclusive',
    });
    expect(res2.refused).toBeUndefined();
  });
});

describe('recovery slot: exhaustion with unknown outcome (hole d)', () => {
  it('at allowance 0 with unknown_outcome, non-recall dispatches are refused and only finalize is legal', () => {
    const m = new RecoverySlotMachine();
    // Timeout: charged 1, unknown_outcome set.
    m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    // Two inconclusive reconciliations drain to 0.
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
    expect(m.getState().allowance).toBe(0);
    expect(m.getState().unknownOutcome).toBe(true);

    const before = m.getState();
    const res = m.apply({
      kind: 'dispatch',
      tool: 'write_file',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'success',
    });
    expect(res.refused).toBe('exhausted-unknown');
    expect(m.getState()).toEqual(before);

    // Recall is still free at exhaustion.
    m.apply({ kind: 'recall' });
    expect(m.getState()).toEqual(before);

    // Finalize is legal and reports unknown outcome.
    m.apply({ kind: 'finalize' });
    const s = m.getState();
    expect(s.open).toBe(false);
    expect(s.claim).toBe('unknown');
  });

  it('after an unknown-outcome finalize the machine is terminal: no new slot is minted', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
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
    m.apply({ kind: 'finalize' });

    // A new failure after the unknown-outcome finalize must not mint a slot.
    m.apply({
      kind: 'dispatch',
      tool: 'write_file',
      idempotent: false,
      declaration: 'undeclared',
      outcome: 'tool_error',
    });
    const s = m.getState();
    expect(s.open).toBe(false);
    expect(s.chargedTotal).toBe(0);
    expect(s.allowance).toBe(0);
    expect(s.terminal).toBe(true);
  });
});

describe('recovery slot: intent binding (hole b)', () => {
  it('repair_of failures consume allowance and inherit the intent; unrelated failures do not', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'write_file',
      idempotent: false,
      declaration: 'undeclared',
      outcome: 'tool_error',
    });
    const intent = m.getState().intentId;
    const allowanceAfterOpen = m.getState().allowance;

    m.apply({
      kind: 'dispatch',
      tool: 'run_code',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'tool_error',
    });
    expect(m.getState().intentId).toBe(intent);
    expect(m.getState().allowance).toBe(allowanceAfterOpen - 1);

    m.apply({
      kind: 'dispatch',
      tool: 'delegate_task',
      idempotent: false,
      declaration: 'unrelated',
      outcome: 'tool_error',
    });
    expect(m.getState().allowance).toBe(allowanceAfterOpen - 1);
    expect(m.getLog().at(-1)?.effect).toBe('ambiguous-intent-merge');
  });

  it('run_code outer ok but exit_code!=0 is a failure that opens/charges the slot', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'run_code',
      idempotent: false,
      declaration: 'undeclared',
      outcome: 'exit_code_nonzero',
    });
    expect(m.getState().open).toBe(true);
    expect(m.getState().chargedTotal).toBe(1);
    expect(m.getState().allowance).toBe(MAX_RECOVERY_ALLOWANCE - 1);
  });

  it('a successful repair dispatch closes the slot as success and resets allowance', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'write_file',
      idempotent: false,
      declaration: 'undeclared',
      outcome: 'invalid_args',
    });
    m.apply({
      kind: 'dispatch',
      tool: 'write_file',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'success',
    });
    const s = m.getState();
    expect(s.open).toBe(false);
    expect(s.claim).toBe('success');
    expect(s.chargedTotal).toBe(0);
    expect(s.allowance).toBe(MAX_RECOVERY_ALLOWANCE);
  });

  it('a new failure after a clean close mints a fresh slot with a new intent id', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'write_file',
      idempotent: false,
      declaration: 'undeclared',
      outcome: 'tool_error',
    });
    const firstIntent = m.getState().intentId;
    m.apply({
      kind: 'dispatch',
      tool: 'write_file',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'success',
    });
    m.apply({
      kind: 'dispatch',
      tool: 'http_post',
      idempotent: false,
      declaration: 'undeclared',
      outcome: 'tool_error',
    });
    const s = m.getState();
    expect(s.open).toBe(true);
    expect(s.intentId).not.toBe(firstIntent);
    expect(s.allowance).toBe(MAX_RECOVERY_ALLOWANCE - 1);
  });
});

describe('recovery slot: replan and recall (I4/I5)', () => {
  it('replan does not reset allowance or unknown_outcome on an open slot', () => {
    const m = new RecoverySlotMachine();
    m.apply({
      kind: 'dispatch',
      tool: 'charge_card',
      idempotent: false,
      declaration: 'repair_of',
      outcome: 'timeout',
    });
    const before = m.getState();
    m.apply({ kind: 'replan' });
    expect(m.getState()).toEqual(before);
    m.apply({ kind: 'recall' });
    expect(m.getState()).toEqual(before);
  });
});
