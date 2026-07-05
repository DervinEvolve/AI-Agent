// cap_task_lifecycle_manager_26
// Unified durable task lifecycle and concurrency manager.
//
// Pure orchestration / bookkeeping layer. It NEVER executes tools, missions,
// side effects, adapters, sandbox, browser, vault, or issues HITL tokens.
// It only decides eligibility (ready_set), records state transitions to an
// append-only history, computes portfolio status, and emits advisory
// compensation plans. The controller ReAct loop is the sole execution path.
//
// Design: event-sourced. All mutation happens by appending immutable events to
// a durable store. Task/portfolio state is derived by a pure reducer on read,
// so replay after restart is deterministic and byte-stable.

import { redactSecrets } from './secret_redactor';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OpStatus =
  | 'ok'
  | 'policy_blocked'
  | 'budget_exhausted'
  | 'not_found'
  | 'invalid_transition'
  | 'limit_exceeded'
  | 'scope_denied'
  | 'cycle_detected';

export type TaskState =
  | 'pending'
  | 'ready'
  | 'running'
  | 'waiting_approval'
  | 'blocked_on_dependency'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'compensating';

export type CompletionStatus = 'succeeded' | 'failed' | 'cancelled' | 'none';

export type PriorityClass = 'interactive' | 'user_background' | 'system_maintenance';

export type Interactivity = 'interactive' | 'non_interactive_background';

export type ReversibilityHint = 'reversible' | 'irreversible' | 'unknown';

export type DependencyKind = 'finish_to_start' | 'data' | 'approval';

export type RequiredStatus = 'completed' | 'approved';

export interface Scope {
  user_id: string;
  project_id: string;
  namespace: string;
}

export interface EvidenceRef {
  kind: string;
  id: string;
  scope?: Scope;
  version?: string | number;
  timestamp?: number;
  tainted?: boolean;
}

export interface BudgetPolicy {
  max_amount?: number;
  [k: string]: unknown;
}

export interface TaskSpec {
  goal_ref: string;
  mission_id?: string;
  priority_class: PriorityClass;
  budget_policy: BudgetPolicy;
  interactivity: Interactivity;
  reversibility_hint: ReversibilityHint;
}

export interface DependencyDecl {
  depends_on_task_id: string;
  kind: DependencyKind;
  required_status: RequiredStatus;
}

export interface BudgetRequest {
  amount: number;
  priority_class: PriorityClass;
}

export interface Provenance {
  task_id: string;
  scope: Scope;
  created_at: number;
  updated_at: number;
  version: number;
  state_history_ref: string;
  budget_reserved: number;
  event_refs: string[];
}

export interface CompensationStep {
  order: number;
  target_task_id: string;
  description: string;
  reversibility: ReversibilityHint;
  requires_hitl: boolean;
  hitl_reason?: string;
}

export interface CompensationPlan {
  target_task_id: string;
  advisory: true;
  auto_executed: false;
  steps: CompensationStep[];
}

export interface PortfolioStatus {
  active_counts_by_state: Record<string, number>;
  running_by_priority_class: Record<string, number>;
  pending_approvals: number;
  budget_utilization: { reserved: number; capacity: number; ratio: number };
  blocked_tasks: string[];
}

export interface ManagerOutput {
  op_status: OpStatus;
  task_state?: TaskState;
  completion_status?: CompletionStatus;
  tainted: boolean;
  provenance?: Provenance;
  ready_set?: string[];
  portfolio_status?: PortfolioStatus;
  compensation_plan?: CompensationPlan;
  error?: { code: string; message: string; retryable: boolean };
}

export type Action =
  | 'enqueue_task'
  | 'get_task'
  | 'list_tasks'
  | 'pause_task'
  | 'resume_task'
  | 'cancel_task'
  | 'declare_dependency'
  | 'get_ready_set'
  | 'record_state_transition'
  | 'allocate_budget_slice'
  | 'get_portfolio_status'
  | 'propose_compensation'
  | 'get_compensation_plan';

export interface ManagerInput {
  action: Action;
  task_id?: string;
  scope: Scope;
  task_spec?: TaskSpec;
  dependency?: DependencyDecl;
  target_state?: TaskState;
  transition_evidence_refs?: EvidenceRef[];
  budget_request?: BudgetRequest;
  compensation_target_task_id?: string;
}

// ---------------------------------------------------------------------------
// Injected deterministic fakes / dependencies (no real side effects)
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
}

