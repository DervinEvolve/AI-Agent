import crypto from 'crypto';
import { longTermMemory } from './cap_long_term_memory_3';
import { secretRedactor } from './secret_redactor';
import { backgroundExecutor24 } from './background_executor_24';
import { v4 as uuidv4 } from 'uuid';

export type HITLChannel = 'slack' | 'email' | 'webhook' | 'cli';
export type ApprovalStatus = 'approved' | 'denied' | 'pending' | 'expired' | 'cancelled' | 'error' | 'policy_blocked' | 'channel_unavailable' | 'invalid_signature' | 'timeout' | 'escalated';
export type TimeoutAction = 'escalate' | 'reject' | 'retry';

export interface ChannelConfig {
  channel: HITLChannel;
  endpoint: string;
  credentials_ref: string; // vault-held reference, never the raw credential
}

export interface EscalationPolicy {
  levels: Array<{
    level: number;
    channel: HITLChannel;
    timeout_seconds: number;
  }>;
  max_levels: number;
}

export interface ApprovalRequest {
  action_payload_hash?: string;
  action_description: string;
  target_adapter: string;
  target_endpoint: string;
  vault_grant_id: string;
  consequences_summary: string;
  structured_form?: Record<string, unknown>;
  timeout_seconds: number;
  escalation_policy?: EscalationPolicy;
  channels: HITLChannel[];
}

export interface PendingApproval {
  approval_id: string;
  task_id: string;
  status: ApprovalStatus;
  requested_at: number;
  nonce: string;
  binding_hash: string;
  action_description: string;
  target_adapter: string;
  target_endpoint: string;
  vault_grant_id: string;
  consequences_summary: string;
  timeout_seconds: number;
  escalation_policy?: EscalationPolicy;
  escalation_level: number;
  escalation_history: Array<{ level: number; channel: HITLChannel; timestamp: number; reason: string }>;
  channels: HITLChannel[];
  current_channel?: HITLChannel;
  approved_at?: number;
  token_hash?: string;
  consumed: boolean;
  tainted: boolean;
}

export interface ApprovalOutput {
  nonce?: string;
  status: ApprovalStatus;
  tainted: boolean;
  provenance: {
    approval_id: string;
    task_id: string;
    channel?: HITLChannel;
    requested_at?: number;
    resolved_at?: number;
    escalation_level: number;
    binding_hash?: string;
    token_signature?: string;
  };
  approval_id?: string;
  approval_token?: string;
  escalation_history?: Array<{ level: number; channel: HITLChannel; timestamp: number; reason: string }>;
}

export interface HITLOrchestratorConfig {
  max_timeout_seconds: number;
  max_pending_per_task: number;
  max_escalation_levels: number;
  default_timeout_seconds: number;
  token_lifetime_after_approval: string;
}

const DEFAULT_CONFIG: HITLOrchestratorConfig = {
  max_timeout_seconds: 86400,
  max_pending_per_task: 5,
  max_escalation_levels: 3,
  default_timeout_seconds: 3600,
  token_lifetime_after_approval: 'action-bound; single use, expires after dispatch verification',
};

const MEMORY_NAMESPACE = 'hitl_orchestrator';

export class HITLOrchestrator {
  private config: HITLOrchestratorConfig;
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  private channelConfigs: Map<string, ChannelConfig> = new Map();
  private taskApprovals: Map<string, Set<string>> = new Map();
  private initialized = false;

  constructor(config: Partial<HITLOrchestratorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const persisted = await longTermMemory.retrieve({ namespace: MEMORY_NAMESPACE, key: 'pending_approvals' });
      if (persisted) {
        const parsed = JSON.parse(secretRedractor.redact(persisted, { direction: 'restore' }) ?? persisted);
        if (Array.isArray(parsed)) {
          for (const record of parsed) {
            if (record.approval_id && record.task_id) {
              this.pendingApprovals.set(record.approval_id, record as PendingApproval);
              const taskSet = this.taskApprovals.get(record.task_id) ?? new Set();
              taskSet.add(record.approval_id);
              this.taskApprovals.set(record.task_id, taskSet);
            }
          }
        }
      }

      const persistedChannels = await longTermMemory.retrieve({ namespace: MEMORY_NAMESPACE, key: 'channel_configs' });
      if (persistedChannels) {
        const parsed = JSON.parse(secretRedractor.redact(persistedChannels, { direction: 'restore' }) ?? persistedChannels);
        if (parsed && typeof parsed === 'object') {
          for (const [key, value] of Object.entries(parsed)) {
            this.channelConfigs.set(key, value as ChannelConfig);
          }
        }
      }
    } catch {
      // Fresh start if checkpoint loading fails
    }

