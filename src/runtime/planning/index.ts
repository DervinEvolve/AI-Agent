/**
 * cap_goal_planner_83 - public surface of the planning module.
 *
 * NOTE: this is Layer A (pure core) only. Nothing here is wired into
 * AgentRuntime yet; see docs/goal-planner-83-layer-a-status.md.
 */

export * from './types';
export {
  GOAL_PLANNER_DEFAULTS,
  GOAL_PLANNER_HARD_CAPS,
  resolveGoalPlannerConfig,
} from './config';
export type { GoalPlannerConfig } from './config';
export {
  GOAL_ID_PATTERN,
  MAX_GOAL_TEXT_BYTES,
  MAX_REPORT_NOTE_BYTES,
  utf8Bytes,
  validateProposal,
  createGraph,
  selectReady,
  applyReport,
  applyReplan,
  markPossiblyStale,
  suspendScheduling,
  buildPlanningStatus,
} from './graph';