export interface DurableEvent {
  seq: number;
  event_id: string;
  ts: number;
  scope: Scope;
  type: string;
  task_id?: string;
  payload: Record<string, unknown>;
}

export interface DurableStore {
  append(event: DurableEvent): void;
  readAll(): DurableEvent[];
}

export interface BudgetTracker {
  capacity(): number;
}

export interface TraceEval {
  emit(eventType: string, data: Record<string, unknown>): void;
}

// Verifies whether a HITL approval token exists for a specific bound action.
// The manager NEVER issues tokens; it only queries verification.
export interface HitlVerifier {
  isApproved(taskId: string, boundAction: string): boolean;
}

export interface ManagerDeps {
  clock: Clock;
  store: DurableStore;
  budget: BudgetTracker;
  trace: TraceEval;
  hitl: HitlVerifier;
}

// ---------------------------------------------------------------------------
// In-memory deterministic fakes for tests / default wiring
// ---------------------------------------------------------------------------

export class FakeClock implements Clock {
  private t: number;
  constructor(start = 1_000_000) {
    this.t = start;
  }
  now(): number {
    // Monotonic deterministic tick.
    this.t += 1;
    return this.t;
  }
}

export class InMemoryDurableStore implements DurableStore {
  private events: DurableEvent[] = [];
  append(event: DurableEvent): void {
    // Append-only. Deep-freeze to guarantee immutability of history.
    this.events.push(deepFreeze({ ...event, payload: { ...event.payload } }));
  }
  readAll(): DurableEvent[] {
    return this.events.slice();
  }
}

export class FakeBudgetTracker implements BudgetTracker {
  constructor(private cap: number) {}
  capacity(): number {
    return this.cap;
  }
}

export class FakeTraceEval implements TraceEval {
  public events: Array<{ type: string; data: Record<string, unknown> }> = [];
  emit(eventType: string, data: Record<string, unknown>): void {
    this.events.push({ type: eventType, data });
  }
}

export class FakeHitlVerifier implements HitlVerifier {
  private approvals = new Set<string>();
  approve(taskId: string, boundAction: string): void {
    this.approvals.add(`${taskId}::${boundAction}`);
  }
  isApproved(taskId: string, boundAction: string): boolean {
    return this.approvals.has(`${taskId}::${boundAction}`);
  }
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const LIMITS = {
  max_active_tasks_per_scope: 10,
  max_concurrent_running_per_scope: 3,
  max_dependency_depth: 8,
  max_dependencies_per_task: 20,
  max_replan_hops_per_task: 5,
} as const;

const PRIORITY_RANK: Record<PriorityClass, number> = {
  interactive: 3,
  user_background: 2,
  system_maintenance: 1,
};

const ACTIVE_STATES: TaskState[] = [
  'pending',
  'ready',
  'running',
  'waiting_approval',
  'blocked_on_dependency',
  'paused',
  'compensating',
];

const TERMINAL_STATES: TaskState[] = ['completed', 'failed', 'cancelled'];

// Legal transition map for the lifecycle state machine.
const LEGAL_TRANSITIONS: Record<TaskState, TaskState[]> = {
  pending: ['ready', 'blocked_on_dependency', 'cancelled', 'paused', 'failed'],
  ready: ['running', 'blocked_on_dependency', 'waiting_approval', 'paused', 'cancelled', 'failed'],
  running: [
    'waiting_approval',
    'blocked_on_dependency',
    'paused',
    'completed',
    'failed',
    'cancelled',
    'compensating',
  ],
  waiting_approval: ['running', 'ready', 'blocked_on_dependency', 'paused', 'cancelled', 'failed'],
  blocked_on_dependency: ['ready', 'running', 'paused', 'cancelled', 'failed'],
  paused: ['ready', 'cancelled', 'failed'],
  completed: [],
  failed: ['compensating'],
  cancelled: [],
  compensating: ['failed', 'completed', 'cancelled'],
};

// ---------------------------------------------------------------------------
// Derived (reduced) task model
// ---------------------------------------------------------------------------

interface TransitionRecord {
  from: TaskState;
  to: TaskState;
  ts: number;
  version: number;
  evidence_refs: EvidenceRef[];
  validation_status: 'verified' | 'tainted_only' | 'none';
  event_id: string;
}

interface DerivedDependency {
  depends_on_task_id: string;
  kind: DependencyKind;
  required_status: RequiredStatus;
}

interface DerivedTask {
  task_id: string;
  scope: Scope;
  spec: TaskSpec;
  state: TaskState;
  created_at: number;
  updated_at: number;
  version: number;
  history: TransitionRecord[];
  dependencies: DerivedDependency[];
  budget_reserved: number;
  tainted: boolean;
  replan_hops: number;
  event_refs: string[];
}

interface DerivedState {
  tasks: Map<string, DerivedTask>;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object') {
    Object.values(obj as Record<string, unknown>).forEach((v) => deepFreeze(v));
    Object.freeze(obj);
  }
  return obj;
}

