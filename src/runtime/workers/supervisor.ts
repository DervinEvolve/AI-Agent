import { FifoInferencePermit } from "./inference_permit.js";
import { buildReportPage, exposedCitationIds, freezeReport, type FrozenReport } from "./report_page.js";
import { claimSharedTeardownReserve, operationalDeadline } from "./teardown_reserve.js";
import { utf8ByteLength } from "./utf8.js";
import {
  CONCURRENT_WORKERS_DEFAULT,
  CONCURRENT_WORKERS_HARD_MAX,
  EVIDENCE_SHAPE_WORKER_POLL,
  MAX_CONCURRENT_INFERENCE_DEFAULT,
  NORMAL_POLL_REPEAT_THRESHOLD,
  PARENT_STEP_RESERVE_DEFAULT,
  PARENT_STEP_RESERVE_MAX,
  PARENT_STEP_RESERVE_MIN,
  POLL_OUTPUT_MAX_BYTES,
  RECOVERY_SUB_ALLOWANCE_DEFAULT,
  RECOVERY_SUB_ALLOWANCE_MAX,
  RECOVERY_SUB_ALLOWANCE_MIN,
  SPAWN_ATTEMPTS_DEFAULT,
  SPAWN_ATTEMPTS_HARD_MAX,
  TASK_MAX_BYTES,
  TASK_MIN_BYTES,
  TEARDOWN_RESERVE_DEFAULT_MS,
  WAIT_MS_DEFAULT,
  WAIT_MS_MAX,
  WAIT_MS_MIN,
  WORKER_MAX_STEPS_DEFAULT,
  WORKER_MAX_STEPS_MAX,
  WORKER_MAX_STEPS_MIN,
  WORKER_QUIET_POLL_LIMIT_DEFAULT,
  WORKER_QUIET_POLL_LIMIT_MAX,
  WORKER_QUIET_POLL_LIMIT_MIN,
  WORKER_REASON,
  WORKER_RECOVERY_BUDGET_DEFAULT,
  WORKER_RECOVERY_BUDGET_MAX,
  WORKER_RECOVERY_BUDGET_MIN,
  type ChildLoopFactory,
  type CitationDescriptor,
  type ClockPort,
  type EligibleTool,
  type FrozenWorkerConfig,
  type InferenceAdapter,
  type InferenceResponse,
  type ParentLedgerView,
  type ReportItem,
  type SharedReserveBucket,
  type SpawnReconciliationRecord,
  type ToolRegistryPort,
  type UsageAdmission,
  type WorkerConfig,
  type WorkerPort,
  type WorkerRecord,
  type WorkerToolSchema,
} from "./types.js";

export interface Accounting {
  sharedStepPool: number;
  parentSpent: number;
  workerReserved: number;
  workerSpent: number;
  workerReleased: number;
  recoveryReserved: number;
  recoveryCumulative: number;
  recoveryReleased: number;
  parentRecoveryDebits: number;
}

interface LiveWorker {
  record: WorkerRecord;
  abort: AbortController;
  report: FrozenReport | null;
  items: ReportItem[];
  reservedSteps: number;
  recoveryReserved: number;
  recoverySpent: number;
  decoded: { toolName: string; toolArgs: unknown } | null;
  startedTools: Map<string, { cleanupConfirmed: boolean; settled: boolean; outcome: string }>;
  successfulCalls: Map<string, { worker_id: string; classifier_ok: boolean }>;
  loop: Promise<void> | null;
  holdInference: Promise<void> | null;
  releaseInference: (() => void) | null;
  providerPending: boolean;
  nonCooperativePending: boolean;
}

export interface CreateRuntimeDeps {
  config: WorkerConfig;
  clock?: ClockPort;
  adapter?: InferenceAdapter;
  registry?: ToolRegistryPort;
  usage?: UsageAdmission;
  parentLedger?: ParentLedgerView;
  childFactory?: ChildLoopFactory;
  runDeadlineMs?: number;
  reserveBucket?: SharedReserveBucket;
  now?: number;
}

export type CreateResult =
  | { ok: true; runtime: WorkerRuntime }
  | { ok: false; reason: string };

const WORKER_TOOLS: WorkerToolSchema[] = [
  {
    name: "spawn_agent",
    idempotent: false,
    concurrentSafe: false,
    description: "Start a depth-1 worker and return worker_id without waiting for its report.",
  },
  {
    name: "poll_agent",
    idempotent: true,
    concurrentSafe: false,
    description: "List workers or return one status and, when terminal, one report page.",
  },
  {
    name: "stop_agent",
    idempotent: true,
    concurrentSafe: false,
    description: "Fence and drain a worker within grace and remaining teardown time.",
  },
];

class DefaultClock implements ClockPort {
  now(): number {
    return Date.now();
  }
  async wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("cancelled");
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new Error("cancelled"));
        },
        { once: true },
      );
    });
  }
}

class DefaultUsage implements UsageAdmission {
  private unknown = 0;
  admit(): { ok: true } {
    return { ok: true };
  }
  settle(authoritative: boolean): void {
    if (!authoritative) this.unknown += 1;
  }
  unknownOutstanding(): number {
    return this.unknown;
  }
}

function inRange(n: number, min: number, max: number): boolean {
  return Number.isInteger(n) && n >= min && n <= max;
}

