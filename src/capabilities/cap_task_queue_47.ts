/**
 * cap_task_queue_47 — repository-backed, opt-in, principal-bound TaskQueue.
 *
 * Queue tasks are flat planning records inside one AgentRuntime run. They are
 * not child runs, execution authority, evidence, or independently verified
 * achievements. Only the runtime may activate FIFO tasks, swap a segment, or
 * retire a known-failure slot. Those paths share RecoveryLedger, ObservationStore,
 * EvidenceValidator, delegation eligibility, step/deadline admission, and the
 * existing fenced journal when durable mode is explicitly selected.
 *
 * Memory-only is the delivered mode. Durable mode is rejected at startup unless
 * a mounted durable-run service exports the required journal boundary. Missing
 * configuration never falls back silently.
 */

export const TASK_QUEUE_CAPABILITY_ID = "cap_task_queue_47" as const;

export const TASK_QUEUE_TOOL_NAMES = [
  "list_tasks",
  "update_task",
  "enqueue_task",
  "complete_task",
] as const;

export type TaskQueueToolName = (typeof TASK_QUEUE_TOOL_NAMES)[number];

export const TASK_QUEUE_STATES = [
  "pending",
  "active",
  "done",
  "failed",
  "blocked",
  "abandoned",
] as const;

export type TaskQueueState = (typeof TASK_QUEUE_STATES)[number];

export const TERMINAL_TASK_STATES: ReadonlySet<TaskQueueState> = new Set([
  "done",
  "failed",
  "abandoned",
]);

export const MAX_TASKS_HARD_CAP = 32;
export const MAX_CONTINUATIONS_HARD_CAP = 8;
export const MAX_DEPENDENCIES = 4;
export const TITLE_MAX = 120;
export const GOAL_MAX = 1000;
export const NOTE_MAX = 300;
export const REASON_MAX = 240;
export const DIGEST_MAX = 800;

export type QueueMode = "memory" | "durable";

export interface QueuePolicy {
  maxTasks: number;
  maxContinuations: number;
  perTaskStepCap: number;
  maxTotalSteps: number;
  maxRecoveryDispatches: number;
  wallClockDeadlineMs: number;
  mode: QueueMode;
}

export interface QueuePolicyInput {
  maxTasks?: number;
  maxContinuations?: number;
  perTaskStepCap?: number;
  maxTotalSteps?: number;
  maxRecoveryDispatches?: number;
  wallClockDeadlineMs?: number;
  mode?: QueueMode;
}

export interface DurableRunService {
  journalAppend(entry: QueueJournalEntry): Promise<{ fence: number } | { error: string }>;
  journalRead(): Promise<QueueJournalEntry[]>;
  checkpointWrite(snapshot: QueueSnapshot): Promise<{ ok: true } | { error: string }>;
  checkpointRead(): Promise<QueueSnapshot | null>;
}

export interface QueueJournalEntry {
  fence: number;
  kind: "enqueue" | "activate" | "complete" | "fail" | "abandon" | "block" | "note" | "retire_slot" | "finalize";
  taskId?: string;
  at: number;
  payload: Record<string, unknown>;
}

export interface TaskRecord {
  taskId: string;
  sequence: number;
  title: string;
  goal: string;
  dependsOn: string[];
  state: TaskQueueState;
  notes: string[];
  reasons: string[];
  createdAt: number;
  updatedAt: number;
  stepsUsed: number;
  recoveryDispatchesUsed: number;
  completionCitations: string[];
  explicitNone: boolean;
  unknownOutcome: boolean;
  failureKind?: "step_cap" | "recovery_exhausted" | "blocked_dep" | "other";
}

export interface QueueSnapshot {
  policy: QueuePolicy;
  tasks: TaskRecord[];
  activeTaskId: string | null;
  continuationsUsed: number;
  recoveryDispatchesUsed: number;
  nextSequence: number;
  nextTaskOrdinal: number;
  finalized: boolean;
  fence: number;
  unresolvedTransition: QueueJournalEntry | null;
}

export interface CitationHandler {
  id: string;
  available: boolean;
  validate(citation: string): { ok: true } | { ok: false; reason: string };
}

export interface EvidenceValidatorLike {
  validateCitations(
    citations: string[],
    handlers: readonly CitationHandler[],
  ): { ok: true } | { ok: false; reason: string; unavailable?: boolean };
}

export interface RecoveryLedgerLike {
  hasOpenSlot(): boolean;
  openSlot(reason: string): { ok: true } | { ok: false; reason: string };
  /** Retire a known-failure slot without claiming success. Does not restore allowance. */
  retireKnownFailure(taskId: string): { ok: true; restored: false } | { ok: false; reason: string };
  slotTaskId(): string | null;
  isUnknownOutcome(): boolean;
  markUnknownOutcome(taskId: string): void;
}

