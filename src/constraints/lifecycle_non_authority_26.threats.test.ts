import { describe, it, expect } from 'vitest';
import {
  verifyDispatch,
  validateCompletion,
  validateDependencyGraph,
  areStatusFieldsSeparate,
  proposeCompensation,
  sanitizeForStorage,
  brandAsLifecycleManager,
  acceptToolArgumentSource,
  type ApprovalToken,
  type OpStatus,
  type CompletionStatus,
} from './lifecycle_non_authority_26';

function token(actionId: string, fingerprint: string, nowMs = 0): ApprovalToken {
  return {
    token: 'tok',
    actionFingerprint: fingerprint,
    nonce: 'n',
    freshForActionId: actionId,
    expiresAtMs: nowMs + 10_000,
  };
}

describe('con_lifecycle_non_authority_26 threats', () => {
  // 1
  it("a task in 'ready'/'running' cannot authorize a dispatch without a fresh token", () => {
    for (const state of ['ready', 'running'] as const) {
      const d = verifyDispatch({
        taskId: 't',
        taskState: state,
        executionMode: 'interactive',
        actionId: 'dispatch_browser',
        actionFingerprint: 'fp',
        irreversible: true,
        hitlGated: true,
      });
      expect(d).toEqual({ allowed: false, reason: 'requires_fresh_approval_token' });
    }
  });

  // 2
  it('a satisfied approval-kind dependency does not substitute for a token at dispatch', () => {
    const d = verifyDispatch({
      taskId: 't',
      taskState: 'ready',
      executionMode: 'interactive',
      actionId: 'vault_read',
      actionFingerprint: 'fp',
      irreversible: true,
      hitlGated: true,
      approvalDependencySatisfied: true,
      // no approvalToken supplied — the satisfied edge must NOT stand in for it
    });
    expect(d).toEqual({ allowed: false, reason: 'approval_dependency_not_a_token' });
  });

  // 3
  it('lifecycle state cannot clear taint or convert tainted evidence into trusted args', () => {
    // Tainted evidence can never drive completion regardless of lifecycle state.
    const res = validateCompletion([{ kind: 'trace', ref: 'r', verified: true, tainted: true }]);
    expect(res).toEqual({ ok: false, reason: 'tainted_evidence' });
    // And the manager is never an argument source, so it cannot launder taint into args.
    const mgr = brandAsLifecycleManager({ arg: 'tainted-url' });
    expect(acceptToolArgumentSource(mgr, false)).toBe(false);
  });

  // 4
  it('a non_interactive_background task at an irreversible step is policy_blocked despite prior approval', () => {
    const d = verifyDispatch({
      taskId: 't',
      taskState: 'running',
      executionMode: 'non_interactive_background',
      actionId: 'send_email',
      actionFingerprint: 'fp',
      irreversible: true,
      hitlGated: true,
      approvalDependencySatisfied: true,
      // even a matching token cannot flip a background HITL-gated step
      approvalToken: token('send_email', 'fp', 0),
      nowMs: 0,
    });
    expect(d).toEqual({ allowed: false, reason: 'policy_blocked' });
  });

  // 5
  it("transition to 'completed' with only tainted evidence is rejected as taint failure", () => {
    const res = validateCompletion([
      { kind: 'milestone', ref: 'm1', verified: true, tainted: true },
      { kind: 'trace', ref: 't1', verified: true, tainted: true },
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('tainted_evidence');
  });

  // 6
  it('op_status=ok does not imply completion_status=succeeded; fields independent', () => {
    const opStatus: OpStatus = 'ok';
    const completionStatus: CompletionStatus = 'incomplete';
    // The operation succeeded but the task is not complete.
    expect(opStatus).toBe('ok');
    expect(completionStatus).not.toBe('succeeded');
    expect(areStatusFieldsSeparate({ opStatus, taskState: 'running', completionStatus })).toBe(true);
  });

  // 7
  it('a dependency that would form a cycle is rejected with cycle_detected', () => {
    const res = validateDependencyGraph([
      { from: 'a', to: 'b', kind: 'ordering' },
      { from: 'b', to: 'c', kind: 'ordering' },
      { from: 'c', to: 'a', kind: 'ordering' },
    ]);
    expect(res).toEqual({ ok: false, reason: 'cycle_detected' });
  });

  // 8
  it('propose_compensation output cannot execute; irreversible compensation still needs fresh HITL token', () => {
    const plan = proposeCompensation([{ description: 'reverse charge', irreversible: true }]);
    expect(plan.advisory).toBe(true);
    // The plan is inert data — dispatching the irreversible comp step still gates.
    const d = verifyDispatch({
      taskId: 't',
      taskState: 'running',
      executionMode: 'interactive',
      actionId: 'compensate_charge',
      actionFingerprint: 'fp',
      irreversible: true,
      hitlGated: true,
    });
    expect(d).toEqual({ allowed: false, reason: 'requires_fresh_approval_token' });
  });

  // 9
  it('task records and state history redact apparent secrets and never contain tokens/handles/cookies', () => {
    const record = {
      taskId: 't',
      history: [
        { at: 1, approval_token: 'tok_live', vaultHandle: 'vh', cookie: 'sid=1' },
        { at: 2, pending_approval_ids: ['p1', 'p2'] },
      ],
      note: 'ok',
    };
    const out = sanitizeForStorage(record);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('tok_live');
    expect(serialized).not.toContain('vh');
    expect(serialized).not.toContain('sid=1');
    expect(serialized).not.toContain('p1');
    expect(out.note).toBe('ok');
  });

  // 10
  it('the manager cannot be passed as an argument source to a tool adapter without independent validation', () => {
    const mgr = brandAsLifecycleManager({ toolArgs: { url: 'https://x' }, grantId: 'g1' });
    // Adapter default (no independent validation) must refuse.
    expect(acceptToolArgumentSource(mgr)).toBe(false);
    // Only independently validated args may proceed.
    expect(acceptToolArgumentSource(mgr, true)).toBe(true);
  });
});
