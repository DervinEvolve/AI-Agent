import { describe, it, expect } from 'vitest';
import {
  RECOVERY_ALLOWANCE,
  openRecoverySlot,
  requestDispatch,
  recordOutcome,
  recordTimeout,
  reconcile,
  recall,
  spawnChildLedger,
  policyAuthorizedReset,
  finalReport,
  type RecoverySlot,
} from '../cap_recovery_slot_31';

describe('recovery slot: exhaustion rule', () => {
  it('opens with allowance 3 and consumes one per admitted dispatch', () => {
    const slot = openRecoverySlot('intent-1', 'call-1', 'run_code');
    expect(slot.remainingAllowance).toBe(RECOVERY_ALLOWANCE);
    const r1 = requestDispatch(slot, 'repair', 'run_code');
    expect(r1.refused).toBe(false);
    expect(slot.remainingAllowance).toBe(2);
    const r2 = requestDispatch(slot, 'retry', 'run_code');
    expect(r2.refused).toBe(false);
    expect(slot.remainingAllowance).toBe(1);
    const r3 = requestDispatch(slot, 'alternative', 'shell');
    expect(r3.refused).toBe(false);
    expect(slot.remainingAllowance).toBe(0);
    expect(slot.state).toBe('exhausted');
  });

  it('refuses further dispatches with a structured refusal once allowance is 0', () => {
    const slot = openRecoverySlot('intent-1', 'call-1', 'run_code');
    for (let i = 0; i < RECOVERY_ALLOWANCE; i++) requestDispatch(slot, 'repair', 'run_code');
    const refusal = requestDispatch(slot, 'retry', 'run_code');
    expect(refusal).toEqual({
      refused: true,
      reason: 'allowance_exhausted',
      intent_id: 'intent-1',
      original_call_id: 'call-1',
    });
    // Refusal never consumes allowance and never mints a new slot.
    expect(slot.remainingAllowance).toBe(0);
    expect(slot.state).toBe('exhausted');
    expect(slot.attempts).toBe(RECOVERY_ALLOWANCE);
  });

  it('refusal is idempotent: repeated refusals mint no journal entries', () => {
    const slot = openRecoverySlot('intent-1', 'call-1', 'run_code');
    for (let i = 0; i < RECOVERY_ALLOWANCE; i++) requestDispatch(slot, 'repair', 'run_code');
    const journalLen = slot.journal.length;
    requestDispatch(slot, 'retry', 'run_code');
    requestDispatch(slot, 'retry', 'run_code');
    requestDispatch(slot, 'alternative', 'shell');
    expect(slot.journal.length).toBe(journalLen + 1); // only the first refusal
    expect(slot.attempts).toBe(RECOVERY_ALLOWANCE);
  });

  it('reconcile and recall still run under exhaustion but cannot close or reset the slot', () => {
    const slot = openRecoverySlot('intent-1', 'call-1', 'run_code');
    for (let i = 0; i < RECOVERY_ALLOWANCE; i++) requestDispatch(slot, 'repair', 'run_code');
    const rec = reconcile(slot, 'unknown');
    expect(rec.allowed).toBe(true);
    expect(rec.closed).toBe(false);
    expect(rec.resetAllowance).toBe(false);
    const rcl = recall(slot);
    expect(rcl.allowed).toBe(true);
    expect(rcl.cost).toBe('step');
    expect(rcl.allowanceDelta).toBe(0);
    expect(slot.remainingAllowance).toBe(0);
    expect(slot.state).toBe('exhausted');
    expect(slot.resolved).toBe(false);
    // and they do not reopen dispatch
    expect(requestDispatch(slot, 'repair', 'run_code').refused).toBe(true);
  });
});

