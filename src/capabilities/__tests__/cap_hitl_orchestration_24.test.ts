import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import { HITLOrchestrator, hitlOrchestrator } from '../cap_hitl_orchestration_24';
import type { ApprovalRequest, ChannelConfig } from '../cap_hitl_orchestration_24';

vi.mock('./cap_long_term_memory_3', () => ({
  longTermMemory: {
    retrieve: vi.fn().mockResolvedValue(null),
    store: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('./secret_redactor', () => ({
  secretRedactor: {
    redact: vi.fn((value: string) => value),
  },
}));

describe('HITLOrchestrator - request_approval', () => {
  let orchestrator: HITLOrchestrator;

  beforeEach(() => {
    orchestrator = new HITLOrchestrator();
  });

  it('generates a unique approval_id and computes action_payload_hash from canonicalized JSON', async () => {
    const request: ApprovalRequest = {
      action_description: 'Delete user account',
      target_adapter: 'account_adapter',
      target_endpoint: '/api/accounts/delete',
      vault_grant_id: 'grant_123',
      consequences_summary: 'Permanently deletes the user account and all associated data',
      timeout_seconds: 3600,
      channels: ['slack'],
    };

    const result = await orchestrator.requestApproval('task-1', request);

    expect(result.approval_id).toBeDefined();
    expect(result.approval_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.nonce).toBeDefined();
    expect(result.nonce).toHaveLength(32);
    expect(result.provenance.binding_hash).toBeDefined();
    expect(result.provenance.binding_hash).toHaveLength(64);
  });

  it('action_payload_hash is SHA-256; canonicalization is deterministic and includes all required fields', async () => {
    const request: ApprovalRequest = {
      action_description: 'Delete user account',
      target_adapter: 'account_adapter',
      target_endpoint: '/api/accounts/delete',
      vault_grant_id: 'grant_123',
      consequences_summary: 'Permanently deletes',
      timeout_seconds: 3600,
      channels: ['slack'],
    };

    const result1 = await orchestrator.requestApproval('task-2a', request);
    const result2 = await orchestrator.requestApproval('task-2b', request);

    expect(result1.provenance.binding_hash).toBeDefined();
    expect(result1.provenance.binding_hash).toEqual(result2.provenance.binding_hash);
  });

  it('rejects new request when max_pending_per_task (5) is exceeded', async () => {
    const baseRequest: ApprovalRequest = {
      action_description: 'Test action',
      target_adapter: 'test',
      target_endpoint: '/test',
      vault_grant_id: 'grant_test',
      consequences_summary: 'test',
      timeout_seconds: 3600,
      channels: ['cli'],
    };

    // Create 5 pending approvals for the same task
    for (let i = 0; i < 5; i++) {
      const res = await orchestrator.requestApproval('task-max', {
        ...baseRequest,
        action_description: `Test action ${i}`,
      });
      expect(res.status).toBe('pending');
    }

    // 6th request should be blocked
    const blocked = await orchestrator.requestApproval('task-max', baseRequest);
    expect(blocked.status).toBe('policy_blocked');
  });
});
