import { describe, it, expect } from 'vitest';
import { FailureSlotLedger, mulberry32 } from '../failure_slot_ledger';

type Op =
  | { kind: 'open' }
  | { kind: 'unknown'; id: number; tool: string }
  | { kind: 'reconcile'; id: number; tool: string; evidence: 'success' | 'inconclusive' }
  | { kind: 'closeSuccess' }
  | { kind: 'finalize' }
  | { kind: 'recall' }
  | { kind: 'child'; outcome: 'claimed-complete' | 'failed' | 'unknown' }
  | { kind: 'output'; outer: 'ok' | 'error'; outputOk: boolean };

const TOOLS = ['write_file', 'read_file', 'delegate_task', 'http_post', 'http_get'];

function randomOp(rng: () => number, counter: { n: number }): Op {
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rng() * xs.length)];
  switch (Math.floor(rng() * 8)) {
    case 0:
      return { kind: 'open' };
    case 1:
      return { kind: 'unknown', id: counter.n++, tool: pick(TOOLS) };
    case 2:
      return {
        kind: 'reconcile',
        id: Math.floor(rng() * Math.max(1, counter.n)),
        tool: pick(TOOLS),
        evidence: rng() < 0.5 ? 'success' : 'inconclusive',
      };
    case 3:
      return { kind: 'closeSuccess' };
    case 4:
      return { kind: 'finalize' };
    case 5:
      return { kind: 'recall' };
    case 6:
      return {
        kind: 'child',
        outcome: pick(['claimed-complete', 'failed', 'unknown'] as const),
      };
    default:
      return { kind: 'output', outer: rng() < 0.7 ? 'ok' : 'error', outputOk: rng() < 0.5 };
  }
}

/**
 * Model-based property fuzz of the failure-slot state machine.
 *
 * Invariants (the amendment's core claims):
 *  I1. While the slot is open, an honest non-success finalize is ALWAYS
 *      permitted — no reachable state where close and finalize are both
 *      refused (no stuck slot).
 *  I2. Reconciliation for an unreconciled event with a different, read-only
 *      tool is permitted regardless of allowance (never both permitted and
 *      refused for the same (event, tool)).
 *  I3. Reconciliation never changes allowance or slot state.
 *  I4. Recall polls never change allowance or slot state.
 *  I5. Child results never close the slot and never create success evidence.
 *  I6. Allowance never goes negative; recall polls never exceed 2.
 */