export class LocalRecoveryLedger implements RecoveryLedgerLike {
  private open = false;
  private owner: string | null = null;
  private unknown = false;

  hasOpenSlot(): boolean {
    return this.open;
  }
  openSlot(reason: string): { ok: true } | { ok: false; reason: string } {
    if (this.open) return { ok: false, reason: "slot_already_open" };
    if (!reason.trim()) return { ok: false, reason: "reason_required" };
    this.open = true;
    this.owner = reason.slice(0, REASON_MAX);
    return { ok: true };
  }
  retireKnownFailure(taskId: string): { ok: true; restored: false } | { ok: false; reason: string } {
    if (!this.open) return { ok: false, reason: "no_open_slot" };
    if (this.unknown) return { ok: false, reason: "unknown_outcome_blocked" };
    if (this.owner && !this.owner.includes(taskId) && this.owner !== taskId) {
      /* owner may be a reason string that embeds the task id, or the task id itself */
    }
    this.open = false;
    this.owner = null;
    return { ok: true, restored: false };
  }
  slotTaskId(): string | null {
    return this.open ? this.owner : null;
  }
  isUnknownOutcome(): boolean {
    return this.unknown;
  }
  markUnknownOutcome(taskId: string): void {
    this.unknown = true;
    this.open = true;
    this.owner = taskId;
  }
}

/** Default evidence check: handlers must be mounted and available; explicit shapes only. */
export class ConsolidatedEvidenceValidator implements EvidenceValidatorLike {
  validateCitations(
    citations: string[],
    handlers: readonly CitationHandler[],
  ): { ok: true } | { ok: false; reason: string; unavailable?: boolean } {
    if (citations.length === 0) {
      return { ok: false, reason: "citations_required" };
    }
    if (handlers.length === 0) {
      return { ok: false, reason: "citation_handlers_unavailable", unavailable: true };
    }
    for (const citation of citations) {
      if (typeof citation !== "string" || citation.trim().length === 0 || citation.length > 400) {
        return { ok: false, reason: "invalid_citation" };
      }
      const available = handlers.filter((h) => h.available);
      if (available.length === 0) {
        return { ok: false, reason: "citation_handlers_unavailable", unavailable: true };
      }
      const matched = available.some((h) => h.validate(citation).ok);
      if (!matched) {
        const unavailableOnly = handlers.every((h) => !h.available);
        if (unavailableOnly) {
          return { ok: false, reason: "citation_handlers_unavailable", unavailable: true };
        }
        return { ok: false, reason: "citation_rejected" };
      }
    }
    return { ok: true };
  }
}

export interface TaskQueueToolResult {
  ok: boolean;
  started: boolean;
  error?: string;
  code?: "invalid_args" | "policy" | "state" | "budget" | "unavailable" | "refused";
  tasks?: TaskView[];
  task?: TaskView;
  activeTaskId?: string | null;
}

export interface TaskView {
  task_id: string;
  state: TaskQueueState;
  title: string;
  goal: string;
  depends_on: string[];
  notes: string[];
  reasons: string[];
  sequence: number;
  steps_used: number;
  unknown_outcome: boolean;
  explicit_none: boolean;
}

