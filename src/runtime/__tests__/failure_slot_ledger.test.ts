import { describe, it, expect } from 'vitest';
import { FailureSlotLedger } from '../failure_slot_ledger';

describe('FailureSlotLedger — reconciliation-exempt allowance', () => {
  it('permits exactly one read-only reconciliation per unknown-outcome event, even at allowance 0', () => {
    const ledger = new FailureSlotLedger(0);
    ledger.openFailureSlot();
    expect(ledger.recordUnknownOutcome('evt-1', 'write_file').permitted).toBe(true);

    expect(ledger.canReconcile('evt-1', 'read_file').permitted).toBe(true);
    expect(ledger.canReconcile('evt-1', 'write_file').permitted).toBe(false); // same tool refused
    expect(ledger.canReconcile('evt-1', 'read_file', { readOnly: false }).permitted).toBe(false);

    expect(ledger.reconcile('evt-1', 'read_file', 'inconclusive').permitted).toBe(true);
    // Second attempt for the same event is refused — one per event.
    expect(ledger.reconcile('evt-1', 'read_file', 'inconclusive').permitted).toBe(false);

    // Allowance untouched by reconciliation.
    expect(ledger.snapshot().allowanceRemaining).toBe(0);
  });

  it('re-declaring an event id does not mint a second reconciliation', () => {
    const ledger = new FailureSlotLedger(1);
    ledger.openFailureSlot();
    ledger.recordUnknownOutcome('evt-1', 'write_file');
    expect(ledger.recordUnknownOutcome('evt-1', 'write_file').permitted).toBe(false);
    ledger.reconcile('evt-1', 'read_file', 'inconclusive');
    expect(ledger.reconcile('evt-1', 'read_file', 'inconclusive').permitted).toBe(false);
  });

  it('reconciliation evidence of success does not itself close the slot; only true-success close does', () => {
    const ledger = new FailureSlotLedger(2);
    ledger.openFailureSlot();
    ledger.recordUnknownOutcome('evt-1', 'write_file');
    ledger.reconcile('evt-1', 'read_file', 'success');
    expect(ledger.snapshot().slotOpen).toBe(true);
    expect(ledger.closeOnTrueSuccess().permitted).toBe(true);
    expect(ledger.snapshot().slotOpen).toBe(false);
  });

  it('honest non-success finalize is always legal and always closes the slot (the stuck-slot exit)', () => {
    const ledger = new FailureSlotLedger(0);
    ledger.openFailureSlot();
    ledger.recordUnknownOutcome('evt-1', 'write_file');
    ledger.reconcile('evt-1', 'read_file', 'inconclusive');
    expect(ledger.canCloseOnTrueSuccess().permitted).toBe(false);
    expect(ledger.finalizeNonSuccess().permitted).toBe(true);
    expect(ledger.snapshot().slotOpen).toBe(false);
    expect(ledger.finalizeNonSuccess().permitted).toBe(false); // already closed
  });

  it('recall polls: capped at 2, never consume allowance, never change the slot', () => {
    const ledger = new FailureSlotLedger(1);
    ledger.openFailureSlot();
    ledger.recordUnknownOutcome('evt-1', 'write_file');
    expect(ledger.recallPoll().permitted).toBe(true);
    expect(ledger.recallPoll().permitted).toBe(true);
    expect(ledger.recallPoll().permitted).toBe(false);
    const snap = ledger.snapshot();
    expect(snap.allowanceRemaining).toBe(1);
    expect(snap.slotOpen).toBe(true);
  });

  it('delegate child results are evidence only; failures charge parent allowance; no new slot', () => {
    const ledger = new FailureSlotLedger(3);
    ledger.openFailureSlot();
    ledger.childResult('claimed-complete');
    expect(ledger.snapshot().slotOpen).toBe(true);
    expect(ledger.canCloseOnTrueSuccess().permitted).toBe(false); // claimed-complete is not host-verified
    ledger.childResult('failed');
    expect(ledger.snapshot().allowanceRemaining).toBe(2);
    expect(ledger.snapshot().slotOpen).toBe(true); // no new slot, parent still open
    expect(ledger.childResult('failed').permitted).toBe(true);
    expect(ledger.snapshot().allowanceRemaining).toBe(1);
  });

  it('outer status=ok with output.ok=false is classified as a failure at the output layer', () => {
    expect(FailureSlotLedger.classifyToolOutput('ok', false).isFailure).toBe(true);
    expect(FailureSlotLedger.classifyToolOutput('error', true).isFailure).toBe(true);
    expect(FailureSlotLedger.classifyToolOutput('ok', true).isFailure).toBe(false);
  });

  it('a child unknown outcome triggers the parent reconciliation exemption', () => {
    const ledger = new FailureSlotLedger(0);
    ledger.openFailureSlot();
    ledger.childResult('unknown');
    ledger.recordUnknownOutcome('child-1', 'delegate_task');
    expect(ledger.canReconcile('child-1', 'read_file').permitted).toBe(true);
  });
});
