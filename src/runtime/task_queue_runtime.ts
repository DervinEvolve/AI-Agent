/**
 * Runtime-owned TaskQueue integration.
 *
 * The queue is not a second scheduler. AgentRuntime (or a host that owns the
 * same run) constructs a TaskQueueRuntime, dispatches queue tools only through
 * it, and is the only caller of activateNext / retireKnownFailureSlot /
 * onFinalAnswer. Queue tools are excluded from delegation allowlists.
 */

import {
  ConsolidatedEvidenceValidator,
  QueueStartupError,
  TASK_QUEUE_TOOL_NAMES,
  TaskQueue,
  freezeQueuePolicy,
  isTaskQueueTool,
  rejectQueueToolsFromDelegation,
  type CitationHandler,
  type DurableRunService,
  type QueuePolicy,
  type QueuePolicyInput,
  type RecoveryLedgerLike,
  type SegmentView,
  type TaskQueueToolResult,
} from "../capabilities/cap_task_queue_47.js";

export interface RunCaps {
  maxTotalSteps: number;
  wallClockDeadlineMs: number;
  maxRecoveryDispatches: number;
}

export interface TaskQueueRuntimeOptions {
  /** Absent policy: tools stay unregistered for mutation and writes nothing. */
  policy?: QueuePolicyInput | null;
  runCaps: RunCaps;
  hostTask: string;
  ledger?: RecoveryLedgerLike;
  handlers?: CitationHandler[];
  durableService?: DurableRunService | null;
  now?: number;
}

export class TaskQueueRuntime {
  readonly enabled: boolean;
  readonly policy: QueuePolicy | null;
  private readonly queue: TaskQueue | null;
  private readonly hostTask: string;
  private readonly admissionTrace: string[] = [];
  /** Adapter-call counter preserved even when policy is absent. */
  adapterCalls = 0;

  private constructor(enabled: boolean, policy: QueuePolicy | null, queue: TaskQueue | null, hostTask: string) {
    this.enabled = enabled;
    this.policy = policy;
    this.queue = queue;
    this.hostTask = hostTask;
  }

  static start(opts: TaskQueueRuntimeOptions): TaskQueueRuntime {
    if (!opts.policy) {
      return new TaskQueueRuntime(false, null, null, opts.hostTask);
    }
    const frozen = freezeQueuePolicy(opts.policy, opts.runCaps);
    if (!frozen) {
      return new TaskQueueRuntime(false, null, null, opts.hostTask);
    }
    if (frozen.mode === "durable") {
      const queue = TaskQueue.create({
        policy: frozen,
        ledger: opts.ledger,
        evidence: new ConsolidatedEvidenceValidator(),
        handlers: opts.handlers ?? [],
        durableService: opts.durableService ?? null,
        now: opts.now,
      });
      return new TaskQueueRuntime(true, frozen, queue, opts.hostTask);
    }
    const queue = TaskQueue.create({
      policy: frozen,
      ledger: opts.ledger,
      evidence: new ConsolidatedEvidenceValidator(),
      handlers: opts.handlers ?? [],
      durableService: null,
      now: opts.now,
    });
    return new TaskQueueRuntime(true, frozen, queue, opts.hostTask);
  }

  schemas(): ReturnType<typeof TaskQueue.toolSchemas> {
    return TaskQueue.toolSchemas();
  }

  registeredToolNames(): readonly string[] {
    return this.enabled ? TASK_QUEUE_TOOL_NAMES : [];
  }

  assertDelegationAllowlist(allowlist: readonly string[]): void {
    const check = rejectQueueToolsFromDelegation(allowlist);
    if (!check.ok) {
      throw new Error(check.error);
    }
  }

  /**
   * Dispatch a tool call. Non-queue tools are not handled here.
   * Absent policy: listing schemas is a no-write; mutation tools are refused
   * without incrementing a write, and adapterCalls still increments so traces
   * stay comparable.
   */
  dispatch(name: string, args: Record<string, unknown>): TaskQueueToolResult {
    this.adapterCalls += 1;
    if (!isTaskQueueTool(name)) {
      return { ok: false, started: false, error: "not_queue_tool", code: "invalid_args" };
    }
    if (!this.queue) {
      this.admissionTrace.push(`absent:${name}`);
      if (name === "list_tasks") {
        return { ok: true, started: false, tasks: [], activeTaskId: null };
      }
      return { ok: false, started: false, error: "queue_not_configured", code: "policy" };
    }
    return this.queue.dispatchTool(name, args);
  }

  /** Shared step admission used by ordinary actions while a queue is mounted. */
  admitSharedStep(): { ok: true } | { ok: false; reason: string } {
    this.adapterCalls += 1;
    if (!this.queue) {
      this.admissionTrace.push("absent:admit");
      return { ok: true };
    }
    return this.queue.admitStep();
  }

  activateNext(): TaskQueueToolResult {
    if (!this.queue) return { ok: false, started: false, error: "queue_not_configured", code: "policy" };
    return this.queue.activateNext();
  }

  /** Tests and hosts must not pass authorizedByAbandon; the runtime refuses it. */
  activateNextAfterAbandon(): TaskQueueToolResult {
    if (!this.queue) return { ok: false, started: false, error: "queue_not_configured", code: "policy" };
    return this.queue.activateNext({ authorizedByAbandon: true });
  }

  retireKnownFailure(taskId: string): TaskQueueToolResult {
    if (!this.queue) return { ok: false, started: false, error: "queue_not_configured", code: "policy" };
    return this.queue.retireKnownFailureSlot(taskId);
  }

  recordUnknownOutcome(taskId: string): void {
    this.queue?.recordUnknownOutcome(taskId);
  }

  onFinalAnswer(): void {
    this.queue?.onFinalAnswer();
  }

  finalizeDrainage(reason: string): void {
    this.queue?.finalizeDrainage(reason);
  }

  segment(): SegmentView | null {
    return this.queue ? this.queue.segmentView(this.hostTask) : null;
  }

  statusSection(): string {
    if (!this.queue) return "queue_status: absent";
    return this.queue.statusSection();
  }

  trace(): readonly string[] {
    return this.queue ? this.queue.getTrace() : this.admissionTrace;
  }

  async resume(): Promise<{ restored: true; replayed: false } | { restored: false; reason: string }> {
    if (!this.queue || !this.policy) return { restored: false, reason: "queue_not_configured" };
    if (this.policy.mode !== "durable") return { restored: false, reason: "memory_only" };
    return this.queue.resumeFromDurable();
  }

  snapshot() {
    return this.queue?.snapshot() ?? null;
  }
}

export { QueueStartupError };