    this.initialized = true;
  }

  private async checkpointState(): Promise<void> {
    const approvals = Array.from(this.pendingApprovals.values());
    const channels = Object.fromEntries(this.channelConfigs.entries());

    await longTermMemory.store({
      namespace: MEMORY_NAMESPACE,
      key: 'pending_approvals',
      value: JSON.stringify(approvals),
      metadata: { redact: true },
    });

    await longTermMemory.store({
      namespace: MEMORY_NAMESPACE,
      key: 'channel_configs',
      value: JSON.stringify(channels),
      metadata: { redact: true },
    });
  }

  canonicalizeAction(request: ApprovalRequest, nonce: string, timestamp: number): string {
    const obj = {
      action_description: request.action_description,
      target_adapter: request.target_adapter,
      target_endpoint: request.target_endpoint,
      vault_grant_id: request.vault_grant_id,
      consequences_summary: request.consequences_summary,
      timestamp,
      nonce,
    };
    return JSON.stringify(obj, Object.keys(obj).sort());
  }

  computeActionPayloadHash(canonicalized: string): string {
    return crypto.createHash('sha256').update(canonicalized, 'utf8').digest('hex');
  }

  computeBindingHash(
    actionPayloadHash: string,
    targetAdapter: string,
    targetEndpoint: string,
    vaultGrantId: string,
    nonce: string,
    timestamp: number
  ): string {
    const tuple = JSON.stringify(
      {
        action_payload_hash: actionPayloadHash,
        target_adapter: targetAdapter,
        target_endpoint: targetEndpoint,
        vault_grant_id: vaultGrantId,
        nonce,
        timestamp,
      },
      Object.keys({
        action_payload_hash: '',
        target_adapter: '',
        target_endpoint: '',
        vault_grant_id: '',
        nonce: '',
        timestamp: 0,
      }).sort()
    );
    return crypto.createHash('sha256').update(tuple, 'utf8').digest('hex');
  }

  generateTokenSignature(
    approvalId: string,
    actionPayloadHash: string,
    adapter: string,
    endpoint: string,
    grantId: string,
    nonce: string,
    timestamp: number
  ): string {
    const payload = JSON.stringify(
      {
        approval_id: approvalId,
        action_payload_hash: actionPayloadHash,
        adapter,
        endpoint,
        grant_id: grantId,
        nonce,
        timestamp,
      },
      Object.keys({
        approval_id: '',
        action_payload_hash: '',
        adapter: '',
        endpoint: '',
        grant_id: '',
        nonce: '',
        timestamp: 0,
      }).sort()
    );
    return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
  }

  async requestApproval(taskId: string, request: ApprovalRequest): Promise<ApprovalOutput> {
    await this.initialize();

    const taskSet = this.taskApprovals.get(taskId) ?? new Set();
    const pendingCount = Array.from(taskSet).filter(
      (id) => this.pendingApprovals.get(id)?.status === 'pending'
    ).length;

    if (pendingCount >= this.config.max_pending_per_task) {
      return {
        status: 'policy_blocked',
        tainted: false,
        provenance: {
          approval_id: '',
          task_id: taskId,
          escalation_level: 0,
        },
      };
    }

    const timeoutSeconds = Math.min(
      request.timeout_seconds || this.config.default_timeout_seconds,
      this.config.max_timeout_seconds
    );

    const approvalId = uuidv4();
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now();

    const canonicalized = this.canonicalizeAction(request, nonce, timestamp);
    const actionPayloadHash = this.computeActionPayloadHash(canonicalized);
    const bindingHash = this.computeBindingHash(
      actionPayloadHash,
      request.target_adapter,
      request.target_endpoint,
      request.vault_grant_id,
      nonce,
      timestamp
    );

    const pending: PendingApproval = {
      approval_id: approvalId,
      task_id: taskId,
      status: 'pending',
      requested_at: timestamp,
      nonce,
      binding_hash: bindingHash,
      action_description: request.action_description,
      target_adapter: request.target_adapter,
      target_endpoint: request.target_endpoint,
      vault_grant_id: request.vault_grant_id,
      consequences_summary: request.consequences_summary,
      timeout_seconds: timeoutSeconds,
      escalation_policy: request.escalation_policy,
      escalation_level: 0,
      escalation_history: [],
      channels: request.channels,
      current_channel: request.channels[0],
      consumed: false,
      tainted: false,
    };

    this.pendingApprovals.set(approvalId, pending);
    taskSet.add(approvalId);
    this.taskApprovals.set(taskId, taskSet);

    await this.checkpointState();

    return {
      nonce,
      status: 'pending',
      tainted: false,
      provenance: {
        approval_id: approvalId,
        task_id: taskId,
        channel: request.channels[0],
        requested_at: timestamp,
        escalation_level: 0,
        binding_hash: bindingHash,
      },
      approval_id: approvalId,
    };
  }

  async cancelPending(taskId: string, approvalId: string): Promise<ApprovalOutput> {
    await this.initialize();

    const pending = this.pendingApprovals.get(approvalId);
    if (!pending || pending.task_id !== taskId) {
      return {
        status: 'error',
        tainted: false,
        provenance: {
          approval_id: approvalId,
          task_id: taskId,
          escalation_level: 0,
        },
      };
    }

    if (pending.status !== 'pending') {
      return {
        status: pending.status,
        tainted: pending.tainted,
        provenance: {
          approval_id: approvalId,
          task_id: taskId,
          escalation_level: pending.escalation_level,
        },
        approval_id: approvalId,
        escalation_history: pending.escalation_history,
      };
    }

    pending.status = 'cancelled';
    pending.token_hash = undefined;
    this.pendingApprovals.set(approvalId, pending);
    await this.checkpointState();

    return {
      status: 'cancelled',
      tainted: pending.tainted,
      provenance: {
        approval_id: approvalId,
        task_id: taskId,
        escalation_level: pending.escalation_level,
      },
      approval_id: approvalId,
      escalation_history: pending.escalation_history,
    };
  }

  async checkStatus(taskId: string, approvalId: string): Promise<ApprovalOutput> {
    await this.initialize();

    const pending = this.pendingApprovals.get(approvalId);
    if (!pending || pending.task_id !== taskId) {
      return {
        status: 'error',
        tainted: false,
        provenance: {
          approval_id: approvalId,
          task_id: taskId,
          escalation_level: 0,
        },
      };
    }

    const now = Date.now();
    if (pending.status === 'pending' && now > pending.requested_at + pending.timeout_seconds * 1000) {
      await this.resolveTimeout(taskId, approvalId, undefined);
      const updated = this.pendingApprovals.get(approvalId)!;
      return {
        status: updated.status,
        tainted: updated.tainted,
        provenance: {
          approval_id: approvalId,
          task_id: taskId,
          escalation_level: updated.escalation_level,
          binding_hash: updated.binding_hash,
        },
        approval_id: approvalId,
        escalation_history: updated.escalation_history,
      };
    }

    return {
      status: pending.status,
      tainted: pending.tainted,
      provenance: {
        approval_id: approvalId,
        task_id: taskId,
        channel: pending.current_channel,
        requested_at: pending.requested_at,
        escalation_level: pending.escalation_level,
        binding_hash: pending.binding_hash,
      },
      approval_id: approvalId,
      escalation_history: pending.escalation_history,
    };
  }

  async escalate(taskId: string, approvalId: string): Promise<ApprovalOutput> {
    await this.initialize();

    const pending = this.pendingApprovals.get(approvalId);
    if (!pending || pending.task_id !== taskId) {
      return {
        status: 'error',
        tainted: false,
        provenance: {
          approval_id: approvalId,
          task_id: taskId,
          escalation_level: 0,
        },
      };
    }

    if (pending.escalation_level >= this.config.max_escalation_levels) {
      pending.status = 'denied';
      this.pendingApprovals.set(approvalId, pending);
      await this.checkpointState();
      return {
        status: 'denied',
        tainted: pending.tainted,
        provenance: {
          approval_id: approvalId,
          task_id: taskId,
          escalation_level: pending.escalation_level,
        },
        approval_id: approvalId,
        escalation_history: pending.escalation_history,
      };
    }

    const nextLevel = pending.escalation_level + 1;
    let nextChannel: HITLChannel | undefined;

    if (pending.escalation_policy) {
      const levelPolicy = pending.escalation_policy.levels.find((l) => l.level === nextLevel);
      nextChannel = levelPolicy?.channel;
    }

    if (!nextChannel && nextLevel < pending.channels.length) {
      nextChannel = pending.channels[nextLevel];
    }

    if (!nextChannel) {
      pending.status = 'timeout';
      this.pendingApprovals.set(approvalId, pending);
      await this.checkpointState();
      return {
        status: 'timeout',
        tainted: pending.tainted,
        provenance: {
          approval_id: approvalId,
          task_id: taskId,
          escalation_level: pending.escalation_level,
        },
        approval_id: approvalId,
        escalation_history: pending.escalation_history,
      };
    }

    pending.escalation_level = nextLevel;
    pending.current_channel = nextChannel;
    pending.escalation_history.push({
      level: nextLevel,
      channel: nextChannel,
      timestamp: Date.now(),
      reason: `Escalated from level ${nextLevel - 1}`,
    });

    this.pendingApprovals.set(approvalId, pending);
    await this.checkpointState();

    return {
      status: 'escalated',
      tainted: pending.tainted,
      provenance: {
        approval_id: approvalId,
        task_id: taskId,
        channel: nextChannel,
        escalation_level: nextLevel,
      },
      approval_id: approvalId,
      escalation_history: pending.escalation_history,
    };
  }

  async resolveTimeout(
    taskId: string,
    approvalId: string,
    timeoutAction?: TimeoutAction
  ): Promise<ApprovalOutput> {
    await this.initialize();

    const pending = this.pendingApprovals.get(approvalId);
    if (!pending || pending.task_id !== taskId) {
      return {
        status: 'error',
        tainted: false,
        provenance: {
          approval_id: approvalId,
          task_id: taskId,
          escalation_level: 0,
        },
      };
    }

    const action = timeoutAction ||
      (pending.escalation_policy ? 'escalate' : 'reject');

    switch (action) {
      case 'escalate':
        return this.escalate(taskId, approvalId);
      case 'retry':
        pending.requested_at = Date.now();
        this.pendingApprovals.set(approvalId, pending);
        await this.checkpointState();
        return {
          status: 'pending',
          tainted: pending.tainted,
          provenance: {
            approval_id: approvalId,
            task_id: taskId,
            channel: pending.current_channel,
            requested_at: pending.requested_at,
            escalation_level: pending.escalation_level,
            binding_hash: pending.binding_hash,
          },
          approval_id: approvalId,
          escalation_history: pending.escalation_history,
        };
      case 'reject':
      default:
        pending.status = 'denied';
        this.pendingApprovals.set(approvalId, pending);
        await this.checkpointState();
        return {
          status: 'denied',
          tainted: pending.tainted,
          provenance: {
            approval_id: approvalId,
            task_id: taskId,
            escalation_level: pending.escalation_level,
          },
          approval_id: approvalId,
          escalation_history: pending.escalation_history,
        };
    }
  }

  async listPending(taskId: string): Promise<ApprovalOutput[]> {
    await this.initialize();

    const taskSet = this.taskApprovals.get(taskId);
    if (!taskSet) return [];

    const results: ApprovalOutput[] = [];
    for (const id of taskSet) {
      const pending = this.pendingApprovals.get(id);
      if (pending) {
        const now = Date.now();
        if (pending.status === 'pending' && now > pending.requested_at + pending.timeout_seconds * 1000) {
          await this.resolveTimeout(taskId, id, undefined);
        }
        const current = this.pendingApprovals.get(id)!;
        results.push({
          status: current.status,
          tainted: current.tainted,
          provenance: {
            approval_id: current.approval_id,
            task_id: current.task_id,
            channel: current.current_channel,
            requested_at: current.requested_at,
            escalation_level: current.escalation_level,
            binding_hash: current.binding_hash,
          },
          approval_id: current.approval_id,
          escalation_history: current.escalation_history,
        });
      }
    }
    return results;
  }

  async registerChannel(taskId: string, channelConfig: ChannelConfig): Promise<ApprovalOutput> {
    await this.initialize();

    const key = `${taskId}:${channelConfig.channel}`;
    this.channelConfigs.set(key, channelConfig);

    await this.checkpointState();

    return {
      status: 'approved',
      tainted: false,
      provenance: {
        approval_id: '',
        task_id: taskId,
        channel: channelConfig.channel,
        escalation_level: 0,
      },
    };
  }

  async processApprovalResponse(
    taskId: string,
    approvalId: string,
    response: { binding_token_affirmation?: string; tainted?: boolean }
  ): Promise<ApprovalOutput> {
    await this.initialize();

    const pending = this.pendingApprovals.get(approvalId);
    if (!pending || pending.task_id !== taskId || pending.status !== 'pending') {
      return {
        status: 'error',
        tainted: false,
        provenance: {
          approval_id: approvalId,
          task_id: taskId,
          escalation_level: pending?.escalation_level ?? 0,
        },
        approval_id: approvalId,
      };
    }

    if (!response.binding_token_affirmation) {
      return {
        status: 'invalid_signature',
        tainted: response.tainted ?? false,
        provenance: {
          approval_id: approvalId,
          task_id: taskId,
          escalation_level: pending.escalation_level,
          binding_hash: pending.binding_hash,
        },
        approval_id: approvalId,
      };
    }

    const tokenSignature = this.generateTokenSignature(
      approvalId,
      pending.binding_hash,
      pending.target_adapter,
      pending.target_endpoint,
      pending.vault_grant_id,
      pending.nonce,
      pending.requested_at
    );

    if (response.binding_token_affirmation !== tokenSignature) {
      return {
        status: 'invalid_signature',
        tainted: true,
        provenance: {
          approval_id: approvalId,
          task_id: taskId,
          escalation_level: pending.escalation_level,
          binding_hash: pending.binding_hash,
        },
        approval_id: approvalId,
      };
    }

    pending.status = 'approved';
    pending.approved_at = Date.now();
    pending.token_hash = crypto.createHash('sha256').update(tokenSignature, 'utf8').digest('hex');
    pending.tainted = response.tainted ?? false;

    this.pendingApprovals.set(approvalId, pending);
    await this.checkpointState();

    return {
      status: 'approved',
      tainted: pending.tainted,
      provenance: {
        approval_id: approvalId,
        task_id: taskId,
        channel: pending.current_channel,
        requested_at: pending.requested_at,
        resolved_at: pending.approved_at,
        escalation_level: pending.escalation_level,
        binding_hash: pending.binding_hash,
        token_signature: tokenSignature,
      },
      approval_id: approvalId,
      approval_token: tokenSignature,
      escalation_history: pending.escalation_history,
    };
  }

  async verifyApprovalToken(approvalId: string, token: string): Promise<ApprovalOutput> {
    await this.initialize();

    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      return {
        status: 'invalid_signature',
        tainted: false,
        provenance: {
          approval_id: approvalId,
          task_id: '',
          escalation_level: 0,
        },
        approval_id: approvalId,
      };
    }

    if (pending.status !== 'approved') {
      return {
        status: pending.status === 'cancelled' ? 'cancelled' : 'invalid_signature',
        tainted: pending.tainted,
        provenance: {
          approval_id: approvalId,
          task_id: pending.task_id,
          escalation_level: pending.escalation_level,
        },
        approval_id: approvalId,
      };
    }

    if (pending.consumed) {
      return {
        status: 'invalid_signature',
        tainted: false,
        provenance: {
          approval_id: approvalId,
          task_id: pending.task_id,
          escalation_level: pending.escalation_level,
        },
        approval_id: approvalId,
      };
    }

    const expectedToken = this.generateTokenSignature(
      approvalId,
      pending.binding_hash,
      pending.target_adapter,
      pending.target_endpoint,
      pending.vault_grant_id,
      pending.nonce,
      pending.requested_at
    );

    if (token !== expectedToken) {
      return {
        status: 'invalid_signature',
        tainted: false,
        provenance: {
          approval_id: approvalId,
          task_id: pending.task_id,
          escalation_level: pending.escalation_level,
        },
        approval_id: approvalId,
      };
    }

    pending.consumed = true;
    this.pendingApprovals.set(approvalId, pending);
    await this.checkpointState();

    return {
      status: 'approved',
      tainted: pending.tainted,
      provenance: {
        approval_id: approvalId,
        task_id: pending.task_id,
        channel: pending.current_channel,
        requested_at: pending.requested_at,
        escalation_level: pending.escalation_level,
        binding_hash: pending.binding_hash,
        token_signature: token,
      },
      approval_id: approvalId,
    };
  }

  getConfig(): HITLOrchestratorConfig {
    return { ...this.config };
  }
}

export const hitlOrchestrator = new HITLOrchestrator();
