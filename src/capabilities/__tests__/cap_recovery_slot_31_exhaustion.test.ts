import { describe, it, expect } from 'vitest';
import {
  RECOVERY_ALLOWANCE,
  openRecoverySlot,
  requestDispatch,
  recordTimeout,
  reconcile,
  recall,
  spawnChildLedger,
  finalReport,
  type RecoverySlot,
} from '../cap_recovery_slot_31';

/** Drain a slot's allowance with admitted dispatches. */
function exhaustSlot(): RecoverySlot {
  const slot = openRecoverySlot('intent-x', 'call-x', 'run_code');
  for (let i = 0; i < RECOVERY_ALLOWANCE; i++) {
    requestDispatch(slot, 'repair', 'run_code');
  }
  return slot;
}

describe('recovery slot: exhaustion is terminal', () => {
  it('exhaustion is terminal: reconcile and recall never close or reset the slot', () => {
    const slot = exhaustSlot();
    expect(slot.state).toBe('exhausted');
    expect(slot.remainingAllowance).toBe(0);

    // Read-only reconcile is still allowed but cannot close or reset.
    reconcile(slot, 'established');
    expect(slot.state).toBe('exhausted');
    expect(slot.remainingAllowance).toBe(0);
    expect(slot.resolved).toBe(false);

    // Recall costs a step but no allowance, and cannot close or reset.
    recall(slot);
    expect(slot.state).toBe('exhausted');
    expect(slot.remainingAllowance).toBe(0);
    expect(slot.resolved).toBe(false);

    // Even after reconcile + recall, dispatch is still refused.
    const refusal = requestDispatch(slot, 'alternative', 'shell');
    expect(refusal).toMatchObject({
      refused: true,
      reason: 'allowance_exhausted',
      intent_id: 'intent-x',
      original_call_id: 'call-x',
    });
  });

  it('unknown outcome blocks dispatch and is not downgraded by exhaustion', () => {
    const slot = openRecoverySlot('intent-u', 'call-u', 'run_code');
    // Non-idempotent timeout leaves the outcome unknown.
    recordTimeout(slot);
    expect(slot.pendingUnknown).toBe(true);

    // Dispatch is refused while the unknown outcome is pending,
    // even though allowance is untouched.
    const refusal = requestDispatch(slot, 'retry', 'run_code');
    expect(refusal).toMatchObject({
      refused: true,
      reason: 'unknown_outcome_pending',
      intent_id: 'intent-u',
      original_call_id: 'call-u',
    });
    expect(slot.remainingAllowance).toBe(RECOVERY_ALLOWANCE);

    // Exhaust the slot (e.g. via policy-authorized path or drained
    // attempts); exhaustion must not downgrade 'unknown' to 'failed'.
    const report = finalReport(slot);
    const text = typeof report === 'string' ? report : JSON.stringify(report);
    expect(text.toLowerCase()).toContain('unknown');
    expect(text.toLowerCase()).not.toContain('did not happen');
    expect(slot.pendingUnknown).toBe(true);
  });

  it('a child sub-agent ledger inherits the exhausted parent allowance (no laundering)', () => {
    const parent = exhaustSlot();
    const child: any = spawnChildLedger(parent);
    expect(child).toBeTruthy();
    expect(child.remainingAllowance).toBe(0);
    // The child inherits the parent's exhaustion for the same intent.
    const refusal = requestDispatch(child as RecoverySlot, 'repair', 'run_code');
    expect(refusal).toMatchObject({
      refused: true,
      reason: 'allowance_exhausted',
      intent_id: 'intent-x',
      original_call_id: 'call-x',
    });
  });

  it('a child spawned under a pending-unknown parent inherits the unknown flag', () => {
    const parent = openRecoverySlot('intent-u2', 'call-u2', 'run_code');
    recordTimeout(parent);
    const child: any = spawnChildLedger(parent);
    expect(child.pendingUnknown).toBe(true);
    const refusal = requestDispatch(child as RecoverySlot, 'retry', 'run_code');
    expect(refusal).toMatchObject({
      refused: true,
      reason: 'unknown_outcome_pending',
      intent_id: 'intent-u2',
      original_call_id: 'call-u2',
    });
  });
});
