import { describe, it, expect } from 'vitest';
import { FailureSlotLedger, mulberry32 } from '../failure_slot_ledger';

/**
 * Targeted tests for the reconciliation-exempt-allowance amendment.
 *
 * These pin the exact reachable state the prose rules previously left
 * contradictory: allowance_remaining = 0, an unknown-outcome event with no
 * success evidence. Under the amendment that state must still allow (a) the
 * one read-only reconciliation call and (b) an honest non-success finalize,
 * so the slot can never be stuck.
 */
describe('FailureSlotLedger — the pre-amendment stuck state is now escapable', () => {
  it('permits reconciliation and an honest finalize at allowance 0 with no success evidence', () => {
    const ledger = new FailureSlotLedger(0);
    expect(ledger.openFailureSlot().permitted ?? true).toBe(true);
    expect(ledger.recordUnknownOutcome('evt-stuck', 'http_post').permitted).toBe(true);

    // The naive reading refuses the evidence check here (allowance 0).
    // The amendment must permit it.
    const check = ledger.canReconcile('evt-stuck', 'http_get');
    expect(check.permitted).toBe(true);

    const result = ledger.reconcile('evt-stuck', 'http_get', 'inconclusive');
    expect(result.permitted).toBe(true);

    // Reconciliation consumed no allowance and closed nothing.
    const snap = ledger.snapshot();
    expect(snap.allowanceRemaining).toBe(0);
    expect(snap.slotOpen).toBe(true);

    // Honest non-success finalize is always legal and closes the slot.
    expect(ledger.finalize().permitted).toBe(true);
    expect(ledger.snapshot().slotOpen).toBe(false);
  });

  it('reconciliation with success evidence at allowance 0 allows a true-success close, not an automatic one', () => {
    const ledger = new FailureSlotLedger(0);
    ledger.openFailureSlot();
    ledger.recordUnknownOutcome('evt-ok', 'write_file');
    ledger.reconcile('evt-ok', 'read_file', 'success');

    // Evidence alone does not close the slot.
    expect(ledger.snapshot().slotOpen).toBe(true);
    // But the true-success close is now permitted.
    expect(ledger.closeOnTrueSuccess().permitted).toBe(true);
    expect(ledger.snapshot().slotOpen).toBe(false);
  });

  it('refuses reconciliation with the same tool, a non-read-only call, or a second attempt', () => {
    const ledger = new FailureSlotLedger(3);
    ledger.openFailureSlot();
    ledger.recordUnknownOutcome('evt-1', 'write_file');

    expect(ledger.canReconcile('evt-1', 'write_file').permitted).toBe(false);
    expect(ledger.canReconcile('evt-1', 'read_file', { readOnly: false }).permitted).toBe(false);

    expect(ledger.reconcile('evt-1', 'read_file', 'inconclusive').permitted).toBe(true);
    expect(ledger.reconcile('evt-1', 'stat_file', 'inconclusive').permitted).toBe(false);
    expect(ledger.snapshot().allowanceRemaining).toBe(3);
  });

  it('an unknown-outcome event for an unknown id cannot be reconciled', () => {
    const ledger = new FailureSlotLedger(2);
    ledger.openFailureSlot();
    expect(ledger.canReconcile('evt-never-recorded', 'read_file').permitted).toBe(false);
    expect(ledger.reconcile('evt-never-recorded', 'read_file', 'success').permitted).toBe(false);
  });
});

describe('FailureSlotLedger — seeded randomized walk never reaches a stuck slot', () => {
  it('for many seeds, whenever the slot is open an honest finalize is permitted', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rng = mulberry32(seed);
      const ledger = new FailureSlotLedger(Math.floor(rng() * 3)); // allowance 0..2
      ledger.openFailureSlot();
      let events = 0;

      for (let step = 0; step < 40; step++) {
        const roll = Math.floor(rng() * 4);
        if (roll === 0) {
          events += 1;
          ledger.recordUnknownOutcome(`evt-${seed}-${events}`, 'http_post');
        } else if (roll === 1 && events > 0) {
          const id = `evt-${seed}-${1 + Math.floor(rng() * events)}`;
          ledger.reconcile(id, 'http_get', rng() < 0.5 ? 'success' : 'inconclusive');
        } else if (roll === 2) {
          // Try a true-success close; usually refused without evidence.
          ledger.closeOnTrueSuccess();
        } else {
          // Core invariant: while the slot is open, finalize must be legal.
          const snap = ledger.snapshot();
          if (snap.slotOpen) {
            expect({ seed, step, finalize: ledger.finalize().permitted }).toEqual({
              seed,
              step,
              finalize: true,
            });
            expect(ledger.snapshot().slotOpen).toBe(false);
            break; // slot closed; walk for this seed is done
          }
        }
      }

      // If the walk ended with the slot still open, finalize must still work.
      if (ledger.snapshot().slotOpen) {
        expect(ledger.finalize().permitted).toBe(true);
        expect(ledger.snapshot().slotOpen).toBe(false);
      }
    }
  });
});
