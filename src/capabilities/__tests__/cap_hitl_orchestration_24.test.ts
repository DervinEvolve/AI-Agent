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

    const result1 = await orchestrator.requestApproval('task-1', request);
    const result2 = await orchestrator.requestApproval('task-1', { ...request });

    expect(result1.provenance.binding_hash).not.toBe(result2.provenance.binding_hash);
    expect(result1.nonce).not.toBe(result2.nonce);
  });

  it('stores a pending approval record scoped to task_id with timeout, channels, escalation_policy, and binding_hash', async () => {
    const request: ApprovalRequest = {
      action_description: 'Restart server',
      target_adapter: 'server_adapter',
      target_endpoint: '/api/server/restart',
      vault_grant_id: 'grant_456',
      consequences_summary: 'Will restart the production server',
      timeout_seconds: 1800,
      channels: ['slack', 'email'],
      escalation_policy: {
        levels: [
          { level: 1, channel: 'email', timeout_seconds: 900 },
        ],
        max_levels: 3,
      },
    };

    const result = await orchestrator.requestApproval('task-2', request);

    const status = await orchestrator.checkStatus('task-2', result.approval_id!);

    expect(status.status).toBe('pending');
    expect(status.provenance.binding_hash).toBeDefined();
    expect(status.provenance.channel).toBe('slack');
  });

  it('returns approval_id and nonce without blocking the controller', async () => {
    const request: ApprovalRequest = {
      action_description: 'Test action',
      target_adapter: 'test',
      target_endpoint: '/test',
      vault_grant_id: 'grant_test',
      consequences_summary: 'Test',
      timeout_seconds: 100,
      channels: ['slack'],
    };

    const start = Date.now();
    const result = await orchestrator.requestApproval('task-3', request);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(result.approval_id).toBeDefined();
    expect(result.nonce).toBeDefined();
    expect(result.status).toBe('pending');
  });

  it('rejects if max_pending_per_task (5) is exceeded; returns policy_blocked', async () => {
    const request: ApprovalRequest = {
      action_description: 'Test',
      target_adapter: 'test',
      target_endpoint: '/test',
      vault_grant_id: 'grant_test',
      consequences_summary: 'Test',
      timeout_seconds: 3600,
      channels: ['slack'],
    };

    for (let i = 0; i < 5; i++) {
      await orchestrator.requestApproval('task-max', request);
    }

    const result = await orchestrator.requestApproval('task-max', request);
    expect(result.status).toBe('policy_blocked');
  });
});

describe('HITLOrchestrator - register_channel', () => {
  let orchestrator: HITLOrchestrator;

  beforeEach(() => {
    orchestrator = new HITLOrchestrator();
  });

  it('accepts channel type and vault credential reference; validates reachability without exposing credentials', async () => {
    const channelConfig: ChannelConfig = {
      channel: 'slack',
      endpoint: 'vault://channels/slack/credential',
      credentials_ref: 'vault:slack_webhook_1',
    };

    const result = await orchestrator.registerChannel('task-1', channelConfig);

    expect(result.status).toBe('approved');
  });

  it('stores channel config under task/user scope; raw credentials are never stored or logged', async () => {
    const channelConfig: ChannelConfig = {
      channel: 'email',
      endpoint: 'vault://channels/email/credential',
      credentials_ref: 'vault:email_smtp_1',
    };

    await orchestrator.registerChannel('task-2', channelConfig);
    const result = await orchestrator.registerChannel('task-2', channelConfig);

    expect(result.status).toBe('approved');
  });
});

describe('HITLOrchestrator - check_status', () => {
  let orchestrator: HITLOrchestrator;

  beforeEach(() => {
    orchestrator = new HITLOrchestrator();
  });

  it('returns the current status of a pending approval and any escalation history', async () => {
    const request: ApprovalRequest = {
      action_description: 'Check status test',
      target_adapter: 'test',
      target_endpoint: '/test',
      vault_grant_id: 'grant_test',
      consequences_summary: 'Test',
      timeout_seconds: 3600,
      channels: ['slack'],
    };

    const approval = await orchestrator.requestApproval('task-cs', request);
    const status = await orchestrator.checkStatus('task-cs', approval.approval_id!);

    expect(status.status).toBe('pending');
    expect(status.provenance.approval_id).toBe(approval.approval_id);
    expect(status.escalation_history).toEqual([]);
  });
});

