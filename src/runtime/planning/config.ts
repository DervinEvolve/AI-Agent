/**
 * cap_goal_planner_83 - GoalPlannerConfig defaults and hard caps.
 * Pure: resolves and freezes a config; it does not mount anything.
 */

export interface GoalPlannerConfig {
  enabled: boolean;
  maxGoals: number;
  maxEdges: number;
  maxPlannerCalls: number;
  maxProposalBytes: number;
  maxProjectionBytes: number;
  maxRefsPerGoal: number;
  maxPlannerOutputTokens: number;
  maxPlannerObservationBytes: number;
  maxPlannerObservations: number;
  minPlanningSteps: number;
}

type NumericKey = Exclude<keyof GoalPlannerConfig, 'enabled'>;

export const GOAL_PLANNER_DEFAULTS: Readonly<GoalPlannerConfig> = Object.freeze({
  enabled: false,
  maxGoals: 12,
  maxEdges: 32,
  maxPlannerCalls: 4,
  maxProposalBytes: 16384,
  maxProjectionBytes: 4096,
  maxRefsPerGoal: 4,
  maxPlannerOutputTokens: 2048,
  maxPlannerObservationBytes: 2048,
  maxPlannerObservations: 8,
  minPlanningSteps: 12,
});

export const GOAL_PLANNER_HARD_CAPS: Readonly<Record<NumericKey, number>> = Object.freeze({
  maxGoals: 24,
  maxEdges: 64,
  maxPlannerCalls: 8,
  maxProposalBytes: 32768,
  maxProjectionBytes: 8192,
  maxRefsPerGoal: 8,
  maxPlannerOutputTokens: 4096,
  maxPlannerObservationBytes: 8192,
  maxPlannerObservations: 16,
  minPlanningSteps: 1000,
});

const NUMERIC_KEYS: readonly NumericKey[] = [
  'maxGoals',
  'maxEdges',
  'maxPlannerCalls',
  'maxProposalBytes',
  'maxProjectionBytes',
  'maxRefsPerGoal',
  'maxPlannerOutputTokens',
  'maxPlannerObservationBytes',
  'maxPlannerObservations',
  'minPlanningSteps',
];

/**
 * Resolve a host-supplied partial config against defaults and hard caps.
 * Out-of-range or non-integer values throw RangeError (startup reject);
 * unknown keys throw TypeError. The result is frozen.
 */
export function resolveGoalPlannerConfig(input: Partial<GoalPlannerConfig> = {}): Readonly<GoalPlannerConfig> {
  const known = new Set<string>(['enabled', ...NUMERIC_KEYS]);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw new TypeError('GoalPlannerConfig: unknown field ' + key);
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new TypeError('GoalPlannerConfig: enabled must be boolean');
  }
  const out: GoalPlannerConfig = { ...GOAL_PLANNER_DEFAULTS, enabled: input.enabled === true };
  for (const key of NUMERIC_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    const cap = GOAL_PLANNER_HARD_CAPS[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > cap) {
      throw new RangeError('GoalPlannerConfig: ' + key + ' must be an integer in 1..' + String(cap));
    }
    out[key] = value;
  }
  return Object.freeze(out);
}