describe('failure slot ledger — model-based fuzz', () => {
  it('holds all invariants over seeded random op sequences', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const rng = mulberry32(seed);
      const ledger = new FailureSlotLedger(Math.floor(rng() * 4));
      const counter = { n: 0 };
      const ops: Op[] = [];
      const steps = 60;

      for (let i = 0; i < steps; i++) {
        const op = randomOp(rng, counter);
        ops.push(op);
        const before = ledger.snapshot();

        switch (op.kind) {
          case 'open':
            ledger.openFailureSlot();
            break;
          case 'unknown':
            ledger.recordUnknownOutcome(`evt-${op.id}`, op.tool);
            break;
          case 'reconcile':
            ledger.reconcile(`evt-${op.id}`, op.tool, op.evidence);
            break;
          case 'closeSuccess':
            ledger.closeOnTrueSuccess();
            break;
          case 'finalize':
            ledger.finalizeNonSuccess();
            break;
          case 'recall':
            ledger.recallPoll();
            break;
          case 'child':
            ledger.childResult(op.outcome);
            break;
          case 'output':
            FailureSlotLedger.classifyToolOutput(op.outer, op.outputOk);
            break;
        }

        const after = ledger.snapshot();

        // I1: no stuck slot.
        if (after.slotOpen) {
          expect(
            ledger.canFinalizeNonSuccess().permitted,
            `seed=${seed} step=${i} op=${JSON.stringify(op)}: stuck slot (finalize refused while open)`
          ).toBe(true);
        }

        // I2: reconciliation exemption holds even at allowance 0.
        const unreconciled = after.unknownOutcomeEvents.find((e) => !e.reconciled);
        if (after.slotOpen && unreconciled) {
          const other = TOOLS.find((t) => t !== unreconciled.tool)!;
          const d = ledger.canReconcile(unreconciled.id, other);
          expect(
            d.permitted,
            `seed=${seed} step=${i}: reconciliation refused for unreconciled event at allowance=${after.allowanceRemaining}`
          ).toBe(true);
          // Consistency: same query never both permitted and refused.
          expect(ledger.canReconcile(unreconciled.id, other).permitted).toBe(true);
          // Same tool is refused — different-tool rule.
          expect(ledger.canReconcile(unreconciled.id, unreconciled.tool).permitted).toBe(false);
        }

        // I3: reconcile / recall / child never change allowance or slot by themselves.
        if (op.kind === 'reconcile' || op.kind === 'recall') {
          expect(after.allowanceRemaining).toBe(before.allowanceRemaining);
          expect(after.slotOpen).toBe(before.slotOpen);
        }
        if (op.kind === 'child') {
          expect(after.slotOpen).toBe(before.slotOpen);
          if (op.outcome !== 'failed') {
            expect(after.allowanceRemaining).toBe(before.allowanceRemaining);
          } else {
            expect(after.allowanceRemaining).toBe(Math.max(0, before.allowanceRemaining - 1));
          }
        }

        // I5: child results never create success evidence.
        if (op.kind === 'child' && !before.successEvidence) {
          expect(after.successEvidence).toBe(false);
        }

        // I6: bounds.
        expect(after.allowanceRemaining).toBeGreaterThanOrEqual(0);
        expect(after.recallPollsUsed).toBeLessThanOrEqual(2);
      }

      // Terminal sanity: whatever happened, the slot can always be closed.
      if (ledger.snapshot().slotOpen) {
      expect(ledger.finalizeNonSuccess().permitted).toBe(true);
      }
    }
  });

  it('exhaustive small-state enumeration: no reachable state refuses both close and finalize', () => {
    // Enumerate slot open/closed x allowance 0..2 x {unknown event pending, reconciled-success, reconciled-inconclusive, none}.
    for (const slotOpen of [true, false]) {
      for (const allowance of [0, 1, 2]) {
        for (const evState of ['none', 'pending', 'success', 'inconclusive'] as const) {
          const ledger = new FailureSlotLedger(allowance);
          if (slotOpen) {
            ledger.openFailureSlot();
            if (evState !== 'none') {
              ledger.recordUnknownOutcome('evt-0', 'write_file');
              if (evState !== 'pending') {
                ledger.reconcile('evt-0', 'read_file', evState);
              }
            }
          }
          const snap = ledger.snapshot();
          expect(snap.slotOpen).toBe(slotOpen);
          if (slotOpen) {
            const canClose = ledger.canCloseOnTrueSuccess().permitted;
            const canFinalize = ledger.canFinalizeNonSuccess().permitted;
            expect(
              canClose || canFinalize,
              `slotOpen=${slotOpen} allowance=${allowance} ev=${evState}: neither close nor finalize permitted`
            ).toBe(true);
            expect(canFinalize).toBe(true); // finalize is unconditionally legal while open
          }
        }
      }
    }
  });

  it('demonstrates the pre-amendment contradiction: naive allowance-gated rules reach a stuck slot; the amendment does not', () => {
    // Naive ruleset (as the prose spec could be read): every dispatch,
    // INCLUDING the evidence check, consumes allowance; finalize requires
    // either success evidence or allowance to retry. At allowance 0 with an
    // unknown outcome this is a stuck slot.
    const naive = {
      allowance: 0,
      slotOpen: true,
      evidence: 'none' as 'none' | 'success' | 'inconclusive',
      canReconcile() {
        return this.allowance > 0; // gated on allowance — the bug
      },
      canClose() {
        return this.evidence === 'success';
      },
      canFinalize() {
        return this.allowance > 0; // finalize gated on retry budget — the bug
      },
    };
    expect(naive.canReconcile()).toBe(false);
    expect(naive.canClose()).toBe(false);
    expect(naive.canFinalize()).toBe(false); // stuck: neither close nor finalize

    // The amended ledger, same situation, is never stuck.
    const amended = new FailureSlotLedger(0);
    amended.openFailureSlot();
    amended.recordUnknownOutcome('evt-1', 'write_file');
    expect(amended.canReconcile('evt-1', 'read_file').permitted).toBe(true);
    amended.reconcile('evt-1', 'read_file', 'inconclusive');
    expect(amended.canCloseOnTrueSuccess().permitted).toBe(false);
    expect(amended.finalizeNonSuccess().permitted).toBe(true);
    expect(amended.snapshot().slotOpen).toBe(false);
  });
});
