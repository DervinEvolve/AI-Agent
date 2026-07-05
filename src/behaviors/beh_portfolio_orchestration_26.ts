/**
 * beh_portfolio_orchestration_26
 *
 * Portfolio-aware task orchestration and prioritization.
 *
 * This is a *behavior descriptor* (a controller-wiring spec), NOT a scheduler.
 * The scheduling/lifecycle substrate already exists in the `*_24` async/background
 * capability files (background_executor_24, background_lease_24, trigger_registry_24,
 * webhook_gateway_24, cap_background_redactor_contract_24, background_redaction_adapter_24).
 *
 * This module tells the controller HOW to use that substrate:
 *  - consult get_ready_set deterministically (never ad-hoc LLM ordering),
 *  - honor priority classes / preemption (interactive preempts background),
 *  - switch to a provably independent ready task while another waits
 *    (ties into beh_async_hitl_loop_24),
 *  - checkpoint for deterministic resume,
 *  - offer *advisory* compensation on partial failure (no auto-rollback).
 *
 * Hard invariant: lifecycle state and dependency satisfaction are *scheduling
 * signals only*. They never relax success-criteria validation, never authorize
 * an action, and never substitute for a fresh HITL approval_token at dispatch.
 */

export const BEHAVIOR_ID = "beh_portfolio_orchestration_26" as const;

/** Priority classes. Lower `rank` == higher scheduling precedence. */
export const PRIORITY_CLASSES = {
  interactive: 0,
  background: 10,
} as const;

export type PriorityClass = keyof typeof PRIORITY_CLASSES;

/** Lifecycle states a task may be in (scheduling signals only). */
export type TaskLifecycleState =
  | "pending"
  | "ready"
  | "running"
  | "blocked_on_dependency"
  | "waiting_approval"
  | "done"
  | "failed";

/** States that must NEVER be selected as "next work" to start. */
export const NON_STARTABLE_STATES: readonly TaskLifecycleState[] = [
  "blocked_on_dependency",
  "waiting_approval",
  "running",
  "done",
  "failed",
] as const;

export interface PortfolioTask {
  id: string;
  goal: string;
  priority: PriorityClass;
  state: TaskLifecycleState;
  /** ids of tasks that must be `done` before this task is `ready`. */
  dependsOn: string[];
  /** true if a fresh HITL approval is required at dispatch. */
  requiresApproval: boolean;
  /** true when running in a non-interactive background context. */
  nonInteractive?: boolean;
  /** committed, non-cancelable external effects already produced by this task. */
  committedSideEffects?: CommittedSideEffect[];
}

export interface CommittedSideEffect {
  id: string;
  kind: string;
  /** true if the effect cannot be undone (e.g. an email that was sent). */
  irreversible?: boolean;
}

/**
 * An advisory compensation step. This is a *plan for human review*, never
 * auto-executed. Each step is idempotent by contract: it must check whether the
 * compensation was already applied before applying it (so resume/re-run does not
 * double-compensate).
 */
export interface CompensationStep {
  forEffectId: string;
  /** human-readable description of the reversal, e.g. "Refund customer $50". */
  action: string;
  /** idempotency guard: describes the check to run before applying. */
  idempotencyCheck: string;
  /** irreversible effects cannot be compensated; they are surfaced, not undone. */
  reversible: boolean;
  advisoryOnly: true;
}

export interface CompensationPlan {
  taskId: string;
  advisory: true;
  autoExecute: false;
  requiresUserReview: true;
  steps: CompensationStep[];
  /** effects that cannot be reversed and are surfaced to operators as-is. */
  irreversibleNotes: string[];
}

/**
 * Deterministically compute the ready set from the static task structure.
 * A task is ready iff:
 *   - it is not in a non-startable state, AND
 *   - all of its dependencies are `done`, AND
 *   - it is not waiting on an approval.
 *
 * This mirrors the get_ready_set contract of the lifecycle substrate: the
 * ready set is computed from structure, NOT from ad-hoc LLM ordering.
 */