function sameScope(a: Scope, b: Scope): boolean {
  return a.user_id === b.user_id && a.project_id === b.project_id && a.namespace === b.namespace;
}

function scopeKey(s: Scope): string {
  return `${s.user_id}/${s.project_id}/${s.namespace}`;
}

// Runs secret_redactor + a lightweight content policy that strips known
// sensitive keys. Returns a deep-redacted clone; never mutates input.
export function redactForStorage<T>(value: T): T {
  const SENSITIVE_KEYS = new Set([
    'token',
    'approval_token',
    'vault_token',
    'pending_approval_id',
    'pending_approval_ids',
    'cookie',
    'cookies',
    'auth',
    'authorization',
    'secret',
    'password',
    'api_key',
    'apikey',
    'session',
  ]);

  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (SENSITIVE_KEYS.has(k.toLowerCase())) {
          out[k] = '[REDACTED]';
        } else {
          out[k] = strip(val);
        }
      }
      return out;
    }
    if (typeof v === 'string') {
      try {
        return redactSecrets(v);
      } catch {
        return v;
      }
    }
    return v;
  };

  return strip(value) as T;
}

function classifyEvidence(refs: EvidenceRef[] | undefined): {
  status: 'verified' | 'tainted_only' | 'none';
  tainted: boolean;
} {
  if (!refs || refs.length === 0) return { status: 'none', tainted: false };
  const anyTainted = refs.some((r) => r.tainted === true);
  const anyClean = refs.some((r) => r.tainted !== true);
  if (anyClean) return { status: 'verified', tainted: anyTainted };
  return { status: 'tainted_only', tainted: true };
}

// States that require verified (non-tainted-only, non-empty) evidence.
const EVIDENCE_REQUIRED_STATES: TaskState[] = ['completed'];

// ---------------------------------------------------------------------------
// Reducer: build derived state from durable event history (deterministic)
// ---------------------------------------------------------------------------

export function reduceEvents(events: DurableEvent[]): DerivedState {
  const tasks = new Map<string, DerivedTask>();
  const sorted = events.slice().sort((a, b) => a.seq - b.seq);

  for (const ev of sorted) {
    switch (ev.type) {
      case 'task_enqueued': {
        const p = ev.payload as {
          spec: TaskSpec;
          tainted: boolean;
        };
        tasks.set(ev.task_id!, {
          task_id: ev.task_id!,
          scope: ev.scope,
          spec: p.spec,
          state: 'pending',
          created_at: ev.ts,
          updated_at: ev.ts,
          version: 1,
          history: [],
          dependencies: [],
          budget_reserved: 0,
          tainted: !!p.tainted,
          replan_hops: 0,
          event_refs: [ev.event_id],
        });
        break;
      }
      case 'state_transition': {
        const t = tasks.get(ev.task_id!);
        if (!t) break;
        const p = ev.payload as {
          from: TaskState;
          to: TaskState;
          evidence_refs: EvidenceRef[];
          validation_status: 'verified' | 'tainted_only' | 'none';
          tainted: boolean;
        };
        t.history.push({
          from: p.from,
          to: p.to,
          ts: ev.ts,
          version: t.version + 1,
          evidence_refs: p.evidence_refs,
          validation_status: p.validation_status,
          event_id: ev.event_id,
        });
        t.state = p.to;
        t.version += 1;
        t.updated_at = ev.ts;
        t.tainted = t.tainted || !!p.tainted;
        t.event_refs.push(ev.event_id);
        if (p.to === 'ready') t.replan_hops += 1;
        break;
      }
      case 'dependency_declared': {
        const t = tasks.get(ev.task_id!);
        if (!t) break;
        const p = ev.payload as { dependency: DerivedDependency; tainted: boolean };
        t.dependencies.push(p.dependency);
        t.version += 1;
        t.updated_at = ev.ts;
        t.tainted = t.tainted || !!p.tainted;
        t.event_refs.push(ev.event_id);
        break;
      }
      case 'budget_reserved': {
        const t = tasks.get(ev.task_id!);
        if (!t) break;
        const p = ev.payload as { amount: number };
        t.budget_reserved += p.amount;
        t.version += 1;
        t.updated_at = ev.ts;
        t.event_refs.push(ev.event_id);
        break;
      }
      case 'budget_released': {
        const t = tasks.get(ev.task_id!);
        if (!t) break;
        const p = ev.payload as { amount: number };
        t.budget_reserved = Math.max(0, t.budget_reserved - p.amount);
        t.version += 1;
        t.updated_at = ev.ts;
        t.event_refs.push(ev.event_id);
        break;
      }
      default:
        break;
    }
  }

  return { tasks };
}

