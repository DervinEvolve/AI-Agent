import { createHash } from 'node:crypto';

export interface WorkspacePort {
  getCurrentGeneration(): Promise<string>;
  createTrialCopy(sourceGeneration: string): Promise<TrialCopyResult>;
  readFile(trialId: string, path: string): Promise<string | Uint8Array>;
  writeFile(trialId: string, path: string, content: string | Uint8Array): Promise<void>;
  listFiles(trialId: string): Promise<string[]>;
  runCheck(trialId: string, harnessIdentity?: string): Promise<CheckResult>;
  promote(trialId: string, snapshotDigest: string): Promise<void>;
  discard(trialId: string): Promise<DiscardResult>;
  getSnapshotDigest(trialId: string): Promise<string>;
}

export interface TrialCopyResult {
  trialId: string;
  snapshotDigest: string;
  fileCount: number;
  totalBytes: number;
}

export interface CheckResult {
  passed: boolean;
  snapshotDigest: string;
  harnessIdentity: string;
  checkWorkCount: number;
}

export interface DiscardResult {
  terminationConfirmed: boolean;
  cleanupConfirmed: boolean;
}

export interface CheckReceipt {
  trialId: string;
  snapshotDigest: string;
  harnessIdentity: string;
  confirmedLifecycle: boolean;
}

export interface PromotionOperation {
  trialId: string;
  snapshotDigest: string;
  state: 'prepared' | 'published' | 'cleanup_pending' | 'unresolved';
  parentGeneration?: string;
  startedAt: number;
  completedAt?: number;
}

export interface TrialRecord {
  trialId: string;
  sourceGeneration: string;
  createdAt: number;
  state: 'active' | 'abandoned' | 'cleanup_pending' | 'discarded' | 'unresolved';
  terminationConfirmed: boolean;
  cleanupConfirmed: boolean;
  snapshotDigest?: string;
  checkReceipt?: CheckReceipt;
  promotion?: PromotionOperation;
  lifecycleUnresolved?: boolean;
}

export interface TrialConfig {
  maxCreateAttempts: number;
  maxSnapshotBytes: number;
  maxSnapshotFiles: number;
  maxCopyDurationMs: number;
  maxCheckWorkCount: number;
  egressProfile: 'none';
  rejectCoMounts: string[];
}

export interface RecoveryLedgerLike {
  recordOutcome(callId: string, outcome: 'success' | 'failure' | 'unknown', context?: string): void;
  hasOpenSlot(): boolean;
  hasUnknownOutcome(): boolean;
  isQuarantined(): boolean;
}

export interface TrialToolContext {
  activeTrialId?: string;
  activeTrial?: TrialRecord;
  recoveryLedger: RecoveryLedgerLike;
  workspacePort: WorkspacePort;
  config: TrialConfig;
  toolName: string;
  toolArgs: Record<string, unknown>;
  callId: string;
}

export interface ToolResult {
  started: boolean;
  reason?: string;
  ok?: boolean;
  found?: boolean;
  output?: unknown;
}

export const DEFAULT_TRIAL_CONFIG: TrialConfig = {
  maxCreateAttempts: 2,
  maxSnapshotBytes: 256 * 1024 * 1024,
  maxSnapshotFiles: 20000,
  maxCopyDurationMs: 30_000,
  maxCheckWorkCount: 10,
  egressProfile: 'none',
  rejectCoMounts: [
    'cap_durable_runs_mount_41',
    'cap_interactive_session_49',
    'cap_parallel_tool_dispatch_48',
  ],
};

export const CONTROL_TOOLS = new Set(['create_trial', 'discard_trial', 'promote_trial', 'trial_status']);
export const INSPECTION_TOOLS = new Set(['recall', 'list_recalls']);
export const EXECUTION_TOOLS = new Set([
  'read_file',
  'list_files',
  'write_file',
  'edit_file',
  'run_code',
  'run_command',
  'run_check',
]);

