/**
 * cap_goal_planner_83 - Layer A types (pure; no runtime imports).
 *
 * Everything here is plain data. Planner output, objectives, hints and notes
 * are untrusted model text; nothing in this module treats them as instructions.
 */

export type GoalDisposition =
  | 'pending'
  | 'active'
  | 'reported_achieved'
  | 'blocked'
  | 'abandoned'
  | 'needs_recheck';

export type SchedulingMode = 'scheduling' | 'planning_exhausted' | 'planning_stalled';

/** Structure-only node as proposed by the planner model. */
export interface GoalProposalNode {
  readonly id: string;
  readonly objective: string;
  readonly acceptance_hint: string;
  readonly depends_on: readonly string[];
}

/** A progress ref stored by the runtime. Never relabels the original call. */
export interface GoalEvidenceRef {
  readonly ref: string;
  /** Goal that was active when the observation was collected (null if none). */
  readonly original_goal: string | null;
  readonly original_revision: number | null;
  /** True when the observation was collected under a different goal. */
  readonly reused: boolean;
  /** Workspace generation of the observation, when the host supplies one. */
  readonly workspace_generation: number | null;
  readonly possibly_stale: boolean;
}

export interface GoalNodeState extends GoalProposalNode {
  readonly disposition: GoalDisposition;
  readonly evidence_refs: readonly GoalEvidenceRef[];
  readonly created_revision: number;
  /** True when the node was part of the revision-1 graph. */
  readonly initial: boolean;
  readonly last_activation_index: number | null;
}

export interface GoalGraph {
  readonly root_task_digest: string;
  readonly revision: number;
  /** Live nodes in proposal order, followed by abandoned history. */
  readonly nodes: readonly GoalNodeState[];
  readonly active_goal: string | null;
  readonly scheduling: SchedulingMode;
  readonly activation_counter: number;
}

export interface GraphLimits {
  readonly maxGoals: number;
  readonly maxEdges: number;
  readonly maxProposalBytes: number;
  readonly maxRefsPerGoal: number;
}

export type ProposalRejectCode =
  | 'oversize_proposal'
  | 'invalid_json'
  | 'invalid_shape'
  | 'unknown_field'
  | 'invalid_id'
  | 'duplicate_id'
  | 'text_too_large'
  | 'empty_graph'
  | 'too_many_goals'
  | 'too_many_edges'
  | 'dangling_edge'
  | 'self_edge'
  | 'cycle'
  | 'id_reuse'
  | 'silent_deletion'
  | 'unknown_operation_target'
  | 'invalid_operation';

export interface ProposalReject {
  readonly ok: false;
  readonly code: ProposalRejectCode;
  readonly detail: string;
}

export type ProposalResult =
  | { readonly ok: true; readonly nodes: readonly GoalProposalNode[] }
  | ProposalReject;

export type ReplanResult =
  | { readonly ok: true; readonly graph: GoalGraph; readonly abandoned: readonly string[]; readonly reopened: readonly string[] }
  | (ProposalReject & { readonly graph: GoalGraph });

export type ReportDisposition = 'achieved' | 'blocked' | 'contradicted';

export interface GoalReport {
  readonly goal_id: string;
  readonly disposition: ReportDisposition;
  readonly refs: readonly string[];
  readonly note: string;
}

/** Facts about an observation, supplied by the host/runtime, never by the model. */
export interface ObservationFacts {
  readonly kind: 'tool' | 'planning' | 'synthesis' | 'navigation';
  readonly outcome: 'success' | 'known_failure' | 'unknown';
  readonly current_run: boolean;
  readonly exposed: boolean;
  readonly restricted: boolean;
  readonly stale: boolean;
  readonly bound_goal: string | null;
  readonly bound_revision: number | null;
  readonly workspace_generation?: number | null;
}

export interface ReportContext {
  readonly lookup: (ref: string) => ObservationFacts | undefined;
  readonly maxRefsPerGoal: number;
}

export type ReportRefusalReason =
  | 'goal_not_active'
  | 'unknown_goal'
  | 'ineligible_support'
  | 'missing_support'
  | 'invalid_report'
  | 'note_too_large';

export type ReplanTrigger = 'contradicted' | 'blocked_no_ready' | null;

export interface ReportRecord {
  readonly goal_id: string;
  readonly disposition: ReportDisposition;
  readonly revision: number;
  readonly refs: readonly string[];
  readonly reuse: readonly { readonly ref: string; readonly original_goal: string | null; readonly original_revision: number | null }[];
  readonly replan_trigger: ReplanTrigger;
}

export type ReportResult =
  | { readonly ok: true; readonly started: true; readonly graph: GoalGraph; readonly record: ReportRecord }
  | { readonly ok: false; readonly started: false; readonly reason: ReportRefusalReason; readonly graph: GoalGraph };

export interface SelectResult {
  readonly graph: GoalGraph;
  readonly active_goal: string | null;
}

export interface PlanningStatus {
  readonly revision: number;
  readonly scheduling_mode: SchedulingMode;
  readonly reported_achieved_count: number;
  readonly abandoned: readonly { readonly id: string; readonly initial: boolean }[];
  readonly unresolved: readonly { readonly id: string; readonly disposition: GoalDisposition }[];
  readonly counts: Readonly<Record<GoalDisposition, number>>;
  readonly total: number;
}