// ---------------------------------------------------------------------------
// Dependency graph helpers
// ---------------------------------------------------------------------------

function wouldCreateCycle(
  state: DerivedState,
  taskId: string,
  dependsOn: string,
): boolean {
  // Adding edge task -> dependsOn (task depends on dependsOn).
  // Cycle exists if dependsOn can already reach task through dependencies.
  if (taskId === dependsOn) return true;
  const visited = new Set<string>();
  const stack = [dependsOn];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === taskId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const t = state.tasks.get(cur);
    if (!t) continue;
    for (const dep of t.dependencies) stack.push(dep.depends_on_task_id);
  }
  return false;
}

function dependencyDepth(state: DerivedState, taskId: string): number {
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return 0; // guard against cycles during measurement
    visiting.add(id);
    const t = state.tasks.get(id);
    let max = 0;
    if (t) {
      for (const dep of t.dependencies) {
        max = Math.max(max, 1 + depth(dep.depends_on_task_id));
      }
    }
    visiting.delete(id);
    memo.set(id, max);
    return max;
  };
  return depth(taskId);
}

// ---------------------------------------------------------------------------
// The Manager
// ---------------------------------------------------------------------------

export class TaskLifecycleManager {
  private seq = 0;
  private eventCounter = 0;

  constructor(private deps: ManagerDeps) {
    // Recover seq from existing durable events so restart is deterministic.
    const existing = this.deps.store.readAll();
    for (const e of existing) {
      if (e.seq >= this.seq) this.seq = e.seq;
    }
    this.eventCounter = existing.length;
  }

  private nextEventId(): string {
    this.eventCounter += 1;
    return `evt_${this.eventCounter}`;
  }

  private appendEvent(
    type: string,
    scope: Scope,
    taskId: string | undefined,
    payload: Record<string, unknown>,
  ): DurableEvent {
    this.seq += 1;
    const ev: DurableEvent = {
      seq: this.seq,
      event_id: this.nextEventId(),
      ts: this.deps.clock.now(),
      scope,
      type,
      task_id: taskId,
      payload,
    };
    this.deps.store.append(ev);
    return ev;
  }

  private state(): DerivedState {
    return reduceEvents(this.deps.store.readAll());
  }

  private buildProvenance(t: DerivedTask): Provenance {
    return {
      task_id: t.task_id,
      scope: t.scope,
      created_at: t.created_at,
      updated_at: t.updated_at,
      version: t.version,
      state_history_ref: `history:${t.task_id}`,
      budget_reserved: t.budget_reserved,
      event_refs: t.event_refs.slice(),
    };
  }

  private completionStatus(t: DerivedTask): CompletionStatus {
    switch (t.state) {
      case 'completed':
        return 'succeeded';
      case 'failed':
        return 'failed';
      case 'cancelled':
        return 'cancelled';
      default:
        return 'none';
    }
  }

  private scopeTasks(scope: Scope): DerivedTask[] {
    return [...this.state().tasks.values()].filter((t) => sameScope(t.scope, scope));
  }

  handle(input: ManagerInput): ManagerOutput {
    switch (input.action) {
      case 'enqueue_task':
        return this.enqueueTask(input);
      case 'get_task':
        return this.getTask(input);
      case 'list_tasks':
        return this.listTasks(input);
      case 'declare_dependency':
        return this.declareDependency(input);
      case 'record_state_transition':
        return this.recordTransition(input);
      case 'get_ready_set':
        return this.getReadySet(input);
      case 'allocate_budget_slice':
        return this.allocateBudget(input);
      case 'pause_task':
        return this.pauseTask(input);
      case 'resume_task':
        return this.resumeTask(input);
      case 'cancel_task':
        return this.cancelTask(input);
      case 'get_portfolio_status':
        return this.portfolioStatus(input);
      case 'propose_compensation':
      case 'get_compensation_plan':
        return this.proposeCompensation(input);
      default:
        return { op_status: 'invalid_transition', tainted: false };
    }
  }

