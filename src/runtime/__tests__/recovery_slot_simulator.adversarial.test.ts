import { describe, it, expect } from 'vitest';
import {
  RecoverySlotSimulator,
  SLOT_ALLOWANCE,
  MAX_OPEN_SLOTS,
  RECONCILIATION_POLL_CAP,
  type SimEvent,
  type RecoverySlot,
} from '../recovery_slot_simulator';

/** deterministic seeded PRNG (mulberry32) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INTENTS = ['intent-A', 'intent-B', 'intent-C'];
const TOOLS = ['search_api', 'write_file', 'run_code', 'recall_kb'];
const OUTCOMES = ['success', 'invalid_args', 'timeout', 'nonzero_exit'] as const;

function randomEvent(rng: () => number): SimEvent {
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
  const roll = rng();
  if (roll < 0.45) {
    const tag =
      rng() < 0.5
        ? { kind: 'new_intent' as const, intentId: pick(INTENTS) }
        : { kind: 'repair_of' as const, intentId: pick(INTENTS) };
    return {
      type: 'tool_result',
      tool: pick(TOOLS),
      outcome: pick(OUTCOMES),
      idempotent: rng() < 0.5,
      tag,
    };
  }
  if (roll < 0.6) return { type: 'recall' };
  if (roll < 0.72) {
    return {
      type: 'plan_revision',
      attemptedRelabel: { kind: 'new_intent', intentId: pick(INTENTS) },
    };
  }
  if (roll < 0.9) {
    return {
      type: 'delegate_task',
      childId: `child-${Math.floor(rng() * 3)}`,
      parentIntentId: pick(INTENTS),
      tool: pick(TOOLS),
      outcome: pick(OUTCOMES),
      idempotent: rng() < 0.5,
    };
  }
  return {
    type: 'reconcile',
    tool: pick(TOOLS),
    evidence: rng() < 0.5 ? 'success' : 'failure',
  };
}

function assertInvariants(sim: RecoverySlotSimulator): void {
  const snap = sim.snapshot();
  // cap: at most MAX_OPEN_SLOTS open (suspended-or-active, incl. exhausted) slots
  expect(snap.length).toBeLessThanOrEqual(MAX_OPEN_SLOTS);
  // at most one active slot at a time
  expect(snap.filter((s) => s.status === 'active').length).toBeLessThanOrEqual(1);
  for (const slot of snap) {
    // allowance accounting is exact
    expect(slot.debits + slot.remaining).toBe(SLOT_ALLOWANCE);
    expect(slot.remaining).toBeGreaterThanOrEqual(0);
    expect(slot.unknownOutcomeTool === null || typeof slot.unknownOutcomeTool === 'string').toBe(true);
    // blocked tools must have failed inside that slot
    for (const t of slot.toolBlocked) expect(slot.failedTools).toContain(t);
    // poll cap respected
    expect(slot.reconciliationPolls).toBeLessThanOrEqual(RECONCILIATION_POLL_CAP);
  }
}

describe('recovery slot simulator — seeded adversarial fuzz', () => {
  it('never violates structural invariants across randomized event sequences', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const rng = mulberry32(seed);
      const sim = new RecoverySlotSimulator();
      for (let i = 0; i < 120; i++) {
        const before = sim.snapshot();
        const event = randomEvent(rng);
        let result: ReturnType<RecoverySlotSimulator['dispatch']>;
        expect(() => {
          result = sim.dispatch(event);
        }).not.toThrow();
        const after = sim.snapshot();

        // plan revisions and recalls can never mutate the ledger
        if (event.type === 'plan_revision' || event.type === 'recall') {
          expect(after).toEqual(before);
        }

        // a blocked tool is never admitted for any intent
        if (event.type === 'tool_result' || event.type === 'delegate_task') {
          const blockedBefore = before.some((s) => s.toolBlocked.includes(event.tool));
          if (blockedBefore && event.type === 'tool_result') {
            expect(result!.admitted).toBe(false);
            expect(result!.reason).toBe('tool_blocked_pending_reconciliation');
          }
        }

        // any honest-failure refusal forces the final answer to be honest
        if (result!.requiresHonestFailureReport) {
          expect(sim.finalAnswer().honestPartialFailure).toBe(true);
        }

        assertInvariants(sim);
      }
      // final answer lists every open slot with its unknown-outcome tool
      const answer = sim.finalAnswer();
      const open = sim.snapshot();
      expect(answer.slots.length).toBe(open.length);
      for (const reported of answer.slots) {
        const live = open.find((s) => s.intentId === reported.intentId);
        expect(live).toBeDefined();
        expect(reported.unknownOutcomeTool).toBe(live!.unknownOutcomeTool);
        expect(reported.remaining).toBe(live!.remaining);
      }
    }
  });

  it('is fully deterministic for a fixed seed', () => {
    const run = () => {
      const rng = mulberry32(12345);
      const sim = new RecoverySlotSimulator();
      const reasons: string[] = [];
      for (let i = 0; i < 200; i++) {
        reasons.push(sim.dispatch(randomEvent(rng)).reason);
      }
      return { reasons, final: sim.finalAnswer() };
    };
    expect(run()).toEqual(run());
  });
});

describe('recovery slot simulator — targeted edge coverage', () => {
  it('edge (a): a new_intent failure while a slot is open gets its own slot and does not consume the old slot\'s allowance', () => {
    const sim = new RecoverySlotSimulator();
    // intent-A fails as a new intent -> its own slot, 1 debit
    sim.dispatch({ type: 'tool_result', tool: 'search_api', outcome: 'timeout', idempotent: false, tag: { kind: 'new_intent', intentId: 'intent-A' } });
    let snap = sim.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].debits).toBe(1);
    expect(snap[0].unknownOutcomeTool).toBe('search_api');

    // unrelated intent-B fails while A's slot is open
    const res = sim.dispatch({ type: 'tool_result', tool: 'write_file', outcome: 'invalid_args', idempotent: true, tag: { kind: 'new_intent', intentId: 'intent-B' } });
    expect(res.admitted).toBe(true);
    snap = sim.snapshot();
    expect(snap).toHaveLength(2);
    const a = snap.find((s) => s.intentId === 'intent-A')!;
    const b = snap.find((s) => s.intentId === 'intent-B')!;
    // A is suspended with debits/unknown preserved, NOT further charged
    expect(a.status).toBe('suspended');
    expect(a.debits).toBe(1);
    expect(a.remaining).toBe(SLOT_ALLOWANCE - 1);
    expect(a.unknownOutcomeTool).toBe('search_api');
    // B has its own slot
    expect(b.status).toBe('active');
    expect(b.debits).toBe(1);
  });

  it('edge (b): an unknown_outcome slot can never close via retries or recall — only supervisor reconciliation closes it', () => {
    const sim = new RecoverySlotSimulator();
    sim.dispatch({ type: 'tool_result', tool: 'write_file', outcome: 'timeout', idempotent: false, tag: { kind: 'new_intent', intentId: 'intent-A' } });

    // recall polls are capped at 2 while reconciliation is pending
    expect(sim.dispatch({ type: 'recall' }).admitted).toBe(true);
    expect(sim.dispatch({ type: 'recall' }).admitted).toBe(true);
    const third = sim.dispatch({ type: 'recall' });
    expect(third.admitted).toBe(false);
    expect(third.reason).toBe('reconciliation_poll_cap_reached');
    expect(third.requiresHonestFailureReport).toBe(true);

    // a repair retry of the same non-idempotent tool is admitted (known retry) but
    // the slot only closes on true success or reconciliation
    sim.dispatch({ type: 'tool_result', tool: 'write_file', outcome: 'invalid_args', idempotent: false, tag: { kind: 'repair_of', intentId: 'intent-A' } });
    expect(sim.snapshot()).toHaveLength(1);
    expect(sim.snapshot()[0].unknownOutcomeTool).toBe('write_file');

    // only target-side evidence closes the unknown outcome
    sim.dispatch({ type: 'reconcile', tool: 'write_file', evidence: 'success' });
    expect(sim.snapshot()).toHaveLength(0);
    expect(sim.finalAnswer().slots).toHaveLength(0);
  });

  it('edge (b) variant: reconciliation evidence of failure resolves UNKNOWN but keeps the slot open', () => {
    const sim = new RecoverySlotSimulator();
    sim.dispatch({ type: 'tool_result', tool: 'write_file', outcome: 'timeout', idempotent: false, tag: { kind: 'new_intent', intentId: 'intent-A' } });
    sim.dispatch({ type: 'reconcile', tool: 'write_file', evidence: 'failure' });
    const snap = sim.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].unknownOutcomeTool).toBeNull();
    expect(snap[0].remaining).toBe(SLOT_ALLOWANCE - 1);
  });

  it('edge (c): a delegate_task child\'s failures debit the parent slot and cannot bypass an exhausted allowance', () => {
    const sim = new RecoverySlotSimulator();
    sim.dispatch({ type: 'tool_result', tool: 'search_api', outcome: 'invalid_args', idempotent: true, tag: { kind: 'new_intent', intentId: 'intent-A' } });
    // exhaust A's allowance with repairs
    sim.dispatch({ type: 'tool_result', tool: 'search_api', outcome: 'invalid_args', idempotent: true, tag: { kind: 'repair_of', intentId: 'intent-A' } });
    sim.dispatch({ type: 'tool_result', tool: 'search_api', outcome: 'invalid_args', idempotent: true, tag: { kind: 'repair_of', intentId: 'intent-A' } });
    expect(sim.snapshot()[0].remaining).toBe(0);

    // child dispatched for the delegated intent: parent exhausted -> honest refusal
    const child = sim.dispatch({
      type: 'delegate_task', childId: 'child-1', parentIntentId: 'intent-A',
      tool: 'run_code', outcome: 'invalid_args', idempotent: true,
    });
    expect(child.admitted).toBe(false);
    expect(child.reason).toBe('parent_allowance_exhausted_child_refused');
    expect(child.requiresHonestFailureReport).toBe(true);
    // no separate child ledger / slot appeared
    expect(sim.snapshot()).toHaveLength(1);
    expect(sim.finalAnswer().slots[0].status).toBe('exhausted');
  });

  it('edge (c) variant: a child failure debits a suspended parent slot rather than opening a bypass slot', () => {
    const sim = new RecoverySlotSimulator();
    sim.dispatch({ type: 'tool_result', tool: 'search_api', outcome: 'invalid_args', idempotent: true, tag: { kind: 'new_intent', intentId: 'intent-A' } });
    sim.dispatch({ type: 'tool_result', tool: 'write_file', outcome: 'invalid_args', idempotent: true, tag: { kind: 'new_intent', intentId: 'intent-B' } });
    // A is now suspended
    const before = sim.snapshot().find((s) => s.intentId === 'intent-A')!;
    const res = sim.dispatch({
      type: 'delegate_task', childId: 'child-1', parentIntentId: 'intent-A',
      tool: 'run_code', outcome: 'invalid_args', idempotent: true,
    });
    expect(res.admitted).toBe(true);
    expect(res.reason).toBe('child_failure_debited_suspended_parent_slot');
    const after = sim.snapshot().find((s) => s.intentId === 'intent-A')!;
    expect(after.debits).toBe(before.debits + 1);
    expect(sim.snapshot()).toHaveLength(2); // no third slot created
  });

  it('edge (d): recall during pending reconciliation is bounded by the polling cap of 2 and never mutates slots', () => {
    const sim = new RecoverySlotSimulator();
    sim.dispatch({ type: 'tool_result', tool: 'write_file', outcome: 'timeout', idempotent: false, tag: { kind: 'new_intent', intentId: 'intent-A' } });
    const before: RecoverySlot[] = sim.snapshot();
    const r1 = sim.dispatch({ type: 'recall' });
    expect(r1.admitted).toBe(true);
    // recall never mutates the ledger itself
    const mid = sim.snapshot();
    expect(mid.map((s) => ({ ...s, reconciliationPolls: 0 }))).toEqual(before.map((s) => ({ ...s, reconciliationPolls: 0 })));
    expect(mid[0].reconciliationPolls).toBe(1);
    expect(sim.dispatch({ type: 'recall' }).admitted).toBe(true);
    expect(sim.snapshot()[0].reconciliationPolls).toBe(2);
    const r3 = sim.dispatch({ type: 'recall' });
    expect(r3.admitted).toBe(false);
    expect(r3.reason).toBe('reconciliation_poll_cap_reached');
  });

  it('a plan revision cannot relabel a dispatch, create a new_intent tag, or reset a slot', () => {
    const sim = new RecoverySlotSimulator();
    sim.dispatch({ type: 'tool_result', tool: 'search_api', outcome: 'invalid_args', idempotent: true, tag: { kind: 'new_intent', intentId: 'intent-A' } });
    const before = sim.snapshot();
    const res = sim.dispatch({ type: 'plan_revision', attemptedRelabel: { kind: 'new_intent', intentId: 'intent-Z' } });
    expect(res.admitted).toBe(true);
    expect(sim.snapshot()).toEqual(before);
    // no slot for the relabeled intent exists
    expect(sim.snapshot().find((s) => s.intentId === 'intent-Z')).toBeUndefined();
  });

  it('tools in a suspended slot\'s tool_blocked set stay blocked for every intent until a supervisor reconciles', () => {
    const sim = new RecoverySlotSimulator();
    sim.dispatch({ type: 'tool_result', tool: 'write_file', outcome: 'invalid_args', idempotent: true, tag: { kind: 'new_intent', intentId: 'intent-A' } });
    // suspends A; write_file enters A's tool_blocked set
    sim.dispatch({ type: 'tool_result', tool: 'search_api', outcome: 'invalid_args', idempotent: true, tag: { kind: 'new_intent', intentId: 'intent-B' } });
    expect(sim.snapshot().find((s) => s.intentId === 'intent-A')!.toolBlocked).toContain('write_file');

    // blocked for the new intent too
    const blocked = sim.dispatch({ type: 'tool_result', tool: 'write_file', outcome: 'success', idempotent: true, tag: { kind: 'repair_of', intentId: 'intent-B' } });
    expect(blocked.admitted).toBe(false);
    expect(blocked.reason).toBe('tool_blocked_pending_reconciliation');

    // supervisor reconciliation unblocks it for every intent
    sim.dispatch({ type: 'reconcile', tool: 'write_file', evidence: 'failure' });
    const ok = sim.dispatch({ type: 'tool_result', tool: 'write_file', outcome: 'success', idempotent: true, tag: { kind: 'repair_of', intentId: 'intent-B' } });
    expect(ok.admitted).toBe(true);
    expect(ok.reason).toBe('repair_success_slot_closed');
  });

  it('hits the 2-slot cap: further new_intent work is refused and an honest partial-failure report is required', () => {
    const sim = new RecoverySlotSimulator();
    sim.dispatch({ type: 'tool_result', tool: 'search_api', outcome: 'invalid_args', idempotent: true, tag: { kind: 'new_intent', intentId: 'intent-A' } });
    sim.dispatch({ type: 'tool_result', tool: 'search_api', outcome: 'invalid_args', idempotent: true, tag: { kind: 'new_intent', intentId: 'intent-B' } });
    const res = sim.dispatch({ type: 'tool_result', tool: 'run_code', outcome: 'invalid_args', idempotent: true, tag: { kind: 'new_intent', intentId: 'intent-C' } });
    expect(res.admitted).toBe(false);
    expect(res.reason).toBe('slot_cap_reached_new_intent_refused');
    expect(res.requiresHonestFailureReport).toBe(true);
    expect(sim.snapshot()).toHaveLength(2);
    const answer = sim.finalAnswer();
    expect(answer.honestPartialFailure).toBe(true);
    expect(answer.slots.map((s) => s.intentId).sort()).toEqual(['intent-A', 'intent-B']);
  });

  it('a slot closes only on true success (run_code outer ok with nonzero exit does not close it)', () => {
    const sim = new RecoverySlotSimulator();
    sim.dispatch({ type: 'tool_result', tool: 'run_code', outcome: 'invalid_args', idempotent: true, tag: { kind: 'new_intent', intentId: 'intent-A' } });
    sim.dispatch({ type: 'tool_result', tool: 'run_code', outcome: 'nonzero_exit', idempotent: true, tag: { kind: 'repair_of', intentId: 'intent-A' } });
    expect(sim.snapshot()).toHaveLength(1);
    sim.dispatch({ type: 'tool_result', tool: 'run_code', outcome: 'success', idempotent: true, tag: { kind: 'repair_of', intentId: 'intent-A' } });
    expect(sim.snapshot()).toHaveLength(0);
  });

  it('a repair_of an unknown intent is refused (a repair tag can never open a slot)', () => {
    const sim = new RecoverySlotSimulator();
    const res = sim.dispatch({ type: 'tool_result', tool: 'search_api', outcome: 'invalid_args', idempotent: true, tag: { kind: 'repair_of', intentId: 'intent-X' } });
    expect(res.admitted).toBe(false);
    expect(res.reason).toBe('repair_of_unknown_intent');
    expect(sim.snapshot()).toHaveLength(0);
  });

  it('a repair of a suspended slot is refused (no fresh physical retry for a suspended intent)', () => {
    const sim = new RecoverySlotSimulator();
    sim.dispatch({ type: 'tool_result', tool: 'search_api', outcome: 'invalid_args', idempotent: true, tag: { kind: 'new_intent', intentId: 'intent-A' } });
    sim.dispatch({ type: 'tool_result', tool: 'search_api', outcome: 'invalid_args', idempotent: true, tag: { kind: 'new_intent', intentId: 'intent-B' } });
    const res = sim.dispatch({ type: 'tool_result', tool: 'search_api', outcome: 'success', idempotent: true, tag: { kind: 'repair_of', intentId: 'intent-A' } });
    expect(res.admitted).toBe(false);
    expect(res.reason).toBe('repair_of_suspended_slot_forbidden');
    expect(res.requiresHonestFailureReport).toBe(true);
  });
});