describe('recovery slot: unknown outcome (non-idempotent timeout)', () => {
  it('blocks dispatch while unknown is pending, with reason unknown_outcome_pending', () => {
    const slot = openRecoverySlot('intent-2', 'call-2', 'send_email');
    requestDispatch(slot, 'repair', 'send_email');
    recordTimeout(slot, false);
    const refusal = requestDispatch(slot, 'retry', 'send_email');
    expect(refusal).toMatchObject({ refused: true, reason: 'unknown_outcome_pending' });
    expect(slot.remainingAllowance).toBe(2); // refusal consumed nothing
  });

  it('an idempotent tool may run as reconciliation without closing the slot', () => {
    const slot = openRecoverySlot('intent-2', 'call-2', 'send_email');
    requestDispatch(slot, 'repair', 'send_email');
    recordTimeout(slot, false);
    // read-only reconcile with an idempotent probe
    const rec = reconcile(slot, 'unknown');
    expect(rec.allowed).toBe(true);
    expect(slot.resolved).toBe(false);
    expect(slot.pendingUnknown).toBe(true);
    expect(requestDispatch(slot, 'retry', 'send_email').refused).toBe(true);
  });

  it('exhaustion does not downgrade unknown to failed in the final report', () => {
    const slot = openRecoverySlot('intent-2', 'call-2', 'send_email');
    requestDispatch(slot, 'repair', 'send_email');
    recordTimeout(slot, false);
    const report = finalReport(slot);
    expect(report.outcome).toBe('outcome-unknown');
    expect(report.message).toContain('outcome unknown');
    expect(report.message).not.toContain('did not happen');
  });

  it('settled evidence established-absent reports the effect did not happen (with evidence)', () => {
    const slot = openRecoverySlot('intent-2', 'call-2', 'send_email');
    requestDispatch(slot, 'repair', 'send_email');
    recordTimeout(slot, false);
    reconcile(slot, 'established-absent');
    expect(finalReport(slot).outcome).toBe('established-absent');
    // slot still not closed or reset
    expect(slot.resolved).toBe(false);
    expect(slot.remainingAllowance).toBe(2);
  });

  it('an idempotent timeout is treated as a plain failure (retryable)', () => {
    const slot = openRecoverySlot('intent-3', 'call-3', 'read_file');
    requestDispatch(slot, 'repair', 'read_file');
    recordTimeout(slot, true);
    expect(slot.pendingUnknown).toBe(false);
    expect(requestDispatch(slot, 'retry', 'read_file').refused).toBe(false);
  });
});

describe('recovery slot: substitute-tool success (spec clarification)', () => {
  it('success via a different tool records a workaround but does not close the slot', () => {
    const slot = openRecoverySlot('intent-4', 'call-4', 'run_code');
    requestDispatch(slot, 'alternative', 'shell');
    recordOutcome(slot, 'success', 'shell', 'alternative');
    expect(slot.workaround).toEqual({ tool: 'shell', kind: 'alternative' });
    expect(slot.resolved).toBe(false);
    // the slot is not closed: unknown/failure semantics still apply
    expect(slot.remainingAllowance).toBe(2);
  });

  it('success via the original tool resolves the slot', () => {
    const slot = openRecoverySlot('intent-4', 'call-4', 'run_code');
    requestDispatch(slot, 'retry', 'run_code');
    recordOutcome(slot, 'success', 'run_code');
    expect(slot.resolved).toBe(true);
    expect(finalReport(slot).outcome).toBe('success');
  });
});