  // --- enqueue ---
  private enqueueTask(input: ManagerInput): ManagerOutput {
    const spec = input.task_spec;
    if (!spec) {
      return { op_status: 'not_found', tainted: false, error: { code: 'missing_spec', message: 'task_spec required', retryable: false } };
    }
    const scopeTasks = this.scopeTasks(input.scope);
    const active = scopeTasks.filter((t) => ACTIVE_STATES.includes(t.state));
    if (active.length >= LIMITS.max_active_tasks_per_scope) {
      return { op_status: 'limit_exceeded', tainted: false, error: { code: 'max_active_tasks', message: 'active task cap reached', retryable: true } };
    }

    const inputTainted = (input.transition_evidence_refs ?? []).some((r) => r.tainted === true);
    const redactedSpec = redactForStorage(spec);
    const taskId = `task_${scopeKey(input.scope)}_${this.seq + 1}`;

    const ev = this.appendEvent('task_enqueued', input.scope, taskId, {
      spec: redactedSpec,
      tainted: inputTainted,
    });
    this.deps.trace.emit('lifecycle_enqueue', { task_id: taskId, scope: input.scope, event_id: ev.event_id });

    const t = this.state().tasks.get(taskId)!;
    return {
      op_status: 'ok',
      task_state: 'pending',
      completion_status: 'none',
      tainted: t.tainted,
      provenance: this.buildProvenance(t),
    };
  }

  private lookup(input: ManagerInput): { t?: DerivedTask; err?: ManagerOutput } {
    if (!input.task_id) {
      return { err: { op_status: 'not_found', tainted: false, error: { code: 'missing_task_id', message: 'task_id required', retryable: false } } };
    }
    const t = this.state().tasks.get(input.task_id);
    if (!t) {
      return { err: { op_status: 'not_found', tainted: false, error: { code: 'unknown_task', message: 'task not found', retryable: false } } };
    }
    if (!sameScope(t.scope, input.scope)) {
      return { err: { op_status: 'scope_denied', tainted: false, error: { code: 'scope', message: 'out of scope', retryable: false } } };
    }
    return { t };
  }

  private getTask(input: ManagerInput): ManagerOutput {
    const { t, err } = this.lookup(input);
    if (err) return err;
    return {
      op_status: 'ok',
      task_state: t!.state,
      completion_status: this.completionStatus(t!),
      tainted: t!.tainted,
      provenance: this.buildProvenance(t!),
    };
  }

  private listTasks(input: ManagerInput): ManagerOutput {
    // Scope-authorized: only same-scope task ids are returned.
    const ids = this.scopeTasks(input.scope).map((t) => t.task_id);
    this.deps.trace.emit('lifecycle_list_tasks', { scope: input.scope, count: ids.length });
    return { op_status: 'ok', tainted: false, ready_set: ids };
  }

  // --- dependency ---
  private declareDependency(input: ManagerInput): ManagerOutput {
    const { t, err } = this.lookup(input);
    if (err) return err;
    const dep = input.dependency;
    if (!dep) {
      return { op_status: 'not_found', tainted: false, error: { code: 'missing_dependency', message: 'dependency required', retryable: false } };
    }
    const state = this.state();
    const target = state.tasks.get(dep.depends_on_task_id);
    if (!target || !sameScope(target.scope, input.scope)) {
      return { op_status: 'not_found', tainted: false, error: { code: 'dep_target', message: 'dependency target not found in scope', retryable: false } };
    }
    if (t!.dependencies.length >= LIMITS.max_dependencies_per_task) {
      return { op_status: 'limit_exceeded', tainted: false, error: { code: 'max_deps', message: 'dependency cap reached', retryable: false } };
    }
    if (wouldCreateCycle(state, t!.task_id, dep.depends_on_task_id)) {
      return { op_status: 'cycle_detected', tainted: false, error: { code: 'cycle', message: 'dependency would create cycle', retryable: false } };
    }
    // Check depth AFTER hypothetically adding edge.
    const projectedDepth = 1 + dependencyDepth(state, dep.depends_on_task_id);
    if (projectedDepth > LIMITS.max_dependency_depth) {
      return { op_status: 'limit_exceeded', tainted: false, error: { code: 'max_depth', message: 'dependency depth exceeded', retryable: false } };
    }

    const ev = this.appendEvent('dependency_declared', input.scope, t!.task_id, {
      dependency: { depends_on_task_id: dep.depends_on_task_id, kind: dep.kind, required_status: dep.required_status },
      tainted: target.tainted,
    });
    this.deps.trace.emit('lifecycle_dependency_add', { task_id: t!.task_id, depends_on: dep.depends_on_task_id, kind: dep.kind, event_id: ev.event_id });

    const updated = this.state().tasks.get(t!.task_id)!;
    return {
      op_status: 'ok',
      task_state: updated.state,
      completion_status: this.completionStatus(updated),
      tainted: updated.tainted,
      provenance: this.buildProvenance(updated),
    };
  }