export function freezeWorkerConfig(config: WorkerConfig): { ok: true; frozen: FrozenWorkerConfig } | { ok: false; reason: string } {
  if (
    config.durableRun ||
    config.interactiveSession ||
    config.workspaceTrials ||
    config.guiControl ||
    config.toolDiscovery
  ) {
    return { ok: false, reason: WORKER_REASON.STARTUP_REJECTED };
  }
  const maxConcurrentWorkers = config.maxConcurrentWorkers ?? CONCURRENT_WORKERS_DEFAULT;
  const maxSpawnAttempts = config.maxSpawnAttempts ?? SPAWN_ATTEMPTS_DEFAULT;
  const defaultMaxSteps = config.defaultMaxSteps ?? WORKER_MAX_STEPS_DEFAULT;
  const parentStepReserve = config.parentStepReserve ?? PARENT_STEP_RESERVE_DEFAULT;
  const maxConcurrentInference = config.maxConcurrentInference ?? MAX_CONCURRENT_INFERENCE_DEFAULT;
  const workerRecoveryBudget = config.workerRecoveryBudget ?? WORKER_RECOVERY_BUDGET_DEFAULT;
  const recoverySubAllowance = config.recoverySubAllowance ?? RECOVERY_SUB_ALLOWANCE_DEFAULT;
  const teardownReserveMs = config.teardownReserveMs ?? TEARDOWN_RESERVE_DEFAULT_MS;
  const workerQuietPollLimit = config.workerQuietPollLimit ?? WORKER_QUIET_POLL_LIMIT_DEFAULT;
  if (
    !inRange(maxConcurrentWorkers, 1, CONCURRENT_WORKERS_HARD_MAX) ||
    !inRange(maxSpawnAttempts, 1, SPAWN_ATTEMPTS_HARD_MAX) ||
    !inRange(defaultMaxSteps, WORKER_MAX_STEPS_MIN, WORKER_MAX_STEPS_MAX) ||
    !inRange(parentStepReserve, PARENT_STEP_RESERVE_MIN, PARENT_STEP_RESERVE_MAX) ||
    !inRange(maxConcurrentInference, 1, 2) ||
    !inRange(workerRecoveryBudget, WORKER_RECOVERY_BUDGET_MIN, WORKER_RECOVERY_BUDGET_MAX) ||
    !inRange(recoverySubAllowance, RECOVERY_SUB_ALLOWANCE_MIN, RECOVERY_SUB_ALLOWANCE_MAX) ||
    !inRange(workerQuietPollLimit, WORKER_QUIET_POLL_LIMIT_MIN, WORKER_QUIET_POLL_LIMIT_MAX) ||
    teardownReserveMs < 0 ||
    teardownReserveMs > 30_000
  ) {
    return { ok: false, reason: WORKER_REASON.STARTUP_REJECTED };
  }
  return {
    ok: true,
    frozen: {
      enabled: config.enabled,
      principalId: config.principalId,
      allowlist: [...config.allowlist],
      maxConcurrentWorkers,
      maxSpawnAttempts,
      defaultMaxSteps,
      parentStepReserve,
      maxConcurrentInference,
      workerRecoveryBudget,
      recoverySubAllowance,
      teardownReserveMs,
      workerQuietPollLimit,
      sharedStepPool: config.sharedStepPool ?? 64,
      durableRun: false,
      interactiveSession: false,
      workspaceTrials: false,
      guiControl: false,
      toolDiscovery: false,
      jobsMounted: Boolean(config.jobsMounted),
      jobsReserveCompatible: config.jobsReserveCompatible !== false,
    },
  };
}