export function computeDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export class TrialController {
  private readonly port: WorkspacePort;
  readonly config: TrialConfig;
  private readonly ledger: RecoveryLedgerLike;
  private activeTrial: TrialRecord | null = null;
  private readonly trials = new Map<string, TrialRecord>();
  private createAttempts = 0;
  private readonly promotionOperations: PromotionOperation[] = [];
  private lockQueue: Promise<void> = Promise.resolve();

  constructor(port: WorkspacePort, ledger: RecoveryLedgerLike, config: Partial<TrialConfig> = {}) {
    this.port = port;
    this.ledger = ledger;
    this.config = { ...DEFAULT_TRIAL_CONFIG, ...config, egressProfile: 'none' };
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lockQueue;
    let release!: () => void;
    this.lockQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private hasLifecycleUnresolved(): boolean {
    for (const trial of this.trials.values()) {
      if (!trial.terminationConfirmed || !trial.cleanupConfirmed) return true;
    }
    return false;
  }

  async createTrial(args: { name?: string }, callId: string): Promise<ToolResult> {
    if (args.name !== undefined && typeof args.name !== 'string') {
      return { started: false, reason: 'invalid_args' };
    }
    if (this.createAttempts >= this.config.maxCreateAttempts) {
      return { started: false, reason: 'trial_limit_exceeded' };
    }
    if (this.activeTrial) {
      return { started: false, reason: 'trial_already_active' };
    }
    if (this.ledger.hasOpenSlot() || this.ledger.hasUnknownOutcome() || this.ledger.isQuarantined()) {
      return { started: false, reason: 'trial_context_blocked' };
    }
    if (this.config.egressProfile !== 'none') {
      return { started: false, reason: 'trial_context_blocked' };
    }

    this.createAttempts++;
    const startedAt = Date.now();

    return this.withLock(async () => {
      try {
        const parentGen = await this.port.getCurrentGeneration();
        const copy = await this.port.createTrialCopy(parentGen);

        if (Date.now() - startedAt > this.config.maxCopyDurationMs) {
          await this.port.discard(copy.trialId);
          return { started: false, reason: 'trial_context_blocked' };
        }
        if (copy.totalBytes > this.config.maxSnapshotBytes || copy.fileCount > this.config.maxSnapshotFiles) {
          await this.port.discard(copy.trialId);
          return { started: false, reason: 'trial_limit_exceeded' };
        }

        const trial: TrialRecord = {
          trialId: copy.trialId,
          sourceGeneration: parentGen,
          createdAt: Date.now(),
          state: 'active',
          terminationConfirmed: false,
          cleanupConfirmed: false,
          snapshotDigest: copy.snapshotDigest,
        };
        this.trials.set(trial.trialId, trial);
        this.activeTrial = trial;
        return {
          started: true,
          ok: true,
          output: {
            trial_id: trial.trialId,
            source_generation: parentGen,
            created_at: trial.createdAt,
          },
        };
      } catch {
        return { started: false, reason: 'trial_context_blocked' };
      }
    });
  }

  async discardTrial(args: { trial_id: string }, _callId: string): Promise<ToolResult> {
    if (typeof args.trial_id !== 'string') {
      return { started: false, reason: 'invalid_args' };
    }
    const trial = this.trials.get(args.trial_id);
    if (!trial) {
      return { started: true, ok: true, found: false };
    }
    if (trial.state === 'discarded') {
      return { started: true, ok: true, found: true };
    }

    return this.withLock(async () => {
      const current = this.trials.get(args.trial_id);
      if (!current) return { started: true, ok: true, found: false };
      if (current.state === 'discarded') return { started: true, ok: true, found: true };

      const result = await this.port.discard(current.trialId);
      current.terminationConfirmed = result.terminationConfirmed;
      current.cleanupConfirmed = result.cleanupConfirmed;

      if (result.terminationConfirmed && result.cleanupConfirmed) {
        current.state = 'discarded';
        if (this.activeTrial?.trialId === current.trialId) {
          this.activeTrial = null;
        }
      } else {
        current.state = 'cleanup_pending';
        current.lifecycleUnresolved = true;
      }

      return { started: true, ok: true, found: true };
    });
  }

  async runCheck(trialId: string, harnessIdentity?: string, _callId?: string): Promise<ToolResult> {
    if (typeof trialId !== 'string') {
      return { started: false, reason: 'invalid_args' };
    }
    const trial = this.trials.get(trialId);
    if (!trial || this.activeTrial?.trialId !== trialId) {
      return { started: false, reason: 'invalid_args' };
    }
    if (!trial.terminationConfirmed || !trial.cleanupConfirmed) {
      return { started: false, reason: 'trial_lifecycle_unresolved' };
    }

    const result = await this.port.runCheck(trialId, harnessIdentity);
    if (result.checkWorkCount > this.config.maxCheckWorkCount) {
      return { started: false, reason: 'trial_lifecycle_unresolved' };
    }

    if (result.passed) {
      trial.checkReceipt = {
        trialId,
        snapshotDigest: result.snapshotDigest,
        harnessIdentity: result.harnessIdentity,
        confirmedLifecycle: true,
      };
    }

    return { started: true, ok: result.passed, output: result };
  }

  async promoteTrial(args: { trial_id: string; check_digest: string }, callId: string): Promise<ToolResult> {
    if (typeof args.trial_id !== 'string' || typeof args.check_digest !== 'string') {
      return { started: false, reason: 'invalid_args' };
    }
    const trial = this.trials.get(args.trial_id);
    if (!trial || this.activeTrial?.trialId !== args.trial_id) {
      return { started: false, reason: 'invalid_args' };
    }
    if (!trial.terminationConfirmed || !trial.cleanupConfirmed) {
      return { started: false, reason: 'trial_lifecycle_unresolved' };
    }
    if (!trial.checkReceipt) {
      return { started: false, reason: 'no_passing_check' };
    }
    if (trial.checkReceipt.snapshotDigest !== args.check_digest || trial.checkReceipt.trialId !== args.trial_id) {
      return { started: false, reason: 'check_digest_mismatch' };
    }

    return this.withLock(async () => {
      const current = this.trials.get(args.trial_id);
      if (!current || this.activeTrial?.trialId !== args.trial_id) {
        return { started: false, reason: 'invalid_args' };
      }
      if (!current.terminationConfirmed || !current.cleanupConfirmed) {
        return { started: false, reason: 'trial_lifecycle_unresolved' };
      }
      if (!current.checkReceipt || current.checkReceipt.snapshotDigest !== args.check_digest) {
        return { started: false, reason: current.checkReceipt ? 'check_digest_mismatch' : 'no_passing_check' };
      }

      const op: PromotionOperation = {
        trialId: args.trial_id,
        snapshotDigest: args.check_digest,
        state: 'prepared',
        startedAt: Date.now(),
      };
      this.promotionOperations.push(op);

      try {
        await this.port.promote(args.trial_id, args.check_digest);
        op.state = 'published';
        op.completedAt = Date.now();
        op.parentGeneration = await this.port.getCurrentGeneration();
        current.state = 'cleanup_pending';
        current.promotion = op;
        this.activeTrial = null;
        this.ledger.recordOutcome(callId, 'success', 'promote_trial');
        return { started: true, ok: true, output: { promotion: op } };
      } catch {
        op.state = 'unresolved';
        this.ledger.recordOutcome(callId, 'unknown', 'promote_trial');
        return { started: false, reason: 'trial_lifecycle_unresolved' };
      }
    });
  }

  async trialStatus(args: { trial_id?: string }, _callId: string): Promise<ToolResult> {
    if (args.trial_id !== undefined && typeof args.trial_id !== 'string') {
      return { started: false, reason: 'invalid_args' };
    }
    const target = args.trial_id ? this.trials.get(args.trial_id) : this.activeTrial;
    if (args.trial_id && !target) {
      return { started: true, ok: true, found: false };
    }
    return {
      started: true,
      ok: true,
      output: {
        active_trial: this.activeTrial ? this.activeTrial.trialId : null,
        trials: Array.from(this.trials.values()).map((t) => ({ ...t })),
        promotions: this.promotionOperations.map((p) => ({ ...p })),
        requested: target ? { ...target } : null,
      },
    };
  }

  async dispatchTool(
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
    toolKind?: 'control' | 'inspection' | 'execution' | 'other',
  ): Promise<ToolResult> {
    const kind = toolKind ?? this.classifyTool(toolName);

    if (kind === 'control') {
      switch (toolName) {
        case 'create_trial':
          return this.createTrial(args as { name?: string }, callId);
        case 'discard_trial':
          return this.discardTrial(args as { trial_id: string }, callId);
        case 'promote_trial':
          return this.promoteTrial(args as { trial_id: string; check_digest: string }, callId);
        case 'trial_status':
          return this.trialStatus(args as { trial_id?: string }, callId);
        default:
          return { started: false, reason: 'trial_context_unsupported' };
      }
    }

    if (kind === 'inspection') {
      return { started: true, ok: true, output: {} };
    }

    if (kind === 'execution') {
      if (!this.activeTrial) {
        return { started: false, reason: 'trial_context_unsupported' };
      }
      return this.routeExecutionTool(toolName, args, callId);
    }

    return { started: false, reason: 'trial_context_unsupported' };
  }

  private classifyTool(toolName: string): 'control' | 'inspection' | 'execution' | 'other' {
    if (CONTROL_TOOLS.has(toolName)) return 'control';
    if (INSPECTION_TOOLS.has(toolName)) return 'inspection';
    if (EXECUTION_TOOLS.has(toolName)) return 'execution';
    return 'other';
  }

  private async routeExecutionTool(
    toolName: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<ToolResult> {
    const trial = this.activeTrial!;
    if (!trial.terminationConfirmed || !trial.cleanupConfirmed) {
      return { started: false, reason: 'trial_lifecycle_unresolved' };
    }

    try {
      switch (toolName) {
        case 'read_file': {
          const path = args.path;
          if (typeof path !== 'string') return { started: false, reason: 'invalid_args' };
          const content = await this.port.readFile(trial.trialId, path);
          return { started: true, ok: true, output: { content } };
        }
        case 'list_files': {
          const files = await this.port.listFiles(trial.trialId);
          return { started: true, ok: true, output: { files } };
        }
        case 'write_file': {
          const path = args.path;
          const content = args.content;
          if (
            typeof path !== 'string' ||
            (typeof content !== 'string' && !(content instanceof Uint8Array))
          ) {
            return { started: false, reason: 'invalid_args' };
          }
          await this.port.writeFile(trial.trialId, path, content as string | Uint8Array);
          return { started: true, ok: true, output: {} };
        }
        case 'run_check': {
          const harness = typeof args.harness_identity === 'string' ? args.harness_identity : undefined;
          return this.runCheck(trial.trialId, harness, callId);
        }
        default:
          return { started: false, reason: 'trial_context_unsupported' };
      }
    } catch {
      this.ledger.recordOutcome(callId, 'failure', toolName);
      return { started: false, reason: 'trial_lifecycle_unresolved' };
    }
  }

  finalize(): void {
    if (this.activeTrial) {
      this.activeTrial.state = 'abandoned';
    }
  }

  assertNoCoMounts(mountedCapabilities: string[]): void {
    for (const cap of mountedCapabilities) {
      if (this.config.rejectCoMounts.includes(cap)) {
        throw new Error(`TrialController cannot co-mount with ${cap}`);
      }
    }
  }

  getActiveTrial(): TrialRecord | null {
    return this.activeTrial;
  }

  getTrial(trialId: string): TrialRecord | undefined {
    return this.trials.get(trialId);
  }

  getPromotionOperations(): readonly PromotionOperation[] {
    return this.promotionOperations;
  }
}