export function getReadySet(tasks: PortfolioTask[]): PortfolioTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return tasks.filter((t) => {
    if (NON_STARTABLE_STATES.includes(t.state)) return false;
    if (t.requiresApproval && t.state === "waiting_approval") return false;
    return t.dependsOn.every((dep) => byId.get(dep)?.state === "done");
  });
}

/**
 * Select the next task to run from the ready set, honoring priority classes.
 * Interactive tasks (lower rank) preempt background tasks. Ties broken by id
 * for determinism. Returns undefined if nothing is runnable.
 *
 * Never returns a blocked / waiting_approval / running task.
 */
export function selectNextTask(tasks: PortfolioTask[]): PortfolioTask | undefined {
  const ready = getReadySet(tasks);
  if (ready.length === 0) return undefined;
  return [...ready].sort((a, b) => {
    const pa = PRIORITY_CLASSES[a.priority];
    const pb = PRIORITY_CLASSES[b.priority];
    if (pa !== pb) return pa - pb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

/**
 * While a task waits (approval or long external op), pick a provably
 * independent ready task to work on instead of blocking the portfolio.
 * "Independent" == does not depend on the waiting task and is not the waiting
 * task itself. Ties into beh_async_hitl_loop_24.
 */
export function selectIndependentWork(
  tasks: PortfolioTask[],
  waitingTaskId: string,
): PortfolioTask | undefined {
  const candidates = getReadySet(tasks).filter(
    (t) => t.id !== waitingTaskId && !t.dependsOn.includes(waitingTaskId),
  );
  return selectNextTask(candidates);
}

/**
 * Detect an unresolvable dependency cycle among tasks that are stuck waiting
 * on dependencies. Returns the ids participating in a cycle (empty if none).
 * A hung waiting task on a cycle should surface an error rather than hang.
 */
export function detectDependencyCycle(tasks: PortfolioTask[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 0 | 1 | 2>(); // 0=unvisited,1=in-stack,2=done
  const stack: string[] = [];
  let cycle: string[] = [];

  const visit = (id: string): boolean => {
    const t = byId.get(id);
    if (!t) return false;
    state.set(id, 1);
    stack.push(id);
    for (const dep of t.dependsOn) {
      const s = state.get(dep) ?? 0;
      if (s === 1) {
        const start = stack.indexOf(dep);
        cycle = stack.slice(start);
        return true;
      }
      if (s === 0 && visit(dep)) return true;
    }
    stack.pop();
    state.set(id, 2);
    return false;
  };

  for (const t of tasks) {
    if ((state.get(t.id) ?? 0) === 0) {
      if (visit(t.id)) return cycle;
    }
  }
  return [];
}

/**
 * Build an advisory compensation plan for a failed task with committed side
 * effects. Never auto-executes. Irreversible effects are surfaced as notes
 * (you can't un-send an email). Reversible effects get idempotent steps.
 */
export function buildCompensationPlan(task: PortfolioTask): CompensationPlan {
  const effects = task.committedSideEffects ?? [];
  const steps: CompensationStep[] = [];
  const irreversibleNotes: string[] = [];
  for (const e of effects) {
    if (e.irreversible) {
      irreversibleNotes.push(
        `Effect ${e.id} (${e.kind}) is irreversible and cannot be compensated; surfaced for operator awareness.`,
      );
      continue;
    }
    steps.push({
      forEffectId: e.id,
      action: `Reverse ${e.kind} produced by effect ${e.id}`,
      idempotencyCheck: `Verify effect ${e.id} has not already been compensated before applying.`,
      reversible: true,
      advisoryOnly: true,
    });
  }
  return {
    taskId: task.id,
    advisory: true,
    autoExecute: false,
    requiresUserReview: true,
    steps,
    irreversibleNotes,
  };
}

/** A checkpoint captures deterministic scheduling state for resume. */
export interface PortfolioCheckpoint {
  tasks: PortfolioTask[];
  readySetIds: string[];
  /** approval_tokens are NEVER checkpointed: resumed tasks require fresh HITL. */
  approvalTokens?: never;
}

export function checkpointPortfolio(tasks: PortfolioTask[]): PortfolioCheckpoint {
  const clone = tasks.map((t) => ({
    ...t,
    dependsOn: [...t.dependsOn],
    committedSideEffects: t.committedSideEffects
      ? t.committedSideEffects.map((e) => ({ ...e }))
      : undefined,
  }));
  return {
    tasks: clone,
    readySetIds: getReadySet(clone).map((t) => t.id),
  };
}

/**
 * Resume from a checkpoint. Deterministically reproduces the same ready set and
 * dependency status. Crucially, any task that requires approval is reset so it
 * still requires a FRESH HITL approval_token at dispatch — a stale token is
 * never resurrected.
 */
export function resumeFromCheckpoint(cp: PortfolioCheckpoint): {
  tasks: PortfolioTask[];
  readySet: PortfolioTask[];
  requiresFreshApproval: string[];
} {
  const tasks = cp.tasks.map((t) => ({
    ...t,
    dependsOn: [...t.dependsOn],
    committedSideEffects: t.committedSideEffects
      ? t.committedSideEffects.map((e) => ({ ...e }))
      : undefined,
  }));
  const requiresFreshApproval = tasks
    .filter((t) => t.requiresApproval)
    .map((t) => t.id);
  return {
    tasks,
    readySet: getReadySet(tasks),
    requiresFreshApproval,
  };
}

/**
 * Dispatch guard. Even when a task is `ready`/`running` per lifecycle state,
 * dispatch of an approval-gated action MUST carry a fresh, valid HITL
 * approval_token. Scheduling signals never substitute for authority, and never
 * relax success-criteria validation.
 *
 * Non-interactive background tasks that hit an HITL-gated step are blocked and
 * a redacted notification is emitted (they cannot self-approve).
 */
export interface DispatchDecision {
  allowed: boolean;
  policy_blocked: boolean;
  reason: string;
  redactedNotification?: string;
}

export function evaluateDispatch(
  task: PortfolioTask,
  ctx: { approvalToken?: string; successCriteriaMet: boolean },
): DispatchDecision {
  // Success criteria validation is never relaxed by lifecycle state.
  if (!ctx.successCriteriaMet) {
    return {
      allowed: false,
      policy_blocked: false,
      reason: "success_criteria_not_met",
    };
  }

  if (task.requiresApproval) {
    // Non-interactive background task cannot obtain fresh HITL approval.
    if (task.nonInteractive) {
      return {
        allowed: false,
        policy_blocked: true,
        reason: "hitl_required_in_non_interactive_context",
        redactedNotification: `Task ${task.id} reached an HITL-gated step in a non-interactive background context and was policy_blocked. [details redacted]`,
      };
    }
    // Interactive task must present a fresh approval token at dispatch.
    if (!ctx.approvalToken) {
      return {
        allowed: false,
        policy_blocked: true,
        reason: "fresh_hitl_approval_token_required",
      };
    }
  }

  return { allowed: true, policy_blocked: false, reason: "ok" };
}

export interface PortfolioOrchestrationBehavior {
  id: typeof BEHAVIOR_ID;
  name: string;
  status: "active";
  added_epoch: number;
  description: string;
  getReadySet: typeof getReadySet;
  selectNextTask: typeof selectNextTask;
  selectIndependentWork: typeof selectIndependentWork;
  detectDependencyCycle: typeof detectDependencyCycle;
  buildCompensationPlan: typeof buildCompensationPlan;
  checkpointPortfolio: typeof checkpointPortfolio;
  resumeFromCheckpoint: typeof resumeFromCheckpoint;
  evaluateDispatch: typeof evaluateDispatch;
}

export const behPortfolioOrchestration26: PortfolioOrchestrationBehavior = {
  id: BEHAVIOR_ID,
  name: "Portfolio-aware task orchestration and prioritization",
  status: "active",
  added_epoch: 26,
  description:
    "Tells the controller how to use the lifecycle manager: consult get_ready_set, honor priority/preemption, switch to independent work while waiting, checkpoint for resume, and offer advisory compensation on partial failure. Scheduling signals never grant authority or relax success-criteria validation.",
  getReadySet,
  selectNextTask,
  selectIndependentWork,
  detectDependencyCycle,
  buildCompensationPlan,
  checkpointPortfolio,
  resumeFromCheckpoint,
  evaluateDispatch,
};

export default behPortfolioOrchestration26;