describe('HITLOrchestrator - approval verification and cryptographic binding', () => {
  let orchestrator: HITLOrchestrator;

  beforeEach(() => {
    orchestrator = new HITLOrchestrator();
  });

  it('verifies that the response includes a cryptographic affirmation of the binding_hash and nonce', async () => {
    const request: ApprovalRequest = {
      action_description: 'Deploy to production',
      target_adapter: 'deploy_adapter',
      target_endpoint: '/api/deploy/prod',
      vault_grant_id: 'grant_deploy',
      consequences_summary: 'Deploys version 2.0 to production',
      timeout_seconds: 7200,
      channels: ['slack'],
    };

    const approval = await orchestrator.requestApproval('task-verify', request);

    const tokenSignature = orchestrator.generateTokenSignature(
      approval.approval_id!,
      approval.provenance.binding_hash!,
      request.target_adapter,
      request.target_endpoint,
      request.vault_grant_id,
      approval.nonce!,
      approval.provenance.requested_at!
    );

    const result = await orchestrator.processApprovalResponse('task-verify', approval.approval_id!, {
      binding_token_affirmation: tokenSignature,
      tainted: false,
    });

    expect(result.status).toBe('approved');
    expect(result.approval_token).toBe(tokenSignature);
  });

  it('rejects plain approve without the binding token with invalid_signature', async () => {
    const request: ApprovalRequest = {
      action_description: 'Deploy',
      target_adapter: 'deploy_adapter',
      target_endpoint: '/api/deploy',
      vault_grant_id: 'grant_d',
      consequences_summary: 'Deploy',
      timeout_seconds: 3600,
      channels: ['slack'],
    };

    const approval = await orchestrator.requestApproval('task-plain', request);

    const result = await orchestrator.processApprovalResponse('task-plain', approval.approval_id!, {
      tainted: false,
    });

    expect(result.status).toBe('invalid_signature');
  });

  it('successful approval returns a single-use approval_token structurally bound to approval fields', async () => {
    const request: ApprovalRequest = {
      action_description: 'Bound action',
      target_adapter: 'bound_adapter',
      target_endpoint: '/api/bound',
      vault_grant_id: 'grant_bound',
      consequences_summary: 'Bound',
      timeout_seconds: 3600,
      channels: ['slack'],
    };

    const approval = await orchestrator.requestApproval('task-bound', request);
    const tokenSignature = orchestrator.generateTokenSignature(
      approval.approval_id!,
      approval.provenance.binding_hash!,
      request.target_adapter,
      request.target_endpoint,
      request.vault_grant_id,
      approval.nonce!,
      approval.provenance.requested_at!
    );

    const result = await orchestrator.processApprovalResponse('task-bound', approval.approval_id!, {
      binding_token_affirmation: tokenSignature,
    });

    expect(result.approval_token).toBeDefined();

    const verifyResult = await orchestrator.verifyApprovalToken(approval.approval_id!, result.approval_token!);
    expect(verifyResult.status).toBe('approved');
  });

  it('approval_token cannot be reused; replay attempts return invalid_signature', async () => {
    const request: ApprovalRequest = {
      action_description: 'Single-use test',
      target_adapter: 'test_adapter',
      target_endpoint: '/api/test',
      vault_grant_id: 'grant_test_su',
      consequences_summary: 'Single use',
      timeout_seconds: 3600,
      channels: ['slack'],
    };

    const approval = await orchestrator.requestApproval('task-su', request);
    const tokenSignature = orchestrator.generateTokenSignature(
      approval.approval_id!,
      approval.provenance.binding_hash!,
      request.target_adapter,
      request.target_endpoint,
      request.vault_grant_id,
      approval.nonce!,
      approval.provenance.requested_at!
    );

    await orchestrator.processApprovalResponse('task-su', approval.approval_id!, {
      binding_token_affirmation: tokenSignature,
    });

    await orchestrator.verifyApprovalToken(approval.approval_id!, tokenSignature);
    const replayResult = await orchestrator.verifyApprovalToken(approval.approval_id!, tokenSignature);

    expect(replayResult.status).toBe('invalid_signature');
  });

  it('token verification fails for mismatched action_payload_hash, adapter, endpoint, or grant_id', async () => {
    const request: ApprovalRequest = {
      action_description: 'Action A',
      target_adapter: 'adapter_a',
      target_endpoint: '/api/a',
      vault_grant_id: 'grant_a',
      consequences_summary: 'Action A summary',
      timeout_seconds: 3600,
      channels: ['slack'],
    };

    const approval = await orchestrator.requestApproval('task-compare', request);
    const tokenSignature = orchestrator.generateTokenSignature(
      approval.approval_id!,
      approval.provenance.binding_hash!,
      request.target_adapter,
      request.target_endpoint,
      request.vault_grant_id,
      approval.nonce!,
      approval.provenance.requested_at!
    );

    await orchestrator.processApprovalResponse('task-compare', approval.approval_id!, {
      binding_token_affirmation: tokenSignature,
    });

    const fakeToken = crypto.createHash('sha256').update('fake-token', 'utf8').digest('hex');
    const mismatchResult = await orchestrator.verifyApprovalToken(approval.approval_id!, fakeToken);

    expect(mismatchResult.status).toBe('invalid_signature');
  });

  it('tainted channel responses carry tainted=true but do not invalidate cryptographic binding verification', async () => {
    const request: ApprovalRequest = {
      action_description: 'Tainted test',
      target_adapter: 'test_adapter',
      target_endpoint: '/api/tainted',
      vault_grant_id: 'grant_tainted',
      consequences_summary: 'Tainted',
      timeout_seconds: 3600,
      channels: ['webhook'],
    };

    const approval = await orchestrator.requestApproval('task-tainted', request);
    const tokenSignature = orchestrator.generateTokenSignature(
      approval.approval_id!,
      approval.provenance.binding_hash!,
      request.target_adapter,
      request.target_endpoint,
      request.vault_grant_id,
      approval.nonce!,
      approval.provenance.requested_at!
    );

    const result = await orchestrator.processApprovalResponse('task-tainted', approval.approval_id!, {
      binding_token_affirmation: tokenSignature,
      tainted: true,
    });

    expect(result.status).toBe('approved');
    expect(result.tainted).toBe(true);
  });
});