  // --- state transition ---
  private recordTransition(input: ManagerInput): ManagerOutput {
    const { t, err } = this.lookup(input);
    if (err) return err;
    const to = input.target_state;
    if (!to) {
      return { op_status: 'invalid_transition', tainted: t!.tainted, error: { code: 'missing_target', message: 'target_state required', retryable: false } };
    }
    const legal = LEGAL_TRANSITIONS[t!.state] ?? [];
    if (!legal.includes(to)) {
      return {
        op_status: 'invalid_transition',
        task_state: t!.state,
        completion_status: this.completionStatus(t!),
        tainted: t!.tainted,
        error: { code: 'illegal_transition', message: `${t!.state} -> ${to} not allowed`, retryable: false },
      };
    }

    // replan-hop cap: each re-entry to 'ready' after the first counts as a hop.
    if (to === 'ready' && t!.replan_hops >= LIMITS.max_replan_hops_per_task) {
      return {
        op_status: 'limit_exceeded',
        task_state: t!.state,
        completion_status: this.completionStatus(t!),
        tainted: t!.tainted,
        error: { code: 'max_replan_hops', message: 'replan hop cap reached', retryable: false },
      };
    }

    const { status, tainted } = classifyEvidence(input.transition_evidence_refs);
    if (EVIDENCE_REQUIRED_STATES.includes(to)) {
      if (status === 'none') {
        return {
          op_status: 'invalid_transition',
          task_state: t!.state,
          completion_status: this.completionStatus(t!),
          tainted: t!.tainted,
          error: { code: 'evidence_required', message: 'completion requires verified evidence', retryable: false },
        };
      }
      if (status === 'tainted_only') {
        return {
          op_status: 'invalid_transition',
          task_state: t!.state,
          completion_status: this.completionStatus(t!),
          tainted: true,
          error: { code: 'tainted_evidence_only', message: 'tainted-only evidence cannot drive completion', retryable: false },
        };
      }
    }

    const redactedEvidence = redactForStorage(input.transition_evidence_refs ?? []);
    const ev = this.appendEvent('state_transition', input.scope, t!.task_id, {
      from: t!.state,
      to,
      evidence_refs: redactedEvidence,
      validation_status: status,
      tainted,
    });
    this.deps.trace.emit('lifecycle_transition', { task_id: t!.task_id, from: t!.state, to, validation_status: status, event_id: ev.event_id });

    const updated = this.state().tasks.get(t!.task_id)!;
    return {
      op_status: 'ok',
      task_state: updated.state,
      completion_status: this.completionStatus(updated),
      tainted: updated.tainted,
      provenance: this.buildProvenance(updated),
    };
  }

  // --- dependency satisfaction ---
  private depSatisfied(state: DerivedState, dep: DerivedDependency, ownerTaskId: string): boolean {
    const target = state.tasks.get(dep.depends_on_task_id);
    if (!target) return false;
    if (dep.kind === 'approval' || dep.required_status === 'approved') {
      // Approval deps are satisfied ONLY by a verified HITL token bound to the
      // exact action. Lifecycle state never satisfies an approval dependency.
      const boundAction = `dep:${ownerTaskId}:${dep.depends_on_task_id}`;
      return this.deps.hitl.isApproved(ownerTaskId, boundAction);
    }
    // finish_to_start / data => require completed.
    return target.state === 'completed';
  }