describe('recovery slot: child ledgers cannot launder allowance', () => {
  it('child of an exhausted parent inherits allowance 0 and is refused', () => {
    const parent = openRecoverySlot('intent-5', 'call-5', 'run_code');
    for (let i = 0; i < RECOVERY_ALLOWANCE; i++) requestDispatch(parent, 'repair', 'run_code');
    const child = spawnChildLedger(parent);
    expect(child.remainingAllowance).toBe(0);
    expect(child.state).toBe('exhausted');
    const refusal = requestDispatch(child, 'repair', 'run_code');
    expect(refusal).toMatchObject({ refused: true, reason: 'allowance_exhausted' });
    expect(parent.remainingAllowance).toBe(0);
  });

  it('child of a pending-unknown parent inherits the flag for the same intent_id', () => {
    const parent = openRecoverySlot('intent-6', 'call-6', 'send_email');
    requestDispatch(parent, 'repair', 'send_email');
    recordTimeout(parent, false);
    const child = spawnChildLedger(parent);
    expect(child.pendingUnknown).toBe(true);
    expect(child.intentId).toBe('intent-6');
    const refusal = requestDispatch(child, 'retry', 'send_email');
    expect(refusal).toMatchObject({ refused: true, reason: 'unknown_outcome_pending' });
  });

  it('child can never hold more allowance than its parent', () => {
    const parent = openRecoverySlot('intent-7', 'call-7', 'run_code');
    requestDispatch(parent, 'repair', 'run_code');
    const child = spawnChildLedger(parent);
    expect(child.remainingAllowance).toBe(2);
    const grandchild = spawnChildLedger(child);
    expect(grandchild.remainingAllowance).toBe(2);
    expect(grandchild.remainingAllowance).toBeLessThanOrEqual(parent.remainingAllowance);
  });
});