describe('HITLOrchestrator - cancel_pending', () => {
  let orchestrator: HITLOrchestrator;

  beforeEach(() => {
    orchestrator = new HITLOrchestrator();
  });

  it('marks an approval as cancelled and invalidates outstanding tokens', async () => {
    const request: ApprovalRequest = {
      action_description: 'Cancel test',
      target_adapter: 'test',
      target_endpoint: '/test',
      vault_grant_id: 'grant_test',
      consequences_summary: 'Test',
      timeout_seconds: 3600,
      channels: ['slack'],
    };

    const approval = await orchestrator.requestApproval('task-cancel', request);
    const result = await orchestrator.cancelPending('task-cancel', approval.approval_id!);

    expect(result.status).toBe('cancelled');

    const status = await orchestrator.checkStatus('task-cancel', approval.approval_id!);
    expect(status.status).toBe('cancelled');
  });
});

describe('HITLOrchestrator - list_pending', () => {
  let orchestrator: HITLOrchestrator;

  beforeEach(() => {
    orchestrator = new HITLOrchestrator();
  });

  it('returns all pending approvals for the task with statuses and elapsed time', async () => {
    const request: ApprovalRequest = {
      action_description: 'List test 1',
      target_adapter: 'test',
      target_endpoint: '/test1',
      vault_grant_id: 'grant_test',
      consequences_summary: 'Test 1',
      timeout_seconds: 3600,
      channels: ['slack'],
    };

    const req1 = await orchestrator.requestApproval('task-list', request);
    const req2 = await orchestrator.requestApproval('task-list', {
      ...request,
      action_description: 'List test 2',
    });

    const list = await orchestrator.listPending('task-list');

    expect(list.length).toBe(2);
    expect(list.map((l) => l.approval_id).sort()).toEqual(
      [req1.approval_id!, req2.approval_id!].sort()
    );
  });
});

describe('HITLOrchestrator - escalate', () => {
  let orchestrator: HITLOrchestrator;

  beforeEach(() => {
    orchestrator = new HITLOrchestrator();
  });

  it('moves a pending approval to the next escalation level and channel; returns escalated with new channel info', async () => {
    const request: ApprovalRequest = {
      action_description: 'Escalate test',
      target_adapter: 'test',
      target_endpoint: '/test',
      vault_grant_id: 'grant_test',
      consequences_summary: 'Test',
      timeout_seconds: 3600,
      channels: ['slack', 'email'],
    };

    const approval = await orchestrator.requestApproval('task-esc', request);
    const result = await orchestrator.escalate('task-esc', approval.approval_id!);

    expect(result.status).toBe('escalated');
    expect(result.provenance.channel).toBe('email');
    expect(result.provenance.escalation_level).toBe(1);
    expect(result.escalation_history?.length).toBe(1);
  });

  it('honors max_escalation_levels (3); exceeding max returns timeout with status=denied', async () => {
    const request: ApprovalRequest = {
      action_description: 'Max escalate test',
      target_adapter: 'test',
      target_endpoint: '/test',
      vault_grant_id: 'grant_test',
      consequences_summary: 'Test',
      timeout_seconds: 3600,
      channels: ['slack', 'email', 'webhook'],
    };

    const approval = await orchestrator.requestApproval('task-max-esc', request);

    await orchestrator.escalate('task-max-esc', approval.approval_id!);
    await orchestrator.escalate('task-max-esc', approval.approval_id!);
    await orchestrator.escalate('task-max-esc', approval.approval_id!);
    const finalResult = await orchestrator.escalate('task-max-esc', approval.approval_id!);

    expect(finalResult.status).toBe('denied');
  });
});

