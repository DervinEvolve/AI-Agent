// Types for cap_long_horizon_replanning_17 (mission_control)
// Pure orchestration/state layer types. No tool/network/adapter access.

export type MissionAction =
  | 'create_mission'
  | 'decompose'
  | 'checkpoint'
  | 'monitor'
  | 'replan'
  | 'resume'
  | 'abort'
  | 'status';

export type MissionStatus =
  | 'ok'
  | 'requires_user_approval'
  | 'policy_blocked'
  | 'budget_exhausted'
  | 'replanned'
  | 'blocked_on_dependency'
  | 'aborted'
  | 'stale';

export type ReplanTrigger =
  | 'milestone_failed'
  | 'precondition_drift'
  | 'external_state_change'
  | 'budget_pressure'
  | 'user_interrupt'
  | 'timeout';

export type MilestoneStatus =
  | 'pending'
  | 'in_progress'
  | 'passed'
  | 'failed'
  | 'uncertain'
  | 'blocked'
  | 'stale';

export interface MilestoneInput {
  milestone_id: string;
  description: string;
  success_criteria: string[];
  preconditions?: string[];
  dependencies?: string[];
  reversible?: boolean;
}

export interface Milestone {
  milestone_id: string;
  description: string;
  success_criteria: string[];
  preconditions: string[];
  dependencies: string[];
  reversible: boolean;
  status: MilestoneStatus;
  tainted: boolean;
}

export interface BudgetPolicy {
  max_wall_seconds?: number;
  max_compute?: number;
  max_replans?: number;
  checkpoint_interval?: number;
}

export interface ObservedState {
  // structured evidence of external world/task state
  data?: Record<string, unknown>;
  // taint tag: true whenever evidence derives from tainted observations
  tainted?: boolean;
  [k: string]: unknown;
}

export interface Provenance {
  mission_id: string;
  timestamps: number[];
  checkpoint_ids: string[];
  replan_history: ReplanRecord[];
  scope: string;
}

export interface ReplanRecord {
  at: number;
  trigger: ReplanTrigger | 'unspecified';
  tainted: boolean;
  preserved_completed: string[];
  revised_remaining: string[];
}

export interface MissionState {
  mission_id: string;
  goal: string;
  milestones_with_status: Milestone[];
  current_milestone: string | null;
  completed: string[];
  remaining: string[];
  replan_count: number;
  provenance: Provenance;
  stale: boolean;
  aborted: boolean;
}

export interface CheckpointRef {
  checkpoint_id: string;
  mission_id: string;
  scope: string;
  created_at: number;
  stale: boolean;
  // redacted snapshot payload as stored
  redacted_snapshot: Record<string, unknown>;
}

export interface NextPlan {
  advisory: true;
  mission_id: string;
  steps: Array<{
    milestone_id: string;
    description: string;
    success_criteria: string[];
    requires_approval: boolean;
  }>;
}

export interface MissionError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface MissionInputs {
  action: MissionAction;
  mission_id?: string;
  goal?: string;
  milestones?: MilestoneInput[];
  observed_state?: ObservedState;
  replan_trigger?: ReplanTrigger;
  budget_policy?: BudgetPolicy;
}

export interface MissionOutput {
  status: MissionStatus;
  error?: MissionError;
  mission_state?: MissionState;
  checkpoint?: CheckpointRef;
  next_plan?: NextPlan;
  tainted: boolean;
  provenance?: Provenance;
}

// --- Injectable deterministic backends (fakes in tests / wired to real caps in prod) ---

export interface ExecutionContext {
  // interactive contexts may request HITL approval; others fail closed
  interactive: boolean;
  kind?: 'interactive' | 'non_interactive' | 'scheduled' | 'event_triggered' | 'sub_agent';
  scope: string;
}

export interface BudgetTracker {
  // reserve returns true if budget available, false otherwise. Must be called
  // before any monitor/replan/checkpoint operation.
  reserve(kind: 'monitor' | 'replan' | 'checkpoint', amount: number): boolean;
}

export interface PlannerBackend {
  // Produces an advisory plan only. mission_control never executes it.
  plan(input: {
    goal: string;
    remaining: Milestone[];
    trigger?: ReplanTrigger;
  }): NextPlan['steps'];
}

export interface ControllerReflection {
  // Evaluates one milestone's immutable success_criteria against present state
  // via the controller reflection path. Returns a verdict only.
  evaluate(input: {
    milestone: Milestone;
    observed: ObservedState | undefined;
  }): 'passed' | 'failed' | 'uncertain';
}

export interface HitlBackend {
  // Returns an approval token when granted, null when denied.
  requestApproval(input: {
    mission_id: string;
    milestone_id: string;
    reason: string;
  }): { token: string } | null;
}

export interface MemoryBackend {
  // Durable checkpoint persistence (via cap_long_term_memory_3 in prod).
  write(record: { key: string; value: Record<string, unknown>; scope: string }): void;
  read(key: string): { value: Record<string, unknown>; scope: string } | null;
  delete(key: string): void;
}

export interface Redactor {
  // Redacts secrets from a snapshot before write.
  redact(value: Record<string, unknown>): Record<string, unknown>;
}

export interface MissionControlDeps {
  budget: BudgetTracker;
  planner: PlannerBackend;
  reflection: ControllerReflection;
  hitl: HitlBackend;
  memory: MemoryBackend;
  redactor: Redactor;
  now?: () => number;
  idgen?: () => string;
}