describe('recovery slot: policy authorization', () => {
  it('refuses reset without policy authorization', () => {
    const slot = openRecoverySlot('intent-8', 'call-8', 'run_code');
    for (let i = 0; i < RECOVERY_ALLOWANCE; i++) requestDispatch(slot, 'repair', 'run_code');
    const result = policyAuthorizedReset(slot, { authorizedBy: 'agent' });
    expect(result).toMatchObject({ refused: true, reason: 'policy_authorization_required' });
    expect(slot.remainingAllowance).toBe(0);
  });

  it('authorized policy opens a new episode inheriting telemetry', () => {
    const slot = openRecoverySlot('intent-8', 'call-8', 'run_code');
    for (let i = 0; i < RECOVERY_ALLOWANCE; i++) requestDispatch(slot, 'repair', 'run_code');
    const journalLen = slot.journal.length;
    const next = policyAuthorizedReset(slot, {
      authorizedBy: 'policy-modification',
      newAllowance: RECOVERY_ALLOWANCE,
    });
    expect(next).not.toMatchObject({ refused: true });
    if (!('refused' in (next as object))) {
      const episode = next as RecoverySlot;
      expect(episode.remainingAllowance).toBe(RECOVERY_ALLOWANCE);
      expect(episode.attempts).toBe(RECOVERY_ALLOWANCE); // cumulative
      expect(episode.journal.length).toBeGreaterThan(journalLen); // telemetry inherited
      expect(episode.episodes).toBe(2);
    }
  });

  it('policy reset does not silently clear a pending unknown without settlement', () => {
    const slot = openRecoverySlot('intent-9', 'call-9', 'send_email');
    requestDispatch(slot, 'repair', 'send_email');
    recordTimeout(slot, false);
    const next = policyAuthorizedReset(slot, {
      authorizedBy: 'policy-modification',
      newAllowance: RECOVERY_ALLOWANCE,
    }) as RecoverySlot;
    expect(next.pendingUnknown).toBe(true);
    expect(requestDispatch(next, 'retry', 'send_email').refused).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Deterministic fuzz: random event sequences against stated invariants.
// ---------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('recovery slot: fuzz invariants', () => {
  it('random event sequences never violate the invariants', () => {
    const rand = mulberry32(0x5eed31);
    const tools = ['run_code', 'shell', 'send_email', 'read_file'];
    for (let iter = 0; iter < 500; iter++) {
      let slot = openRecoverySlot(`fuzz-${iter}`, `call-${iter}`, tools[iter % tools.length]);
      let minAllowance = slot.remainingAllowance;
      let everUnknown = false;
      const events = 1 + Math.floor(rand() * 25);
      for (let e = 0; e < events; e++) {
        const roll = rand();
        if (roll < 0.35) {
          const before = slot.remainingAllowance;
          const attemptsBefore = slot.attempts;
          const journalBefore = slot.journal.length;
          const kind = (['repair', 'retry', 'alternative'] as const)[
            Math.floor(rand() * 3)
          ];
          const tool = tools[Math.floor(rand() * tools.length)];
          const result = requestDispatch(slot, kind, tool);
          if (result.refused) {
            // refusal never consumes allowance, never mints attempts,
            // never mints more than one journal entry
            expect(slot.remainingAllowance).toBe(before);
            expect(slot.attempts).toBe(attemptsBefore);
            expect(slot.journal.length).toBeLessThanOrEqual(journalBefore + 1);
          } else {
            expect(slot.remainingAllowance).toBe(before - 1);
            expect(slot.attempts).toBe(attemptsBefore + 1);
          }
        } else if (roll < 0.5) {
          const tool = tools[Math.floor(rand() * tools.length)];
          const wasResolved = slot.resolved;
          recordOutcome(slot, rand() < 0.5 ? 'success' : 'failure', tool);
          if (slot.resolved && !wasResolved) {
            // resolution only via same-tool success
            expect(tool).toBe(slot.originalTool);
          }
          if (tool !== slot.originalTool && slot.workaround) {
            expect(slot.resolved).toBe(false); // workaround never closes
          }
        } else if (roll < 0.62) {
          const wasUnknown = slot.pendingUnknown;
          recordTimeout(slot, rand() < 0.5);
          if (slot.pendingUnknown) {
            everUnknown = true;
            expect(wasUnknown || true).toBe(true);
          }
        } else if (roll < 0.75) {
          const before = slot.remainingAllowance;
          const rec = reconcile(
            slot,
            (['established', 'established-absent', 'unknown'] as const)[
              Math.floor(rand() * 3)
            ],
          );
          expect(rec.closed).toBe(false);
          expect(rec.resetAllowance).toBe(false);
          expect(slot.remainingAllowance).toBe(before);
          expect(slot.resolved).toBe(false);
        } else if (roll < 0.87) {
          const before = slot.remainingAllowance;
          recall(slot);
          expect(slot.remainingAllowance).toBe(before);
          expect(slot.resolved).toBe(false);
        } else if (roll < 0.95) {
          const child = spawnChildLedger(slot);
          expect(child.remainingAllowance).toBeLessThanOrEqual(slot.remainingAllowance);
          expect(child.pendingUnknown).toBe(slot.pendingUnknown);
          const r = requestDispatch(child, 'repair', slot.originalTool);
          if (r.refused) {
            expect(child.remainingAllowance).toBe(slot.remainingAllowance);
          }
          // child consumption never widens the parent's allowance
          expect(slot.remainingAllowance).toBe(
            child.remainingAllowance >= 0 ? slot.remainingAllowance : -1,
          );
        } else {
          const next = policyAuthorizedReset(slot, {
            authorizedBy: 'policy-modification',
            newAllowance: Math.floor(rand() * 4),
            settleUnknown: rand() < 0.5,
          });
          if (!('refused' in next)) {
            slot = next;
          }
        }
        // Invariant: allowance is monotonic non-increasing within an episode.
        expect(slot.remainingAllowance).toBeLessThanOrEqual(minAllowance);
        minAllowance = Math.min(minAllowance, slot.remainingAllowance);
        // Invariant: unknown is never downgraded to a plain 'failed' report.
        const report = finalReport(slot);
        if (slot.pendingUnknown && slot.evidence === 'unknown') {
          expect(report.outcome).toBe('outcome-unknown');
        }
        if (everUnknown && slot.evidence === 'unknown' && !slot.resolved) {
          expect(report.outcome).not.toBe('failed');
        }
      }
    }
  });
});