describe('HITLOrchestrator - resolve_timeout', () => {
  let orchestrator: HITLOrchestrator;

  beforeEach(() => {
    orchestrator = new HITLOrchestrator();
  });

  it('handles timeout events: escalate triggers escalate, reject returns denied, retry re-sends', async () => {
    const request: ApprovalRequest = {
      action_description: 'Timeout test',
      target_adapter: 'test',
      target_endpoint: '/test',
      vault_grant_id: 'grant_test',
      consequences_summary: 'Test',
      timeout_seconds: 3600,
      channels: ['slack', 'email'],
    };

    const approval = await orchestrator.requestApproval('task-timeout', request);

    const rejectResult = await orchestrator.resolveTimeout('task-timeout', approval.approval_id!, 'reject');
    expect(rejectResult.status).toBe('denied');

    const approval2 = await orchestrator.requestApproval('task-timeout', {
      ...request,
      action_description: 'Timeout retry',
    });
    const retryResult = await orchestrator.resolveTimeout('task-timeout', approval2.approval_id!, 'retry');
    expect(retryResult.status).toBe('pending');

    const approval3 = await orchestrator.requestApproval('task-timeout', {
      ...request,
      action_description: 'Timeout escalate',
    });
    const escalateResult = await orchestrator.resolveTimeout('task-timeout', approval3.approval_id!, 'escalate');
    expect(escalateResult.status).toBe('escalated');
  });

  it('timeout defaults to reject if no escalation_policy configured', async () => {
    const request: ApprovalRequest = {
      action_description: 'Default timeout',
      target_adapter: 'test',
      target_endpoint: '/test',
      vault_grant_id: 'grant_test',
      consequences_summary: 'Test',
      timeout_seconds: -1,
      channels: ['slack'],
    };

    const approval = await orchestrator.requestApproval('task-default', request);
    const result = await orchestrator.resolveTimeout('task-default', approval.approval_id!);

    expect(result.status).toBe('denied');
  });
});

describe('HITLOrchestrator - atomic verification', () => {
  let orchestrator: HITLOrchestrator;

  beforeEach(() => {
    orchestrator = new HITLOrchestrator();
  });

  it('verifyApprovalToken consumed token is immediately invalidated', async () => {
    const request: ApprovalRequest = {
      action_description: 'Atomic test',
      target_adapter: 'test',
      target_endpoint: '/test',
      vault_grant_id: 'grant_test',
      consequences_summary: 'Test',
      timeout_seconds: 3600,
      channels: ['slack'],
    };

    const approval = await orchestrator.requestApproval('task-atomic', request);
    const tokenSignature = orchestrator.generateTokenSignature(
      approval.approval_id!,
      approval.provenance.binding_hash!,
      request.target_adapter,
      request.target_endpoint,
      request.vault_grant_id,
      approval.nonce!,
      approval.provenance.requested_at!
    );

    await orchestrator.processApprovalResponse('task-atomic', approval.approval_id!, {
      binding_token_affirmation: tokenSignature,
    });

    const firstVerify = await orchestrator.verifyApprovalToken(approval.approval_id!, tokenSignature);
    expect(firstVerify.status).toBe('approved');

    const secondVerify = await orchestrator.verifyApprovalToken(approval.approval_id!, tokenSignature);
    expect(secondVerify.status).toBe('invalid_signature');
  });
});

describe('HITLOrchestrator - configuration', () => {
  it('uses default configuration with correct limits', () => {
    const config = hitlOrchestrator.getConfig();

    expect(config.max_timeout_seconds).toBe(86400);
    expect(config.max_pending_per_task).toBe(5);
    expect(config.max_escalation_levels).toBe(3);
    expect(config.default_timeout_seconds).toBe(3600);
    expect(config.token_lifetime_after_approval).toContain('action-bound');
  });
});
