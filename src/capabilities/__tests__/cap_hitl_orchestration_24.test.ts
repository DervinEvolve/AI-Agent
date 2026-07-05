import { describe, it, expect, beforeEach } from 'vitest';
import {
  hitl_orchestrator,
  createBindingHash,
  verifyBindingHash,
  type HITLRequestPayload,
  type HITLApprovalToken,
} from '../cap_hitl_orchestration_24';

describe('cap_hitl_orchestration_24', () => {
  beforeEach(() => {
    hitl_orchestrator._reset();
  });

  const basePayload: HITLRequestPayload = {
    taskId: 'task-1',
    summary: 'Delete production database',
    form: { title: 'Confirm', sections: [] },
    riskProfile: {
      riskClass: 'critical',
      taintSources: [],
      irreversible: true,
      estimatedCost: '$0',
      unknownConsequences: false,
    },
    channels: ['dashboard'],
    timeoutMs: 60_000,
    sequenceNumber: 1,
  };

  describe('request_approval', () => {
    it('returns a pending approval state with a unique approvalId', () => {
      const state = hitl_orchestrator.request_approval(basePayload);

      expect(state.approvalId).toBeTruthy();
      expect(state.status).toBe('pending');
      expect(state.taskId).toBe('task-1');
      expect(state.sequenceNumber).toBe(1);
      expect(state.token).toBeNull();
      expect(state.requestedAt).toBeTruthy();
      expect(state.expiresAt).toBeTruthy();
      expect(new Date(state.expiresAt).getTime()).toBeGreaterThan(
        new Date(state.requestedAt).getTime(),
      );
    });

    it('creates distinct approvalIds for different requests', () => {
      const a = hitl_orchestrator.request_approval(basePayload);
      const b = hitl_orchestrator.request_approval({
        ...basePayload,
        taskId: 'task-2',
      });

      expect(a.approvalId).not.toBe(b.approvalId);
    });
  });

  describe('check_status', () => {
    it('returns the current state for a known approvalId', () => {
      const created = hitl_orchestrator.request_approval(basePayload);
      const state = hitl_orchestrator.check_status(created.approvalId);

      expect(state).not.toBeNull();
      expect(state!.status).toBe('pending');
      expect(state!.approvalId).toBe(created.approvalId);
    });

    it('returns null for an unknown approvalId', () => {
      expect(hitl_orchestrator.check_status('nonexistent')).toBeNull();
    });

    it('marks the approval as expired when the expiry time has passed', async () => {
      const payload: HITLRequestPayload = {
        ...basePayload,
        timeoutMs: 10, // expire quickly
      };
      const created = hitl_orchestrator.request_approval(payload);

      // Wait for the timeout to fire.
      await new Promise((r) => setTimeout(r, 20));

      const state = hitl_orchestrator.check_status(created.approvalId);
      expect(state!.status).toBe('expired');
    });
  });

  describe('apply_decision', () => {
    it('transitions a pending approval to approved on allow', () => {
      const created = hitl_orchestrator.request_approval(basePayload);

      const token: HITLApprovalToken = {
        approvalId: created.approvalId,
        decision: 'allow',
        bindingHash: createBindingHash(created.approvalId, 'allow', 0),
        decidedAt: new Date().toISOString(),
        decidedBy: 'alice',
      };

      const updated = hitl_orchestrator.apply_decision(token);
      expect(updated!.status).toBe('approved');
      expect(updated!.token).toEqual(token);
    });

    it('transitions a pending approval to denied on deny', () => {
      const created = hitl_orchestrator.request_approval(basePayload);

      const token: HITLApprovalToken = {
        approvalId: created.approvalId,
        decision: 'deny',
        bindingHash: createBindingHash(created.approvalId, 'deny', 0),
        decidedAt: new Date().toISOString(),
        decidedBy: 'bob',
      };

      const updated = hitl_orchestrator.apply_decision(token);
      expect(updated!.status).toBe('denied');
    });

    it('human-wins: accepts a late decision even after expiry', async () => {
      const payload: HITLRequestPayload = {
        ...basePayload,
        timeoutMs: 10,
      };
      const created = hitl_orchestrator.request_approval(payload);
      await new Promise((r) => setTimeout(r, 20));

      const token: HITLApprovalToken = {
        approvalId: created.approvalId,
        decision: 'allow',
        bindingHash: createBindingHash(created.approvalId, 'allow', 0),
        decidedAt: new Date().toISOString(),
        decidedBy: 'late-human',
      };

      const updated = hitl_orchestrator.apply_decision(token);
      expect(updated!.status).toBe('approved');
    });

    it('returns null for an unknown approvalId', () => {
      const token: HITLApprovalToken = {
        approvalId: 'nonexistent',
        decision: 'allow',
        bindingHash: createBindingHash('nonexistent', 'allow', 0),
        decidedAt: new Date().toISOString(),
        decidedBy: 'ghost',
      };

      expect(hitl_orchestrator.apply_decision(token)).toBeNull();
    });
  });

  describe('cancel', () => {
    it('cancels a pending approval', () => {
      const created = hitl_orchestrator.request_approval(basePayload);
      const cancelled = hitl_orchestrator.cancel(created.approvalId);

      expect(cancelled).toBe(true);
      expect(hitl_orchestrator.check_status(created.approvalId)!.status).toBe(
        'cancelled',
      );
    });

    it('returns false for an already-decided approval', () => {
      const created = hitl_orchestrator.request_approval(basePayload);

      hitl_orchestrator.apply_decision({
        approvalId: created.approvalId,
        decision: 'allow',
        bindingHash: createBindingHash(created.approvalId, 'allow', 0),
        decidedAt: new Date().toISOString(),
        decidedBy: 'alice',
      });

      expect(hitl_orchestrator.cancel(created.approvalId)).toBe(false);
    });
  });

  describe('createBindingHash / verifyBindingHash', () => {
    it('produces consistent hashes for the same inputs', () => {
      const h1 = createBindingHash('id-1', 'allow', 42);
      const h2 = createBindingHash('id-1', 'allow', 42);
      expect(h1).toBe(h2);
    });

    it('produces different hashes for different inputs', () => {
      const h1 = createBindingHash('id-1', 'allow', 42);
      const h2 = createBindingHash('id-1', 'deny', 42);
      expect(h1).not.toBe(h2);
    });

    it('verifyBindingHash returns true for a matching token', () => {
      const token: HITLApprovalToken = {
        approvalId: 'id-1',
        decision: 'allow',
        bindingHash: createBindingHash('id-1', 'allow', 0),
        decidedAt: new Date().toISOString(),
        decidedBy: 'test',
      };
      expect(verifyBindingHash(token)).toBe(true);
    });

    it('verifyBindingHash returns false for a tampered token', () => {
      const token: HITLApprovalToken = {
        approvalId: 'id-1',
        decision: 'allow',
        bindingHash: '00000000deadbeef',
        decidedAt: new Date().toISOString(),
        decidedBy: 'test',
      };
      expect(verifyBindingHash(token)).toBe(false);
    });
  });
});