export function workerToolSchemas(enabled: boolean): WorkerToolSchema[] {
  return enabled ? WORKER_TOOLS.map((t) => ({ ...t })) : [];
}

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}_${idSeq}`;
}

export class WorkerRuntime implements WorkerPort {
  readonly frozen: FrozenWorkerConfig;
  readonly accounting: Accounting;
  readonly reconciliations: SpawnReconciliationRecord[] = [];
  readonly permit: FifoInferencePermit;
  readonly bucket: SharedReserveBucket;
  readonly operationalDeadlineMs: number;
  adapterCalls = 0;
  parentSlotOpenedByRuntimeSpawnFailure = false;
  runWideUnknown = false;
  delegationActive = false;
  parentSlotOpen = false;
  baselineSchemaCount: number;
  private workers = new Map<string, LiveWorker>();
  private fencedAttempts = new Set<string>();
  private unresolvedSpawn = false;
  private quietCounts = new Map<string, number>();
  private zeroWaitCounts = new Map<string, number>();
  private lastFingerprint = new Map<string, string>();
  private pollSeq = 0;
  private stopped = false;
  private cleanupConfirmedRun = false;

  constructor(
    frozen: FrozenWorkerConfig,
    private readonly clock: ClockPort,
    private readonly adapter: InferenceAdapter,
    private readonly registry: ToolRegistryPort,
    private readonly usage: UsageAdmission,
    private readonly parentLedger: ParentLedgerView,
    private readonly childFactory: ChildLoopFactory,
    bucket: SharedReserveBucket,
    operationalDeadlineMs: number,
    baselineSchemaCount: number,
  ) {
    this.frozen = frozen;
    this.bucket = bucket;
    this.operationalDeadlineMs = operationalDeadlineMs;
    this.baselineSchemaCount = baselineSchemaCount;
    this.permit = new FifoInferencePermit(frozen.maxConcurrentInference);
    this.accounting = {
      sharedStepPool: frozen.sharedStepPool,
      parentSpent: 0,
      workerReserved: 0,
      workerSpent: 0,
      workerReleased: 0,
      recoveryReserved: 0,
      recoveryCumulative: 0,
      recoveryReleased: 0,
      parentRecoveryDebits: parentLedger.recoveryDebits,
    };
    this.parentSlotOpen = parentLedger.openSlot;
    this.runWideUnknown = parentLedger.unresolvedUnknown;
  }

  schemas(): WorkerToolSchema[] {
    if (!this.frozen.enabled) return [];
    return workerToolSchemas(true);
  }

  start(workerId: string): void {
    const live = this.workers.get(workerId);
    if (!live || live.loop) return;
    live.loop = this.runChild(live);
  }

  cancel(workerId: string): void {
    const live = this.workers.get(workerId);
    if (!live) return;
    this.fence(live);
    live.abort.abort();
  }

  snapshot(workerId: string): WorkerRecord | undefined {
    const live = this.workers.get(workerId);
    return live ? { ...live.record, limits: { ...live.record.limits } } : undefined;
  }

  setDelegationActive(active: boolean): void {
    this.delegationActive = active;
  }

  setParentSlotOpen(open: boolean): void {
    this.parentSlotOpen = open;
    this.parentLedger.openSlot = open;
  }

  setRunWideUnknown(unknown: boolean): void {
    this.runWideUnknown = unknown;
    this.parentLedger.unresolvedUnknown = unknown;
  }

  noteParentFailure(): void {
    this.parentSlotOpen = true;
    this.parentLedger.openSlot = true;
    this.parentLedger.recoveryDebits += 1;
    this.accounting.parentRecoveryDebits = this.parentLedger.recoveryDebits;
  }

  parentUnreservedRemaining(): number {
    return (
      this.accounting.sharedStepPool -
      this.accounting.parentSpent -
      this.accounting.workerReserved -
      this.frozen.parentStepReserve
    );
  }

  spendParentStep(reason: string): { ok: true } | { ok: false; reason: string } {
    if (this.accounting.parentSpent + 1 + this.accounting.workerReserved > this.accounting.sharedStepPool) {
      return { ok: false, reason: "parent_steps_exhausted" };
    }
    const unreserved =
      this.accounting.sharedStepPool - this.accounting.workerReserved - this.accounting.parentSpent;
    if (unreserved < 1) return { ok: false, reason: "would_spend_worker_reservation" };
    if (reason !== "teardown" && unreserved - 1 < 0) {
      return { ok: false, reason: "would_spend_worker_reservation" };
    }
    this.accounting.parentSpent += 1;
    return { ok: true };
  }

  async parentTurn(prompt = "parent"): Promise<{ ok: boolean; text?: string; reason?: string }> {
    const spent = this.spendParentStep("parent_turn");
    if (!spent.ok) return spent;
    return this.infer("parent", "parent", 0, prompt);
  }

  delegateTask(): { ok: false; reason: string; slotEffect: false } {
    if (this.anyBlockingWorker()) {
      return { ok: false, reason: WORKER_REASON.WORKER_FAMILY_BLOCKED, slotEffect: false };
    }
    return { ok: false, reason: "no_delegate_mount", slotEffect: false };
  }

  spawn(input: { task: string; allowed_tools?: string[]; max_steps?: number; timeoutPhase?: "pre" | "post" | null }): {
    ok: boolean;
    output: Record<string, unknown>;
    worker_started?: boolean;
  } {
    if (!this.frozen.enabled) {
      return { ok: false, output: { ok: false, reason: "disabled" } };
    }
    const step = this.spendParentStep("spawn_wrapper");
    if (!step.ok) return { ok: false, output: { ok: false, reason: step.reason, started: false } };

    const refusal = this.spawnRefusal(input);
    if (refusal) {
      return { ok: true, output: { ok: false, started: false, worker_started: false, reason: refusal, slot_effect: false } };
    }

    const taskBytes = utf8ByteLength(input.task);
    if (taskBytes < TASK_MIN_BYTES || taskBytes > TASK_MAX_BYTES) {
      this.accountingNoteAttempt();
      return {
        ok: true,
        output: { ok: false, started: false, worker_started: false, reason: WORKER_REASON.POLICY_REFUSAL, slot_effect: false },
      };
    }

    const maxSteps = input.max_steps ?? this.frozen.defaultMaxSteps;
    if (!inRange(maxSteps, WORKER_MAX_STEPS_MIN, WORKER_MAX_STEPS_MAX)) {
      this.accountingNoteAttempt();
      return {
        ok: true,
        output: { ok: false, started: false, worker_started: false, reason: WORKER_REASON.CAP_REFUSAL, slot_effect: false },
      };
    }

    const narrowed = this.narrowTools(input.allowed_tools);
    if (!narrowed.ok) {
      this.accountingNoteAttempt();
      return {
        ok: true,
        output: { ok: false, started: false, worker_started: false, reason: narrowed.reason, slot_effect: false },
      };
    }

    const remainingAfterParentFloor =
      this.accounting.sharedStepPool -
      this.accounting.parentSpent -
      this.accounting.workerReserved -
      this.frozen.parentStepReserve;
    if (maxSteps > remainingAfterParentFloor) {
      this.accountingNoteAttempt();
      return {
        ok: true,
        output: {
          ok: false,
          started: false,
          worker_started: false,
          reason: WORKER_REASON.WORKER_BUDGET_EXCEEDED,
          slot_effect: false,
        },
      };
    }

    const sub = this.frozen.recoverySubAllowance;
    if (this.accounting.recoveryReserved + sub > this.frozen.workerRecoveryBudget) {
      this.accountingNoteAttempt();
      return {
        ok: true,
        output: {
          ok: false,
          started: false,
          worker_started: false,
          reason: WORKER_REASON.WORKER_BUDGET_EXCEEDED,
          slot_effect: false,
        },
      };
    }

    const attemptId = nextId("attempt");
    this.unresolvedSpawn = true;
    this.accountingNoteAttempt();

    if (input.timeoutPhase === "pre") {
      this.fencedAttempts.add(attemptId);
      this.unresolvedSpawn = false;
      this.reconciliations.push({
        attempt_id: attemptId,
        worker_id: null,
        reconciliation_status: "not_started",
        fenced: true,
        replayed: false,
      });
      return {
        ok: true,
        output: { ok: false, started: false, worker_started: false, reason: WORKER_REASON.NOT_STARTED, attempt_id: attemptId },
      };
    }

    if (this.fencedAttempts.has(attemptId)) {
      return { ok: true, output: { ok: false, started: false, reason: WORKER_REASON.NOT_STARTED } };
    }

    const workerId = nextId("worker");
    this.accounting.workerReserved += maxSteps;
    this.accounting.recoveryReserved += sub;
    const now = this.clock.now();
    const record: WorkerRecord = {
      worker_id: workerId,
      attempt_id: attemptId,
      task: input.task,
      state: "running",
      child_step_index: 0,
      reconciliation_status: "pending",
      generation: 1,
      cleanup_confirmed: false,
      outcome_unknown: false,
      usage_unknown: false,
      terminal: false,
      started_at: now,
      limits: { max_steps: maxSteps, recovery_sub_allowance: sub, reserved_steps: maxSteps },
      allowed_tools: narrowed.tools,
      unresolved_operations: [],
      report_frozen: false,
    };
    const live: LiveWorker = {
      record,
      abort: new AbortController(),
      report: null,
      items: [],
      reservedSteps: maxSteps,
      recoveryReserved: sub,
      recoverySpent: 0,
      decoded: null,
      startedTools: new Map(),
      successfulCalls: new Map(),
      loop: null,
      holdInference: null,
      releaseInference: null,
      providerPending: false,
      nonCooperativePending: false,
    };
    this.workers.set(workerId, live);
    this.reconciliations.push({
      attempt_id: attemptId,
      worker_id: workerId,
      reconciliation_status: "pending",
      fenced: false,
      replayed: false,
    });
    this.unresolvedSpawn = false;

    if (input.timeoutPhase === "post") {
      live.record.reconciliation_status = "unknown";
      live.record.outcome_unknown = true;
      this.runWideUnknown = true;
      const rec = this.reconciliations.find((r) => r.attempt_id === attemptId);
      if (rec) rec.reconciliation_status = "unknown";
      return {
        ok: true,
        worker_started: false,
        output: {
          ok: false,
          status: "unknown",
          worker_started: false,
          worker_id: workerId,
          started_at: now,
          reason: WORKER_REASON.UNKNOWN,
          replayed: false,
        },
      };
    }

    const factoryResult = this.childFactory({
      workerId,
      attemptId,
      generation: live.record.generation,
      task: input.task,
      maxSteps,
      signal: live.abort.signal,
    });
    if (!factoryResult.started) {
      this.parentSlotOpen = true;
      this.parentLedger.openSlot = true;
      this.parentSlotOpenedByRuntimeSpawnFailure = true;
      live.record.state = "failed";
      live.record.terminal = true;
      live.record.reconciliation_status = "started";
      this.releaseUnused(live);
      return {
        ok: true,
        output: { ok: false, worker_started: false, worker_id: workerId, reason: factoryResult.reason, slot_effect: true },
      };
    }

    live.record.reconciliation_status = "started";
    const rec = this.reconciliations.find((r) => r.attempt_id === attemptId);
    if (rec) rec.reconciliation_status = "started";
    this.start(workerId);
    return {
      ok: true,
      worker_started: true,
      output: {
        ok: true,
        status: "ok",
        worker_started: true,
        worker_id: workerId,
        started_at: now,
        limits: { ...record.limits },
      },
    };
  }

  lateCommit(attemptId: string): { committed: false; reason: string } {
    if (this.fencedAttempts.has(attemptId) || this.reconciliations.some((r) => r.attempt_id === attemptId)) {
      return { committed: false, reason: WORKER_REASON.NOT_STARTED };
    }
    this.fencedAttempts.add(attemptId);
    return { committed: false, reason: "no_late_commit" };
  }

  async poll(input: {
    worker_id?: string;
    wait_ms?: number;
    offset?: number;
    limit?: number;
  }): Promise<{ ok: true; output: Record<string, unknown>; call_id: string }> {
    this.spendParentStep("poll");
    const call_id = `poll_${++this.pollSeq}`;
    const wait = input.wait_ms ?? WAIT_MS_DEFAULT;
    if (wait < WAIT_MS_MIN || wait > WAIT_MS_MAX) {
      return { ok: true, call_id, output: this.bound({ ok: false, reason: WORKER_REASON.POLICY_REFUSAL }) };
    }
    if (wait > 0) {
      try {
        await this.clock.wait(wait);
      } catch {
        return { ok: true, call_id, output: this.bound({ ok: true, interrupted: true, reason: "cancelled" }) };
      }
    }
    if (!input.worker_id) {
      return {
        ok: true,
        call_id,
        output: this.bound({
          ok: true,
          workers: [...this.workers.values()].map((w) => this.publicRecord(w)),
          reconciliations: this.reconciliations.map((r) => ({ ...r })),
        }),
      };
    }
    const live = this.workers.get(input.worker_id);
    if (!live) {
      return { ok: true, call_id, output: this.bound({ ok: true, found: false }) };
    }
    const fingerprint = `${live.record.state}|${live.record.child_step_index}|${live.record.reconciliation_status}`;
    const prev = this.lastFingerprint.get(live.record.worker_id);
    const changed = prev !== fingerprint;
    this.lastFingerprint.set(live.record.worker_id, fingerprint);
    let repeating = false;
    if (changed) {
      this.quietCounts.set(live.record.worker_id, 0);
      this.zeroWaitCounts.set(live.record.worker_id, 0);
    } else if (wait > 0) {
      const n = (this.quietCounts.get(live.record.worker_id) ?? 0) + 1;
      this.quietCounts.set(live.record.worker_id, n);
      repeating = n >= this.frozen.workerQuietPollLimit;
    } else {
      const n = (this.zeroWaitCounts.get(live.record.worker_id) ?? 0) + 1;
      this.zeroWaitCounts.set(live.record.worker_id, n);
      repeating = n >= NORMAL_POLL_REPEAT_THRESHOLD;
    }
    const output: Record<string, unknown> = {
      ok: true,
      found: true,
      worker_id: live.record.worker_id,
      state: live.record.state,
      child_step_index: live.record.child_step_index,
      reconciliation_status: live.record.reconciliation_status,
      cleanup_confirmed: live.record.cleanup_confirmed,
      outcome_unknown: live.record.outcome_unknown,
      usage_unknown: live.record.usage_unknown,
      terminal: live.record.terminal,
      unresolved_operations: [...live.record.unresolved_operations],
      non_cooperative_provider_pending: live.nonCooperativePending,
      repeating,
      call_id,
      evidence_shape: EVIDENCE_SHAPE_WORKER_POLL,
    };
    if (live.record.terminal && live.report) {
      const page = buildReportPage(live.report, input.offset ?? 0, input.limit);
      output.report_page = page;
      output.exposed_citation_ids = exposedCitationIds(page);
    }
    return { ok: true, call_id, output: this.bound(output) };
  }

  async stop(worker_id: string): Promise<{ ok: true; output: Record<string, unknown> }> {
    this.spendParentStep("stop");
    const live = this.workers.get(worker_id);
    if (!live) return { ok: true, output: { ok: true, found: false } };
    if (live.record.cleanup_confirmed && live.record.terminal) {
      return { ok: true, output: { ok: true, found: true, already_stopped: true, reason: WORKER_REASON.ALREADY_STOPPED } };
    }
    this.fence(live);
    live.abort.abort();
    const grace = Math.min(this.bucket.reserveMs, Math.max(0, this.operationalDeadlineMs));
    const drain = live.loop;
    let timedOut = false;
    if (drain) {
      const result = await Promise.race([
        drain.then(() => "done" as const),
        this.clock.wait(grace).then(() => "timeout" as const),
      ]);
      timedOut = result === "timeout";
    }
    const unconfirmed = [...live.startedTools.values()].some((t) => !t.cleanupConfirmed);
    if (unconfirmed || timedOut || live.record.outcome_unknown && live.startedTools.size === 0 && live.providerPending) {
      live.record.cleanup_confirmed = false;
      if (unconfirmed || timedOut) {
        live.record.outcome_unknown = true;
        this.runWideUnknown = true;
        if (!live.record.unresolved_operations.includes(WORKER_REASON.TEARDOWN_UNCONFIRMED)) {
          live.record.unresolved_operations.push(WORKER_REASON.TEARDOWN_UNCONFIRMED);
        }
      }
      return {
        ok: true,
        output: {
          ok: false,
          found: true,
          cleanup_confirmed: false,
          reason: WORKER_REASON.TEARDOWN_UNCONFIRMED,
          outcome: WORKER_REASON.UNKNOWN,
          limitation: live.nonCooperativePending ? "provider_request_may_remain_pending" : undefined,
        },
      };
    }
    live.record.cleanup_confirmed = true;
    live.record.state = live.record.state === "running" || live.record.state === "paused" ? "cancelled" : live.record.state;
    live.record.terminal = true;
    live.record.reconciliation_status = "stopped";
    this.releaseUnused(live);
    if (!live.report) this.finishReport(live, "cancelled");
    return {
      ok: true,
      output: { ok: true, found: true, cleanup_confirmed: true, already_stopped: false, reason: WORKER_REASON.CLEANUP_CONFIRMED },
    };
  }

  async abortAll(): Promise<void> {
    this.stopped = true;
    for (const live of this.workers.values()) {
      this.fence(live);
      live.abort.abort();
    }
    await Promise.all([...this.workers.values()].map((w) => w.loop?.catch(() => undefined)));
  }

  async teardown(): Promise<{ cleanup_confirmed: boolean; teardown_unconfirmed: boolean }> {
    this.stopped = true;
    for (const live of this.workers.values()) {
      if (!live.record.cleanup_confirmed) await this.stop(live.record.worker_id);
    }
    const unconfirmed = [...this.workers.values()].some((w) => !w.record.cleanup_confirmed);
    this.cleanupConfirmedRun = !unconfirmed;
    return { cleanup_confirmed: this.cleanupConfirmedRun, teardown_unconfirmed: unconfirmed };
  }

  reconcileSpawn(attemptId: string, status: "started" | "not_started" | "stopped"): { ok: boolean } {
    const rec = this.reconciliations.find((r) => r.attempt_id === attemptId);
    if (!rec || rec.replayed) return { ok: false };
    rec.reconciliation_status = status;
    rec.replayed = false;
    if (rec.worker_id) {
      const live = this.workers.get(rec.worker_id);
      if (live) live.record.reconciliation_status = status;
    }
    return { ok: true };
  }

  recordChildRepair(workerId: string): { ok: boolean; reason?: string } {
    const live = this.workers.get(workerId);
    if (!live) return { ok: false, reason: "not_found" };
    if (live.recoverySpent >= live.record.limits.recovery_sub_allowance) {
      return { ok: false, reason: WORKER_REASON.WORKER_BUDGET_EXCEEDED };
    }
    live.recoverySpent += 1;
    this.accounting.recoveryCumulative += 1;
    this.parentLedger.cumulativeExpenditure += 0;
    return { ok: true };
  }

  releaseWorker(workerId: string): void {
    const live = this.workers.get(workerId);
    if (!live) return;
    this.releaseUnused(live);
  }

  parentCannotSpendReserved(): boolean {
    const before = this.accounting.parentSpent;
    const attempt = this.accounting.workerReserved;
    return attempt > 0 && this.parentUnreservedRemaining() < this.accounting.sharedStepPool;
  }

  evidenceFor(workerId: string): Map<string, { worker_id: string; classifier_ok: boolean }> {
    return this.workers.get(workerId)?.successfulCalls ?? new Map();
  }

  anyBlockingWorker(): boolean {
    for (const live of this.workers.values()) {
      if (!live.record.terminal || !live.record.cleanup_confirmed) return true;
    }
    return false;
  }

  async runSequentialBatch<T>(jobs: Array<() => Promise<T>>): Promise<T[]> {
    const out: T[] = [];
    for (const job of jobs) out.push(await job());
    return out;
  }

  private spawnRefusal(input: { task: string }): string | null {
    if (this.delegationActive || this.parentLedger && false) return WORKER_REASON.DELEGATION_IN_FLIGHT;
    if (this.delegationActive) return WORKER_REASON.DELEGATION_IN_FLIGHT;
    if (this.parentSlotOpen) return WORKER_REASON.PARENT_SLOT_OPEN;
    if (this.runWideUnknown || this.parentLedger.unresolvedUnknown) return WORKER_REASON.RUN_WIDE_UNKNOWN;
    if (this.unresolvedSpawn) return WORKER_REASON.SPAWN_UNRESOLVED;
    const active = [...this.workers.values()].filter((w) => !w.record.terminal).length;
    if (active >= this.frozen.maxConcurrentWorkers) return WORKER_REASON.CAP_REFUSAL;
    if (this.spawnAttempts >= this.frozen.maxSpawnAttempts) return WORKER_REASON.CAP_REFUSAL;
    if (!input.task) return WORKER_REASON.POLICY_REFUSAL;
    return null;
  }

  private spawnAttempts = 0;
  private accountingNoteAttempt(): void {
    this.spawnAttempts += 1;
  }

  private narrowTools(requested: string[] | undefined): { ok: true; tools: string[] } | { ok: false; reason: string } {
    const allow = new Set(this.frozen.allowlist);
    const names = requested ?? [...allow];
    for (const name of names) {
      if (!allow.has(name)) return { ok: false, reason: WORKER_REASON.POLICY_REFUSAL };
      const tool = this.registry.get(name);
      if (!tool) return { ok: false, reason: WORKER_REASON.TOOL_INELIGIBLE };
      if (tool.tier === "ask") return { ok: false, reason: WORKER_REASON.ASK_TIER };
      if (tool.tier === "deny") return { ok: false, reason: WORKER_REASON.DENY_TIER };
      if (!tool.readOnly || !tool.idempotent) return { ok: false, reason: WORKER_REASON.TOOL_INELIGIBLE };
      if (tool.kind === "other") return { ok: false, reason: WORKER_REASON.TOOL_INELIGIBLE };
      if (tool.concurrentSafe) return { ok: false, reason: WORKER_REASON.POLICY_REFUSAL };
    }
    return { ok: true, tools: names };
  }

  private fence(live: LiveWorker): void {
    live.record.generation += 1;
    live.decoded = null;
  }

  private async infer(
    role: "parent" | "worker",
    workerId: string,
    generation: number,
    prompt: string,
  ): Promise<{ ok: boolean; text?: string; response?: InferenceResponse; reason?: string; discarded?: boolean }> {
    let lease;
    try {
      lease = await this.permit.acquire();
    } catch {
      return { ok: false, reason: "cancelled" };
    }
    const live = this.workers.get(workerId);
    if (role === "worker" && live && (live.record.generation !== generation || live.abort.signal.aborted || this.stopped)) {
      this.permit.release(lease);
      return { ok: false, reason: "cancelled", discarded: true };
    }
    if (this.clock.now() > this.operationalDeadlineMs && role === "worker") {
      this.permit.release(lease);
      return { ok: false, reason: "deadline" };
    }
    const admission = this.usage.admit();
    if (!admission.ok) {
      this.permit.release(lease);
      if (live) live.record.usage_unknown = true;
      this.usage.settle(false);
      return { ok: false, reason: WORKER_REASON.USAGE_UNKNOWN };
    }
    this.adapterCalls += 1;
    let response: InferenceResponse;
    try {
      const signal = live?.abort.signal ?? new AbortController().signal;
      response = await this.adapter.complete({ workerId, generation, prompt, role }, signal);
    } catch {
      this.permit.release(lease);
      return { ok: false, reason: "provider_error" };
    }
    this.permit.release(lease);
    if (role === "worker" && live && live.record.generation !== generation) {
      live.record.usage_unknown = response.usageKnown === false || true;
      this.usage.settle(false);
      live.nonCooperativePending = true;
      return { ok: false, discarded: true, reason: "fenced" };
    }
    if (response.status === 429) {
      return { ok: false, response, reason: "provider_error" };
    }
    if (response.usageKnown === false) {
      if (live) live.record.usage_unknown = true;
      this.usage.settle(false);
    } else {
      this.usage.settle(true);
    }
    return { ok: true, text: response.text, response };
  }

  private async runChild(live: LiveWorker): Promise<void> {
    const genAtSchedule = live.record.generation;
    try {
      while (!live.record.terminal && live.record.child_step_index < live.record.limits.max_steps) {
        if (live.abort.signal.aborted || this.stopped) break;
        if (this.parentSlotOpen || this.runWideUnknown) {
          live.record.state = "paused";
          await this.clock.wait(0);
          if (this.parentSlotOpen || this.runWideUnknown) {
            await this.clock.wait(1);
            if (this.parentSlotOpen || this.runWideUnknown) break;
          }
        }
        if (live.record.generation !== genAtSchedule && live.decoded) {
          live.decoded = null;
        }
        const generation = live.record.generation;
        if (!live.decoded) {
          const inferred = await this.infer("worker", live.record.worker_id, generation, live.record.task);
          if (inferred.discarded || inferred.reason === "cancelled") break;
          if (inferred.reason === "deadline") {
            live.record.state = "deadline";
            live.record.terminal = true;
            break;
          }
          if (!inferred.ok || !inferred.response) {
            live.record.state = "failed";
            live.record.terminal = true;
            break;
          }
          if (live.record.generation !== generation) {
            live.record.usage_unknown = true;
            this.usage.settle(false);
            continue;
          }
          if (inferred.response.final || !inferred.response.toolName) {
            live.items.push({ index: live.items.length, text: inferred.response.text ?? "", citations: [] });
            live.record.state = "completed";
            live.record.terminal = true;
            break;
          }
          live.decoded = { toolName: inferred.response.toolName, toolArgs: inferred.response.toolArgs ?? {} };
        }
        if (this.parentSlotOpen || this.runWideUnknown || live.abort.signal.aborted) {
          live.record.state = "paused";
          break;
        }
        if (live.record.generation !== generation) {
          live.decoded = null;
          continue;
        }
        const action = live.decoded;
        live.decoded = null;
        if (!live.record.allowed_tools.includes(action.toolName)) {
          live.record.state = "failed";
          live.record.terminal = true;
          break;
        }
        if (live.reservedSteps <= 0) {
          live.record.state = "step_limit";
          live.record.terminal = true;
          break;
        }
        live.reservedSteps -= 1;
        this.accounting.workerSpent += 1;
        live.record.child_step_index += 1;
        const callId = `${live.record.worker_id}_call_${live.record.child_step_index}`;
        const tool = this.registry.get(action.toolName);
        live.startedTools.set(callId, { cleanupConfirmed: false, settled: false, outcome: "unknown" });
        live.record.unresolved_operations.push(callId);
        if (!tool) {
          this.settleTool(live, callId, "error", true, false);
          live.record.state = "failed";
          live.record.terminal = true;
          break;
        }
        let result;
        try {
          result = await tool.execute(action.toolArgs, { signal: live.abort.signal, workerId: live.record.worker_id });
        } catch {
          this.settleTool(live, callId, "unknown", false, false);
          live.record.outcome_unknown = true;
          this.runWideUnknown = true;
          live.record.state = "failed";
          live.record.terminal = true;
          break;
        }
        if (live.record.generation !== generation) {
          continue;
        }
        const outcome = result.outcome ?? (result.ok ? "ok" : "error");
        const confirmed = result.cleanupConfirmed !== false && outcome !== "unknown";
        this.settleTool(live, callId, outcome, confirmed, result.ok);
        const citation: CitationDescriptor = { child_call_id: result.callId ?? callId, tool_name: action.toolName };
        live.items.push({
          index: live.items.length,
          text: typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? ""),
          citations: outcome === "ok" ? [citation] : [],
        });
        if (outcome === "ok") {
          live.successfulCalls.set(citation.child_call_id, { worker_id: live.record.worker_id, classifier_ok: true });
        }
        if (outcome === "unknown") {
          live.record.outcome_unknown = true;
          this.runWideUnknown = true;
          live.record.state = "failed";
          live.record.terminal = true;
          break;
        }
        if (!result.ok) {
          live.record.state = "failed";
          live.record.terminal = true;
          if (live.recoverySpent < live.record.limits.recovery_sub_allowance) {
            this.recordChildRepair(live.record.worker_id);
          }
          break;
        }
      }
      if (!live.record.terminal && live.record.child_step_index >= live.record.limits.max_steps) {
        live.record.state = "step_limit";
        live.record.terminal = true;
      }
      if (live.abort.signal.aborted && !live.record.terminal) {
        live.record.state = "cancelled";
        live.record.terminal = true;
      }
    } finally {
      if (!live.report) this.finishReport(live, live.record.state);
      const pending = [...live.startedTools.values()].some((t) => !t.cleanupConfirmed);
      if (!pending && !live.record.outcome_unknown) {
        live.record.cleanup_confirmed = true;
        this.releaseUnused(live);
      }
    }
  }

  private settleTool(
    live: LiveWorker,
    callId: string,
    outcome: string,
    cleanupConfirmed: boolean,
    classifierOk: boolean,
  ): void {
    const existing = live.startedTools.get(callId);
    if (existing?.settled) return;
    live.startedTools.set(callId, { cleanupConfirmed, settled: true, outcome });
    if (cleanupConfirmed) {
      live.record.unresolved_operations = live.record.unresolved_operations.filter((id) => id !== callId);
    }
    if (classifierOk) {
      live.successfulCalls.set(callId, { worker_id: live.record.worker_id, classifier_ok: true });
    }
  }

  private finishReport(live: LiveWorker, _state: string): void {
    live.report = freezeReport(live.items.length > 0 ? live.items : [{ index: 0, text: live.record.task, citations: [] }]);
    live.record.report_frozen = true;
    live.record.terminal = true;
  }

  private releaseUnused(live: LiveWorker): void {
    if (live.reservedSteps > 0) {
      this.accounting.workerReleased += live.reservedSteps;
      this.accounting.workerReserved = Math.max(0, this.accounting.workerReserved - live.reservedSteps);
      live.reservedSteps = 0;
    }
    const unusedRecovery = live.recoveryReserved - live.recoverySpent;
    if (unusedRecovery > 0) {
      this.accounting.recoveryReleased += unusedRecovery;
      this.accounting.recoveryReserved = Math.max(0, this.accounting.recoveryReserved - unusedRecovery);
      live.recoveryReserved = live.recoverySpent;
    }
  }

  private publicRecord(live: LiveWorker): Record<string, unknown> {
    return {
      worker_id: live.record.worker_id,
      state: live.record.state,
      reconciliation_status: live.record.reconciliation_status,
      cleanup_confirmed: live.record.cleanup_confirmed,
      child_step_index: live.record.child_step_index,
    };
  }

  private bound(output: Record<string, unknown>): Record<string, unknown> {
    const encoded = JSON.stringify(output);
    if (utf8ByteLength(encoded) <= POLL_OUTPUT_MAX_BYTES) return output;
    return { ok: true, truncated: true, reason: "output_cap", preview_bytes: POLL_OUTPUT_MAX_BYTES };
  }
}

export function createWorkerRuntime(deps: CreateRuntimeDeps): CreateResult {
  const frozenResult = freezeWorkerConfig(deps.config);
  if (!frozenResult.ok) return frozenResult;
  const reserve = claimSharedTeardownReserve({
    deadlineMs: deps.runDeadlineMs ?? 60_000,
    requestedMs: frozenResult.frozen.teardownReserveMs,
    jobsMounted: deps.config.jobsMounted,
    jobsReserveCompatible: deps.config.jobsReserveCompatible,
    compositionMounted: deps.config.compositionMounted,
    bucket: deps.reserveBucket,
  });
  if (!reserve.ok) return { ok: false, reason: reserve.reason };
  const clock = deps.clock ?? new DefaultClock();
  const adapter = deps.adapter ?? {
    async complete(req): Promise<InferenceResponse> {
      return { text: req.prompt, final: true, usageKnown: true };
    },
  };
  const registry = deps.registry ?? { get: () => undefined, list: () => [] };
  const usage = deps.usage ?? new DefaultUsage();
  const parentLedger = deps.parentLedger ?? {
    openSlot: false,
    unresolvedUnknown: false,
    recoveryDebits: 0,
    cumulativeExpenditure: 0,
  };
  const childFactory: ChildLoopFactory =
    deps.childFactory ??
    (() => {
      return { started: true };
    });
  const baselineSchemaCount = workerToolSchemas(false).length;
  const runtime = new WorkerRuntime(
    frozenResult.frozen,
    clock,
    adapter,
    registry,
    usage,
    parentLedger,
    childFactory,
    reserve.bucket,
    operationalDeadline(deps.runDeadlineMs ?? 60_000, reserve.bucket),
    baselineSchemaCount,
  );
  if (deps.config.delegationActive) runtime.setDelegationActive(true);
  return { ok: true, runtime };
}

export function productionChildFactory(): ChildLoopFactory {
  return () => ({ started: true });
}