  // --- ready set ---
  private computeReadySet(scope: Scope): string[] {
    const state = this.state();
    const scoped = [...state.tasks.values()].filter((t) => sameScope(t.scope, scope));
    const running = scoped.filter((t) => t.state === 'running');

    const eligible = scoped.filter((t) => {
      if (t.state !== 'ready') return false;
      return t.dependencies.every((d) => this.depSatisfied(state, d, t.task_id));
    });

    // Sort by priority (interactive first), then by created_at for determinism.
    eligible.sort((a, b) => {
      const pr = PRIORITY_RANK[b.spec.priority_class] - PRIORITY_RANK[a.spec.priority_class];
      if (pr !== 0) return pr;
      if (a.created_at !== b.created_at) return a.created_at - b.created_at;
      return a.task_id < b.task_id ? -1 : 1;
    });

    // Concurrency cap: running + admitted must not exceed max_concurrent_running.
    // Interactive strictly preempts lower classes for the shared slots: an
    // interactive candidate may claim a slot even when running lower-class
    // tasks fill capacity (the controller then preempts). Lower classes never
    // preempt interactive.
    const cap = LIMITS.max_concurrent_running_per_scope;
    const runningInteractive = running.filter((r) => r.spec.priority_class === 'interactive').length;
    const runningLower = running.length - runningInteractive;

    const admitted: string[] = [];
    let freeSlots = Math.max(0, cap - running.length);
    let preemptibleLower = runningLower;

    for (const t of eligible) {
      if (freeSlots > 0) {
        admitted.push(t.task_id);
        freeSlots -= 1;
        continue;
      }
      if (t.spec.priority_class === 'interactive' && preemptibleLower > 0) {
        // Preempt a lower-class running task's slot.
        admitted.push(t.task_id);
        preemptibleLower -= 1;
      }
    }

    return admitted;
  }

  private getReadySet(input: ManagerInput): ManagerOutput {
    const ready = this.computeReadySet(input.scope);
    this.deps.trace.emit('lifecycle_ready_set', { scope: input.scope, ready_set: ready });
    return { op_status: 'ok', tainted: false, ready_set: ready };
  }

  // --- budget ---
  private allocateBudget(input: ManagerInput): ManagerOutput {
    const { t, err } = this.lookup(input);
    if (err) return err;
    const req = input.budget_request;
    if (!req) {
      return { op_status: 'not_found', tainted: t!.tainted, error: { code: 'missing_budget_request', message: 'budget_request required', retryable: false } };
    }
    const state = this.state();
    const scoped = [...state.tasks.values()].filter((x) => sameScope(x.scope, input.scope));
    const capacity = this.deps.budget.capacity();
    const reserved = scoped.reduce((sum, x) => sum + x.budget_reserved, 0);
    let free = capacity - reserved;

    if (req.amount <= free) {
      const ev = this.appendEvent('budget_reserved', input.scope, t!.task_id, { amount: req.amount, priority_class: req.priority_class });
      this.deps.trace.emit('lifecycle_budget_alloc', { task_id: t!.task_id, amount: req.amount, event_id: ev.event_id });
      const updated = this.state().tasks.get(t!.task_id)!;
      return { op_status: 'ok', task_state: updated.state, completion_status: this.completionStatus(updated), tainted: updated.tainted, provenance: this.buildProvenance(updated) };
    }

    // Not enough free budget. If request is interactive, attempt to preempt
    // lower-class reservations (release their reserved budget). Lower classes
    // can NEVER preempt interactive.
    if (req.priority_class === 'interactive') {
      const preemptable = scoped
        .filter((x) => x.spec.priority_class !== 'interactive' && x.budget_reserved > 0)
        .sort((a, b) => PRIORITY_RANK[a.spec.priority_class] - PRIORITY_RANK[b.spec.priority_class]);
      for (const victim of preemptable) {
        if (req.amount <= free) break;
        const ev = this.appendEvent('budget_released', input.scope, victim.task_id, { amount: victim.budget_reserved, reason: 'preempted_by_interactive' });
        this.deps.trace.emit('lifecycle_budget_preempt', { victim: victim.task_id, event_id: ev.event_id });
        free += victim.budget_reserved;
      }
      if (req.amount <= free) {
        const ev = this.appendEvent('budget_reserved', input.scope, t!.task_id, { amount: req.amount, priority_class: req.priority_class });
        this.deps.trace.emit('lifecycle_budget_alloc', { task_id: t!.task_id, amount: req.amount, event_id: ev.event_id });
        const updated = this.state().tasks.get(t!.task_id)!;
        return { op_status: 'ok', task_state: updated.state, completion_status: this.completionStatus(updated), tainted: updated.tainted, provenance: this.buildProvenance(updated) };
      }
    }

    return { op_status: 'budget_exhausted', task_state: t!.state, completion_status: this.completionStatus(t!), tainted: t!.tainted, error: { code: 'budget_exhausted', message: 'insufficient budget', retryable: true } };
  }