export interface SegmentView {
  hostTask: string;
  currentGoal: string | null;
  activeTaskId: string | null;
  progressDigest: string;
  protectedState: {
    unresolved: boolean;
    recoveryOpen: boolean;
    unknownOutcome: boolean;
    continuationsUsed: number;
    recoveryDispatchesUsed: number;
    stepsUsed: number;
  };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const n = Math.floor(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export function freezeQueuePolicy(
  input: QueuePolicyInput | undefined,
  runCaps: { maxTotalSteps: number; wallClockDeadlineMs: number; maxRecoveryDispatches: number },
): QueuePolicy | null {
  if (!input) return null;
  const maxTasks = clampInt(input.maxTasks ?? 8, 1, MAX_TASKS_HARD_CAP);
  const maxContinuations = clampInt(input.maxContinuations ?? 4, 1, MAX_CONTINUATIONS_HARD_CAP);
  const perTaskStepCap = clampInt(input.perTaskStepCap ?? Math.min(8, runCaps.maxTotalSteps), 1, runCaps.maxTotalSteps);
  const maxTotalSteps = clampInt(
    input.maxTotalSteps ?? runCaps.maxTotalSteps,
    1,
    runCaps.maxTotalSteps,
  );
  const maxRecoveryDispatches = clampInt(
    input.maxRecoveryDispatches ?? runCaps.maxRecoveryDispatches,
    0,
    runCaps.maxRecoveryDispatches,
  );
  const wallClockDeadlineMs = clampInt(
    input.wallClockDeadlineMs ?? runCaps.wallClockDeadlineMs,
    1,
    runCaps.wallClockDeadlineMs,
  );
  const mode: QueueMode = input.mode === "durable" ? "durable" : "memory";
  return Object.freeze({
    maxTasks,
    maxContinuations,
    perTaskStepCap,
    maxTotalSteps,
    maxRecoveryDispatches,
    wallClockDeadlineMs,
    mode,
  });
}

export function assertDurableService(service: DurableRunService | null | undefined): DurableRunService {
  if (!service) {
    throw new QueueStartupError("durable_mode_rejected: durable-run service is not mounted");
  }
  const required = ["journalAppend", "journalRead", "checkpointWrite", "checkpointRead"] as const;
  for (const name of required) {
    if (typeof service[name] !== "function") {
      throw new QueueStartupError(`durable_mode_rejected: missing export ${name}`);
    }
  }
  return service;
}

export class QueueStartupError extends Error {
  readonly code = "durable_mode_rejected" as const;
  constructor(message: string) {
    super(message);
    this.name = "QueueStartupError";
  }
}

function viewOf(task: TaskRecord): TaskView {
  return {
    task_id: task.taskId,
    state: task.state,
    title: task.title,
    goal: task.goal,
    depends_on: [...task.dependsOn],
    notes: [...task.notes],
    reasons: [...task.reasons],
    sequence: task.sequence,
    steps_used: task.stepsUsed,
    unknown_outcome: task.unknownOutcome,
    explicit_none: task.explicitNone,
  };
}

export class TaskQueue {
  private tasks: TaskRecord[] = [];
  private activeTaskId: string | null = null;
  private continuationsUsed = 0;
  private recoveryDispatchesUsed = 0;
  private nextSequence = 1;
  private nextTaskOrdinal = 1;
  private finalized = false;
  private fence = 0;
  private unresolvedTransition: QueueJournalEntry | null = null;
  private readonly failedGoals = new Set<string>();
  private readonly policy: QueuePolicy;
  private readonly ledger: RecoveryLedgerLike;
  private readonly evidence: EvidenceValidatorLike;
  private readonly handlers: CitationHandler[];
  private readonly durable: DurableRunService | null;
  private readonly startedAt: number;
  private trace: string[] = [];

  private constructor(opts: {
    policy: QueuePolicy;
    ledger: RecoveryLedgerLike;
    evidence: EvidenceValidatorLike;
    handlers: CitationHandler[];
    durable: DurableRunService | null;
    now?: number;
  }) {
    this.policy = opts.policy;
    this.ledger = opts.ledger;
    this.evidence = opts.evidence;
    this.handlers = opts.handlers;
    this.durable = opts.durable;
    this.startedAt = opts.now ?? Date.now();
  }

  static create(opts: {
    policy: QueuePolicy;
    ledger?: RecoveryLedgerLike;
    evidence?: EvidenceValidatorLike;
    handlers?: CitationHandler[];
    durableService?: DurableRunService | null;
    now?: number;
  }): TaskQueue {
    if (opts.policy.mode === "durable") {
      const service = assertDurableService(opts.durableService ?? null);
      return new TaskQueue({
        policy: opts.policy,
        ledger: opts.ledger ?? new LocalRecoveryLedger(),
        evidence: opts.evidence ?? new ConsolidatedEvidenceValidator(),
        handlers: opts.handlers ?? [],
        durable: service,
        now: opts.now,
      });
    }
    return new TaskQueue({
      policy: opts.policy,
      ledger: opts.ledger ?? new LocalRecoveryLedger(),
      evidence: opts.evidence ?? new ConsolidatedEvidenceValidator(),
      handlers: opts.handlers ?? [],
      durable: null,
      now: opts.now,
    });
  }

  /** Absent configuration: schemas exist but the runtime writes nothing. */
  static absent(): null {
    return null;
  }

  getPolicy(): QueuePolicy {
    return this.policy;
  }

  getTrace(): readonly string[] {
    return this.trace;
  }

  isFinalized(): boolean {
    return this.finalized;
  }

  recoveryBudgetRemaining(): number {
    return Math.max(0, this.policy.maxRecoveryDispatches - this.recoveryDispatchesUsed);
  }

  hasUnknownOutcome(): boolean {
    return this.ledger.isUnknownOutcome() || this.tasks.some((t) => t.unknownOutcome);
  }

  /**
   * Resume restores committed snapshot. Does not replay tool actions.
   * An interrupted journal transition stays unresolved; current task row is not proof.
   */
  async resumeFromDurable(now = Date.now()): Promise<{ restored: true; replayed: false }> {
    if (!this.durable) {
      throw new QueueStartupError("durable_mode_rejected: no durable service");
    }
    const snapshot = await this.durable.checkpointRead();
    const journal = await this.durable.journalRead();
    if (snapshot) {
      this.tasks = snapshot.tasks.map((t) => ({ ...t, dependsOn: [...t.dependsOn], notes: [...t.notes], reasons: [...t.reasons], completionCitations: [...t.completionCitations] }));
      this.activeTaskId = snapshot.activeTaskId;
      this.continuationsUsed = snapshot.continuationsUsed;
      this.recoveryDispatchesUsed = snapshot.recoveryDispatchesUsed;
      this.nextSequence = snapshot.nextSequence;
      this.nextTaskOrdinal = snapshot.nextTaskOrdinal;
      this.finalized = snapshot.finalized;
      this.fence = snapshot.fence;
      this.unresolvedTransition = snapshot.unresolvedTransition;
      for (const t of this.tasks) {
        if (t.state === "failed") this.failedGoals.add(normalizeGoal(t.goal));
      }
    }
    const last = journal.length > 0 ? journal[journal.length - 1] : null;
    if (last && snapshot && last.fence > snapshot.fence) {
      this.unresolvedTransition = last;
      this.trace.push("resume:interrupted_transition_unresolved");
    } else {
      this.trace.push("resume:committed_state_no_replay");
    }
    void now;
    return { restored: true, replayed: false };
  }

  listTasks(maxTasks?: number): TaskQueueToolResult {
    const limit = clampInt(maxTasks ?? this.policy.maxTasks, 1, MAX_TASKS_HARD_CAP);
    const tasks = [...this.tasks].sort((a, b) => a.sequence - b.sequence).slice(0, limit).map(viewOf);
    this.trace.push("list_tasks");
    return { ok: true, started: false, tasks, activeTaskId: this.activeTaskId };
  }

  enqueueTask(args: { title?: unknown; goal?: unknown; depends_on?: unknown }): TaskQueueToolResult {
    if (this.finalized) return refuse("run_finalized");
    if (this.pastDeadline()) return budget("deadline_exceeded");
    const title = typeof args.title === "string" ? args.title.trim() : "";
    const goal = typeof args.goal === "string" ? args.goal.trim() : "";
    if (!title || title.length > TITLE_MAX) return invalid("title");
    if (!goal || goal.length > GOAL_MAX) return invalid("goal");
    const deps = normalizeDeps(args.depends_on);
    if (!deps.ok) return invalid(deps.reason);
    if (this.tasks.length >= this.policy.maxTasks) return budget("max_tasks");
    const known = new Map(this.tasks.map((t) => [t.taskId, t]));
    for (const id of deps.ids) {
      if (!known.has(id)) return invalid("missing_dependency");
    }
    if (wouldCycle(this.tasks, deps.ids)) return invalid("cycle");
    if (this.failedGoals.has(normalizeGoal(goal))) return invalid("reenqueue_failed_goal");
    const task = this.makeTask(title, goal, deps.ids);
    this.tasks.push(task);
    this.trace.push(`enqueue:${task.taskId}`);
    void this.persist("enqueue", task.taskId, { title, goal, depends_on: deps.ids });
    return { ok: true, started: true, task: viewOf(task), activeTaskId: this.activeTaskId };
  }

  updateTask(args: { task_id?: unknown; note?: unknown; abandon?: unknown; reason?: unknown }): TaskQueueToolResult {
    if (this.finalized) return refuse("run_finalized");
    const id = typeof args.task_id === "string" ? args.task_id : "";
    const task = this.tasks.find((t) => t.taskId === id);
    if (!task) return invalid("unknown_task");
    const abandon = args.abandon === true;
    const note = args.note === undefined ? undefined : typeof args.note === "string" ? args.note : null;
    if (note === null) return invalid("note");
    if (note !== undefined && note.length > NOTE_MAX) return invalid("note_length");
    if (!abandon && (note === undefined || note.length === 0)) return invalid("empty_update");
    if (TERMINAL_TASK_STATES.has(task.state) && (abandon || note !== undefined)) {
      return refuse("terminal_task");
    }
    if (abandon) {
      const reason = typeof args.reason === "string" ? args.reason.trim() : typeof note === "string" ? note.trim() : "";
      if (!reason) return invalid("abandon_reason_required");
      if (reason.length > REASON_MAX) return invalid("reason_length");
      if (TERMINAL_TASK_STATES.has(task.state)) return refuse("terminal_task");
      task.state = "abandoned";
      task.reasons.push(`abandoned:${reason}`.slice(0, REASON_MAX));
      task.updatedAt = Date.now();
      if (note && note.length > 0 && task.notes.length < 8) task.notes.push(note);
      this.trace.push(`abandon:${task.taskId}`);
      if (this.activeTaskId === task.taskId) {
        this.activeTaskId = null;
        /* Abandoning the active task while a slot is open cannot authorize another segment. */
        this.trace.push("abandon_active:no_segment_authorization");
      }
      this.blockDescendants(task.taskId, `dependency_abandoned:${task.taskId}`);
      void this.persist("abandon", task.taskId, { reason });
      return { ok: true, started: true, task: viewOf(task), activeTaskId: this.activeTaskId };
    }
    if (task.notes.length >= 8) return budget("note_cap");
    task.notes.push(note as string);
    task.updatedAt = Date.now();
    this.trace.push(`note:${task.taskId}`);
    void this.persist("note", task.taskId, { note });
    return { ok: true, started: true, task: viewOf(task), activeTaskId: this.activeTaskId };
  }

  completeTask(args: { task_id?: unknown; citations?: unknown; explicit_none?: unknown }): TaskQueueToolResult {
    if (this.finalized) return refuse("run_finalized");
    if (this.unresolvedTransition) return refuse("unresolved_transition");
    const id = typeof args.task_id === "string" ? args.task_id : "";
    const task = this.tasks.find((t) => t.taskId === id);
    if (!task) return { ok: false, started: false, error: "unknown_task", code: "invalid_args" };
    if (TERMINAL_TASK_STATES.has(task.state)) {
      return { ok: false, started: false, error: "terminal_task", code: "refused" };
    }
    if (this.activeTaskId !== task.taskId || task.state !== "active") {
      return { ok: false, started: false, error: "not_active_task", code: "state" };
    }
    if (this.ledger.hasOpenSlot() || this.ledger.isUnknownOutcome() || task.unknownOutcome) {
      return { ok: false, started: false, error: "open_recovery_or_unresolved", code: "state" };
    }
    const explicitNone = args.explicit_none === true;
    const citations = Array.isArray(args.citations) ? args.citations.filter((c): c is string => typeof c === "string") : [];
    if (explicitNone && citations.length > 0) return invalid("explicit_none_with_citations");
    if (!explicitNone) {
      const check = this.evidence.validateCitations(citations, this.handlers);
      if (!check.ok) {
        return {
          ok: false,
          started: false,
          error: check.reason,
          code: check.unavailable ? "unavailable" : "invalid_args",
        };
      }
    }
    task.state = "done";
    task.explicitNone = explicitNone;
    task.completionCitations = explicitNone ? [] : [...citations];
    task.reasons.push(explicitNone ? "completed:explicit_none" : "completed:citations");
    task.updatedAt = Date.now();
    this.activeTaskId = null;
    this.trace.push(`complete:${task.taskId}`);
    void this.persist("complete", task.taskId, { explicit_none: explicitNone, citations });
    return { ok: true, started: true, task: viewOf(task), activeTaskId: null };
  }

  /**
   * Runtime-only: activate the oldest pending task whose dependencies are all done.
   * Does not run while an unknown-outcome slot is open.
   * Abandonment does not authorize this; the runtime calls it on its own schedule.
   */
  activateNext(opts?: { authorizedByAbandon?: boolean }): TaskQueueToolResult {
    if (opts?.authorizedByAbandon) {
      return refuse("abandon_cannot_authorize_segment");
    }
    if (this.finalized) return refuse("run_finalized");
    if (this.ledger.isUnknownOutcome() || this.hasUnknownOutcome()) {
      return refuse("unknown_outcome_open");
    }
    if (this.ledger.hasOpenSlot()) {
      return refuse("recovery_slot_open");
    }
    if (this.activeTaskId) return refuse("segment_already_active");
    if (this.continuationsUsed >= this.policy.maxContinuations) return budget("continuation_cap");
    if (this.pastDeadline()) return budget("deadline_exceeded");
    const ready = this.tasks
      .filter((t) => t.state === "pending" && this.depsDone(t))
      .sort((a, b) => a.sequence - b.sequence);
    const next = ready[0];
    if (!next) return { ok: false, started: false, error: "no_ready_task", code: "state" };
    next.state = "active";
    next.updatedAt = Date.now();
    next.reasons.push("activated:fifo");
    this.activeTaskId = next.taskId;
    this.continuationsUsed += 1;
    this.trace.push(`activate:${next.taskId}`);
    void this.persist("activate", next.taskId, { sequence: next.sequence });
    return { ok: true, started: true, task: viewOf(next), activeTaskId: next.taskId };
  }

  /** Count a step against the active task and the shared run cap. */
  admitStep(): { ok: true } | { ok: false; reason: string } {
    if (this.finalized) return { ok: false, reason: "run_finalized" };
    if (this.pastDeadline()) return { ok: false, reason: "deadline_exceeded" };
    const used = this.tasks.reduce((n, t) => n + t.stepsUsed, 0);
    if (used >= this.policy.maxTotalSteps) return { ok: false, reason: "max_total_steps" };
    const active = this.active();
    if (active) {
      if (active.stepsUsed >= this.policy.perTaskStepCap) {
        this.failForCap(active, "step_cap");
        return { ok: false, reason: "per_task_step_cap" };
      }
      active.stepsUsed += 1;
      active.updatedAt = Date.now();
    }
    return { ok: true };
  }

  /**
   * After the runtime records a task failed because its step cap or recovery
   * allowance is exhausted, retire that task's known-failure slot without
   * claiming success and without restoring allowance.
   */
  retireKnownFailureSlot(taskId: string): TaskQueueToolResult {
    const task = this.tasks.find((t) => t.taskId === taskId);
    if (!task) return invalid("unknown_task");
    if (task.unknownOutcome || this.ledger.isUnknownOutcome()) return refuse("unknown_outcome_blocked");
    if (task.state !== "failed") return refuse("not_known_failure");
    if (task.failureKind !== "step_cap" && task.failureKind !== "recovery_exhausted") {
      return refuse("exception_not_applicable");
    }
    if (this.recoveryDispatchesUsed >= this.policy.maxRecoveryDispatches) {
      return budget("recovery_dispatches_exhausted");
    }
    const retired = this.ledger.retireKnownFailure(taskId);
    if (!retired.ok) return refuse(retired.reason);
    if (retired.restored !== false) return refuse("allowance_must_not_restore");
    this.recoveryDispatchesUsed += 1;
    task.recoveryDispatchesUsed += 1;
    task.reasons.push("retired_known_failure_slot:no_success:no_restore");
    this.failedGoals.add(normalizeGoal(task.goal));
    this.trace.push(`retire_slot:${taskId}:recovery=${this.recoveryDispatchesUsed}`);
    void this.persist("retire_slot", taskId, { recoveryDispatchesUsed: this.recoveryDispatchesUsed });
    return { ok: true, started: true, task: viewOf(task), activeTaskId: this.activeTaskId };
  }

  recordUnknownOutcome(taskId: string): void {
    const task = this.tasks.find((t) => t.taskId === taskId);
    this.ledger.markUnknownOutcome(taskId);
    if (task) {
      task.unknownOutcome = true;
      task.state = "blocked";
      task.reasons.push("unknown_outcome");
      task.updatedAt = Date.now();
    }
    this.trace.push(`unknown_outcome:${taskId}`);
  }

  /** Open the single recovery slot for the active task. Consumes no restored credit. */
  openRecovery(reason: string): { ok: boolean; error?: string } {
    if (this.recoveryDispatchesUsed >= this.policy.maxRecoveryDispatches && this.ledger.hasOpenSlot()) {
      return { ok: false, error: "recovery_dispatches_exhausted" };
    }
    const opened = this.ledger.openSlot(reason);
    if (!opened.ok) return { ok: false, error: opened.reason };
    return { ok: true };
  }

  /**
   * A normal final_answer ends the whole run. Pending and active tasks are
   * abandoned with reason run_finalized. Failed/blocked reasons are preserved.
   */
  onFinalAnswer(): void {
    if (this.finalized) return;
    for (const task of this.tasks) {
      if (task.state === "pending" || task.state === "active") {
        task.state = "abandoned";
        task.reasons.push("run_finalized");
        task.updatedAt = Date.now();
      }
    }
    this.activeTaskId = null;
    this.finalized = true;
    this.trace.push("final_answer:run_finalized");
    void this.persist("finalize", undefined, { reason: "run_finalized" });
  }

  /** Drainage or continuation-cap exhaustion: bounded finalization, not another segment. */
  finalizeDrainage(reason: string): void {
    if (this.finalized) return;
    for (const task of this.tasks) {
      if (task.state === "pending" || task.state === "active") {
        task.state = "abandoned";
        task.reasons.push(`noncompletion:${reason}`.slice(0, REASON_MAX));
      }
    }
    this.activeTaskId = null;
    this.finalized = true;
    this.trace.push(`drainage:${reason}`);
  }

  segmentView(hostTask: string): SegmentView {
    const active = this.active();
    const digest = this.tasks
      .map((t) => `${t.taskId}:${t.state}`)
      .join(";")
      .slice(0, DIGEST_MAX);
    return {
      hostTask,
      currentGoal: active ? active.goal : null,
      activeTaskId: this.activeTaskId,
      progressDigest: digest,
      protectedState: {
        unresolved: this.unresolvedTransition !== null || this.hasUnknownOutcome(),
        recoveryOpen: this.ledger.hasOpenSlot(),
        unknownOutcome: this.hasUnknownOutcome(),
        continuationsUsed: this.continuationsUsed,
        recoveryDispatchesUsed: this.recoveryDispatchesUsed,
        stepsUsed: this.tasks.reduce((n, t) => n + t.stepsUsed, 0),
      },
    };
  }

  statusSection(): string {
    const lines = this.tasks
      .slice()
      .sort((a, b) => a.sequence - b.sequence)
      .map((t) => {
        const why = t.state === "done" ? "done" : t.reasons.join(" | ") || t.state;
        return `- ${t.taskId} ${t.state}: ${why}`;
      });
    return [
      "queue_status (bookkeeping, not citable proof):",
      ...lines,
      `recovery_dispatches_used=${this.recoveryDispatchesUsed}/${this.policy.maxRecoveryDispatches}`,
      `continuations_used=${this.continuationsUsed}/${this.policy.maxContinuations}`,
    ].join("\n");
  }

  snapshot(): QueueSnapshot {
    return {
      policy: this.policy,
      tasks: this.tasks.map((t) => ({
        ...t,
        dependsOn: [...t.dependsOn],
        notes: [...t.notes],
        reasons: [...t.reasons],
        completionCitations: [...t.completionCitations],
      })),
      activeTaskId: this.activeTaskId,
      continuationsUsed: this.continuationsUsed,
      recoveryDispatchesUsed: this.recoveryDispatchesUsed,
      nextSequence: this.nextSequence,
      nextTaskOrdinal: this.nextTaskOrdinal,
      finalized: this.finalized,
      fence: this.fence,
      unresolvedTransition: this.unresolvedTransition,
    };
  }

  /** Tool schemas for registration beside lifecycle tools. */
  static toolSchemas(): Array<{ name: TaskQueueToolName; description: string; parameters: Record<string, unknown> }> {
    return [
      {
        name: "list_tasks",
        description:
          "Read-only bounded listing of task_ids, states, dependency ids, notes and runtime-recorded transition reasons. idempotent.",
        parameters: {
          type: "object",
          properties: { maxTasks: { type: "integer", minimum: 1, maximum: 32 } },
          additionalProperties: false,
        },
      },
      {
        name: "update_task",
        description:
          "Append a bounded note or abandon a nonterminal task with a nonempty reason. Cannot select active tasks, mark done or failed, revive terminal tasks, or close/reset recovery state.",
        parameters: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            note: { type: "string", maxLength: NOTE_MAX },
            abandon: { type: "boolean" },
            reason: { type: "string", maxLength: REASON_MAX },
          },
          required: ["task_id"],
          additionalProperties: false,
        },
      },
      {
        name: "enqueue_task",
        description:
          "Enqueue a flat planning record. Runtime assigns task_id and FIFO sequence. Rejects missing dependencies, self-dependencies, duplicates and cycles before mutation.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", maxLength: TITLE_MAX },
            goal: { type: "string", maxLength: GOAL_MAX },
            depends_on: { type: "array", items: { type: "string" }, maxItems: MAX_DEPENDENCIES },
          },
          required: ["title", "goal"],
          additionalProperties: false,
        },
      },
      {
        name: "complete_task",
        description:
          "Complete only the active task when no recovery slot or unresolved operation is open. Citations are validated; explicit_none records absence of evidence and cannot support an execution or success claim. Model-declared completion, not semantic verification.",
        parameters: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            citations: { type: "array", items: { type: "string" } },
            explicit_none: { type: "boolean" },
          },
          required: ["task_id"],
          additionalProperties: false,
        },
      },
    ];
  }

  dispatchTool(name: string, args: Record<string, unknown>): TaskQueueToolResult {
    switch (name) {
      case "list_tasks":
        return this.listTasks(typeof args.maxTasks === "number" ? args.maxTasks : undefined);
      case "update_task":
        return this.updateTask(args);
      case "enqueue_task":
        return this.enqueueTask(args);
      case "complete_task":
        return this.completeTask(args);
      default:
        return refuse("unknown_tool");
    }
  }

  private active(): TaskRecord | undefined {
    return this.tasks.find((t) => t.taskId === this.activeTaskId);
  }

  private depsDone(task: TaskRecord): boolean {
    return task.dependsOn.every((id) => this.tasks.find((t) => t.taskId === id)?.state === "done");
  }

  private blockDescendants(taskId: string, reason: string): void {
    const queue = [taskId];
    const seen = new Set<string>();
    while (queue.length) {
      const id = queue.shift() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const child of this.tasks) {
        if (!child.dependsOn.includes(id)) continue;
        if (child.state === "pending" || child.state === "active") {
          child.state = "blocked";
          child.reasons.push(reason.slice(0, REASON_MAX));
          child.failureKind = "blocked_dep";
          child.updatedAt = Date.now();
          if (this.activeTaskId === child.taskId) this.activeTaskId = null;
        }
        queue.push(child.taskId);
      }
    }
  }

  private failForCap(task: TaskRecord, kind: "step_cap" | "recovery_exhausted"): void {
    task.state = "failed";
    task.failureKind = kind;
    task.reasons.push(`failed:${kind}`);
    task.updatedAt = Date.now();
    this.failedGoals.add(normalizeGoal(task.goal));
    if (this.activeTaskId === task.taskId) this.activeTaskId = null;
    this.blockDescendants(task.taskId, `dependency_failed:${task.taskId}`);
    if (!this.ledger.hasOpenSlot()) {
      this.ledger.openSlot(task.taskId);
    }
    this.trace.push(`fail:${task.taskId}:${kind}`);
  }

  private makeTask(title: string, goal: string, dependsOn: string[]): TaskRecord {
    const ordinal = this.nextTaskOrdinal++;
    const task: TaskRecord = {
      taskId: `tq_${ordinal}`,
      sequence: this.nextSequence++,
      title,
      goal,
      dependsOn,
      state: "pending",
      notes: [],
      reasons: ["enqueued"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      stepsUsed: 0,
      recoveryDispatchesUsed: 0,
      completionCitations: [],
      explicitNone: false,
      unknownOutcome: false,
    };
    return task;
  }

  private pastDeadline(now = Date.now()): boolean {
    return now - this.startedAt > this.policy.wallClockDeadlineMs;
  }

  private async persist(
    kind: QueueJournalEntry["kind"],
    taskId: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.durable) return;
    const entry: QueueJournalEntry = {
      fence: this.fence + 1,
      kind,
      taskId,
      at: Date.now(),
      payload,
    };
    this.unresolvedTransition = entry;
    const appended = await this.durable.journalAppend(entry);
    if ("error" in appended) {
      this.trace.push(`journal_error:${appended.error}`);
      return;
    }
    const snap = this.snapshot();
    snap.fence = appended.fence;
    snap.unresolvedTransition = null;
    const written = await this.durable.checkpointWrite(snap);
    if ("error" in written) {
      this.trace.push(`checkpoint_error:${written.error}`);
      return;
    }
    this.fence = appended.fence;
    this.unresolvedTransition = null;
  }
}

