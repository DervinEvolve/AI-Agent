import { describe, it, expect } from 'vitest';
import {
  CONSTRAINT_ID,
  verifyDispatch,
  validateCompletion,
  validateDependencyGraph,
  areStatusFieldsSeparate,
  proposeCompensation,
  sanitizeForStorage,
  isForbiddenStorageKey,
  brandAsLifecycleManager,
  isLifecycleManager,
  acceptToolArgumentSource,
  DEFAULT_DEP_CAPS,
  type ApprovalToken,
} from './lifecycle_non_authority_26';

function freshToken(actionId: string, fingerprint: string, nowMs = 0): ApprovalToken {
  return {
    token: 'tok_' + Math.random().toString(36).slice(2),
    actionFingerprint: fingerprint,
    nonce: 'nonce_' + Math.random().toString(36).slice(2),
    freshForActionId: actionId,
    expiresAtMs: nowMs + 10_000,
  };
}

describe('con_lifecycle_non_authority_26 unit', () => {
  it('exposes a stable constraint id', () => {
    expect(CONSTRAINT_ID).toBe('con_lifecycle_non_authority_26');
  });

  it('allows non-consequential actions without a token', () => {
    const d = verifyDispatch({
      taskId: 't1',
      taskState: 'running',
      executionMode: 'interactive',
      actionId: 'a1',
      actionFingerprint: 'fp1',
      irreversible: false,
      hitlGated: false,
    });
    expect(d.allowed).toBe(true);
  });

  it('allows a consequential action with a fresh action-bound token', () => {
    const d = verifyDispatch({
      taskId: 't1',
      taskState: 'running',
      executionMode: 'interactive',
      actionId: 'a1',
      actionFingerprint: 'fp1',
      irreversible: true,
      hitlGated: true,
      approvalToken: freshToken('a1', 'fp1', 0),
      nowMs: 0,
    });
    expect(d.allowed).toBe(true);
  });

  it('rejects a token bound to a different action', () => {
    const d = verifyDispatch({
      taskId: 't1',
      taskState: 'running',
      executionMode: 'interactive',
      actionId: 'a1',
      actionFingerprint: 'fp1',
      irreversible: true,
      hitlGated: true,
      approvalToken: freshToken('OTHER', 'fp1', 0),
      nowMs: 0,
    });
    expect(d).toEqual({ allowed: false, reason: 'approval_token_not_action_bound' });
  });

  it('rejects an expired token', () => {
    const d = verifyDispatch({
      taskId: 't1',
      taskState: 'running',
      executionMode: 'interactive',
      actionId: 'a1',
      actionFingerprint: 'fp1',
      irreversible: true,
      hitlGated: true,
      approvalToken: freshToken('a1', 'fp1', 0),
      nowMs: 999_999,
    });
    expect(d).toEqual({ allowed: false, reason: 'approval_token_expired' });
  });

  it('validateCompletion accepts a verified clean evidence', () => {
    expect(validateCompletion([{ kind: 'trace', ref: 'x', verified: true, tainted: false }])).toEqual({
      ok: true,
    });
  });

  it('validateCompletion rejects empty evidence', () => {
    expect(validateCompletion([])).toEqual({ ok: false, reason: 'no_verified_evidence' });
  });

  it('status fields are separate types, not derived from one another', () => {
    expect(
      areStatusFieldsSeparate({ opStatus: 'ok', taskState: 'running', completionStatus: 'incomplete' }),
    ).toBe(true);
  });

  it('validateDependencyGraph accepts an acyclic graph', () => {
    expect(
      validateDependencyGraph([
        { from: 'a', to: 'b', kind: 'ordering' },
        { from: 'b', to: 'c', kind: 'ordering' },
      ]),
    ).toEqual({ ok: true });
  });

  it('validateDependencyGraph enforces the count cap', () => {
    const edges = Array.from({ length: DEFAULT_DEP_CAPS.maxCount + 1 }, (_, i) => ({
      from: `n${i}`,
      to: `n${i + 1}`,
      kind: 'ordering' as const,
    }));
    expect(validateDependencyGraph(edges)).toEqual({ ok: false, reason: 'count_exceeded' });
  });

  it('validateDependencyGraph enforces the depth cap', () => {
    const edges = Array.from({ length: DEFAULT_DEP_CAPS.maxDepth + 2 }, (_, i) => ({
      from: `n${i}`,
      to: `n${i + 1}`,
      kind: 'ordering' as const,
    }));
    expect(validateDependencyGraph(edges)).toEqual({ ok: false, reason: 'depth_exceeded' });
  });

  it('proposeCompensation returns advisory-only plan', () => {
    const plan = proposeCompensation([{ description: 'refund', irreversible: true }]);
    expect(plan.advisory).toBe(true);
    expect(plan.steps[0].irreversible).toBe(true);
    expect((plan as any).execute).toBeUndefined();
  });

  it('sanitizeForStorage strips forbidden authority keys', () => {
    const out = sanitizeForStorage({
      taskId: 't1',
      approval_token: 'secret',
      vault_handle: 'vh_1',
      pending_approval_ids: ['p1'],
      cookies: 'a=b',
      note: 'ok',
    });
    expect(out.approval_token).toBe('[REDACTED]');
    expect(out.vault_handle).toBe('[REDACTED]');
    expect(out.pending_approval_ids).toBe('[REDACTED]');
    expect(out.cookies).toBe('[REDACTED]');
    expect(out.note).toBe('ok');
  });

  it('isForbiddenStorageKey identifies authority keys', () => {
    expect(isForbiddenStorageKey('approval_token')).toBe(true);
    expect(isForbiddenStorageKey('description')).toBe(false);
  });

  it('brands and detects the lifecycle manager', () => {
    const mgr = brandAsLifecycleManager({ kind: 'manager' });
    expect(isLifecycleManager(mgr)).toBe(true);
    expect(isLifecycleManager({})).toBe(false);
  });

  it('tool adapters refuse the manager as an unvalidated argument source', () => {
    const mgr = brandAsLifecycleManager({});
    expect(acceptToolArgumentSource(mgr, false)).toBe(false);
    expect(acceptToolArgumentSource(mgr, true)).toBe(true);
    expect(acceptToolArgumentSource({ url: 'x' })).toBe(true);
  });
});