  // --- pause / resume / cancel ---
  private pauseTask(input: ManagerInput): ManagerOutput {
    const { t, err } = this.lookup(input);
    if (err) return err;
    if (t!.state !== 'running' && t!.state !== 'ready') {
      return { op_status: 'invalid_transition', task_state: t!.state, completion_status: this.completionStatus(t!), tainted: t!.tainted, error: { code: 'not_pausable', message: 'only running/ready tasks can pause', retryable: false } };
    }
    // Release running budget on pause (paused tasks reserve no running budget).
    if (t!.budget_reserved > 0) {
      this.appendEvent('budget_released', input.scope, t!.task_id, { amount: t!.budget_reserved, reason: 'paused' });
    }
    const ev = this.appendEvent('state_transition', input.scope, t!.task_id, { from: t!.state, to: 'paused', evidence_refs: [], validation_status: 'none', tainted: false });
    this.deps.trace.emit('lifecycle_pause', { task_id: t!.task_id, event_id: ev.event_id });
    const updated = this.state().tasks.get(t!.task_id)!;
    return { op_status: 'ok', task_state: updated.state, completion_status: this.completionStatus(updated), tainted: updated.tainted, provenance: this.buildProvenance(updated) };
  }

  private resumeTask(input: ManagerInput): ManagerOutput {
    const { t, err } = this.lookup(input);
    if (err) return err;
    if (t!.state !== 'paused') {
      return { op_status: 'invalid_transition', task_state: t!.state, completion_status: this.completionStatus(t!), tainted: t!.tainted, error: { code: 'not_paused', message: 'task is not paused', retryable: false } };
    }
    const ev = this.appendEvent('state_transition', input.scope, t!.task_id, { from: 'paused', to: 'ready', evidence_refs: [], validation_status: 'none', tainted: false });
    this.deps.trace.emit('lifecycle_resume', { task_id: t!.task_id, event_id: ev.event_id });
    const updated = this.state().tasks.get(t!.task_id)!;
    return { op_status: 'ok', task_state: updated.state, completion_status: this.completionStatus(updated), tainted: updated.tainted, provenance: this.buildProvenance(updated) };
  }

  private cancelTask(input: ManagerInput): ManagerOutput {
    const { t, err } = this.lookup(input);
    if (err) return err;
    if (TERMINAL_STATES.includes(t!.state)) {
      return { op_status: 'invalid_transition', task_state: t!.state, completion_status: this.completionStatus(t!), tainted: t!.tainted, error: { code: 'already_terminal', message: 'cannot cancel terminal task', retryable: false } };
    }
    if (t!.budget_reserved > 0) {
      this.appendEvent('budget_released', input.scope, t!.task_id, { amount: t!.budget_reserved, reason: 'cancelled' });
    }
    const ev = this.appendEvent('state_transition', input.scope, t!.task_id, { from: t!.state, to: 'cancelled', evidence_refs: [], validation_status: 'none', tainted: false });
    // Redacted notification (never contains raw secrets).
    this.deps.trace.emit('lifecycle_cancel', redactForStorage({ task_id: t!.task_id, scope: input.scope, event_id: ev.event_id }));

    // Re-evaluate dependents: those blocked on this task become blocked_on_dependency
    // (or already are). The controller decides fail vs. reblock; we surface via ready_set exclusion.
    const state = this.state();
    for (const dep of state.tasks.values()) {
      if (!sameScope(dep.scope, input.scope)) continue;
      const dependsOnCancelled = dep.dependencies.some((d) => d.depends_on_task_id === t!.task_id);
      if (dependsOnCancelled && (dep.state === 'ready' || dep.state === 'pending')) {
        const legal = LEGAL_TRANSITIONS[dep.state] ?? [];
        if (legal.includes('blocked_on_dependency')) {
          this.appendEvent('state_transition', input.scope, dep.task_id, { from: dep.state, to: 'blocked_on_dependency', evidence_refs: [], validation_status: 'none', tainted: false });
        }
      }
    }

    const updated = this.state().tasks.get(t!.task_id)!;
    return { op_status: 'ok', task_state: updated.state, completion_status: this.completionStatus(updated), tainted: updated.tainted, provenance: this.buildProvenance(updated) };
  }

  // --- portfolio ---
  private portfolioStatus(input: ManagerInput): Man