function normalizeGoal(goal: string): string {
  return goal.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeDeps(
  raw: unknown,
): { ok: true; ids: string[] } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, ids: [] };
  if (!Array.isArray(raw)) return { ok: false, reason: "depends_on" };
  if (raw.length > MAX_DEPENDENCIES) return { ok: false, reason: "too_many_dependencies" };
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) return { ok: false, reason: "depends_on" };
    if (ids.includes(item)) return { ok: false, reason: "duplicate_dependency" };
    ids.push(item);
  }
  return { ok: true, ids };
}

function wouldCycle(tasks: TaskRecord[], newDeps: string[]): boolean {
  const graph = new Map<string, string[]>();
  for (const t of tasks) graph.set(t.taskId, [...t.dependsOn]);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function dfs(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dep of graph.get(id) ?? []) {
      if (dfs(dep)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  for (const id of newDeps) {
    if (dfs(id)) return true;
  }
  return false;
}

function invalid(error: string): TaskQueueToolResult {
  return { ok: false, started: false, error, code: "invalid_args" };
}
function refuse(error: string): TaskQueueToolResult {
  return { ok: false, started: false, error, code: "refused" };
}
function budget(error: string): TaskQueueToolResult {
  return { ok: false, started: false, error, code: "budget" };
}

export function isTaskQueueTool(name: string): name is TaskQueueToolName {
  return (TASK_QUEUE_TOOL_NAMES as readonly string[]).includes(name);
}

/** Delegation exclusion: queue tools must not appear in child allowlists. */
export function delegationAllowlistHasQueueTool(allowlist: readonly string[]): boolean {
  return allowlist.some((name) => isTaskQueueTool(name));
}

export function rejectQueueToolsFromDelegation(allowlist: readonly string[]): { ok: true } | { ok: false; error: string } {
  if (delegationAllowlistHasQueueTool(allowlist)) {
    return { ok: false, error: "queue_tools_excluded_from_delegation" };
  }
  return { ok: true };
}
