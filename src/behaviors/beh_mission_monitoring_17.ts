// beh_mission_monitoring_17
//
// Behavioral policy for using mission_control on long-horizon tasks.
//
// Core clauses (all enforced/asserted below):
//  1. Maintain explicit mission state: ordered milestones each with success criteria.
//  2. After each milestone (or on interruption) re-evaluate progress and remaining
//     preconditions before advancing.
//  3. Checkpoint verified progress durably so work is resumable.
//  4. Do NOT discard completed, verified milestones when replanning — replan revises
//     only the failed/remaining portion.
//  5. Re-verify on drift before acting; irreversible/state-changing milestones route
//     through the canonical HITL approval surface.
//  6. Prefer a structured failure over an unbounded replan loop when budget/info runs out.
//
// This module provides pure, dependency-free helpers so it is safe to run in CI.

export const BEHAVIOR_ID = 'beh_mission_monitoring_17' as const;

/** Risk tiers per the four-tier risk model. */
export type RiskTier = 'read_only' | 'reversible' | 'external' | 'irreversible';

/** Only external + irreversible tiers require mandatory HITL approval. */
export const HITL_REQUIRED_TIERS: readonly RiskTier[] = ['external', 'irreversible'];

export type MilestoneStatus = 'pending' | 'active' | 'verified' | 'failed' | 'skipped';

export interface SuccessCriterion {
  /** Stable id for the criterion. */
  id: string;
  /** Human/agent readable description of what must be true. */
  description: string;
  /** Whether this criterion has been checked and satisfied. */
  satisfied: boolean;
}

export interface Milestone {
  id: string;
  /** 0-based ordering position within the mission. */
  order: number;
  description: string;
  riskTier: RiskTier;
  status: MilestoneStatus;
  successCriteria: SuccessCriterion[];
  /** Set once verified so a resume runs the milestone exactly once. */
  idempotencyKey?: string;
}

export interface MissionState {
  missionId: string;
  milestones: Milestone[];
  /** Number of replan attempts consumed so far. */
  replanAttempts: number;
  /** Hard cap on replan attempts before structured failure. */
  replanCap: number;
}

/** Structured failure returned instead of looping unbounded. */
export interface StructuredFailure {
  ok: false;
  reason: 'replan_cap_exceeded' | 'budget_exhausted' | 'information_exhausted';
  missionId: string;
  /** Milestones that were verified before failure — preserved, resumable. */
  verifiedMilestoneIds: string[];
  /** The milestone the mission was stuck on, if any. */
  stuckMilestoneId?: string;
  message: string;
}

/** Re-validation checklist evaluated on resume / before advancing. */
export interface RevalidationChecklist {
  sourceFresh: boolean;
  dataUnchanged: boolean;
  policyVersionMatches: boolean;
  identityValid: boolean;
  /** Hash of the proposed action captured at interrupt time. */
  proposedActionHash?: string;
  /** Hash recomputed at resume time. */
  liveActionHash?: string;
}

/**
 * A milestone is 'verified' (not merely 'attempted') iff every success criterion
 * is satisfied. Empty criteria cannot be verified — that would checkpoint bad state.
 */
export function isMilestoneVerified(m: Milestone): boolean {
  if (m.successCriteria.length === 0) return false;
  return m.successCriteria.every((c) => c.satisfied);
}

/** Whether a milestone's risk tier mandates HITL approval before acting. */
export function requiresHitlApproval(tier: RiskTier): boolean {
  return HITL_REQUIRED_TIERS.includes(tier);
}

/**
 * Evaluate the re-validation checklist. Drift is detected if any freshness/policy/
 * identity check fails, or if the proposed action hash diverges from the live hash.
 */
export function hasDrifted(checklist: RevalidationChecklist): boolean {
  if (!checklist.sourceFresh) return true;
  if (!checklist.dataUnchanged) return true;
  if (!checklist.policyVersionMatches) return true;
  if (!checklist.identityValid) return true;
  if (
    checklist.proposedActionHash !== undefined &&
    checklist.liveActionHash !== undefined &&
    checklist.proposedActionHash !== checklist.liveActionHash
  ) {
    return true;
  }
  return false;
}

export interface AdvanceDecision {
  /** Whether the agent may act on this milestone now. */
  canAdvance: boolean;
  /** Whether the step must be routed through the HITL surface first. */
  requiresApproval: boolean;
  /** Whether re-verification is needed before acting (drift or risky tier). */
  mustReverify: boolean;
  reasons: string[];
}

/**
 * Decide whether the agent may advance on `milestone`, given the current
 * re-validation checklist. Encodes clause (2) + (5): re-verify on drift or for
 * irreversible/state-changing steps, and route those through HITL.
 *
 * Gating is deliberately NOT applied to read_only / reversible tiers with no drift,
 * to avoid confirmation fatigue.
 */
export function decideAdvance(
  milestone: Milestone,
  checklist: RevalidationChecklist,
): AdvanceDecision {
  const reasons: string[] = [];
  const drifted = hasDrifted(checklist);
  const risky = requiresHitlApproval(milestone.riskTier);

  if (drifted) reasons.push('external_state_drifted');
  if (risky) reasons.push(`risk_tier_${milestone.riskTier}`);

  const mustReverify = drifted || risky;
  const requiresApproval = risky || (drifted && milestone.riskTier === 'external');

  // If reverification is needed but drift is present, we cannot advance until
  // the caller re-verifies (and, for risky steps, obtains approval).
  const canAdvance = !mustReverify;

  if (!canAdvance) {
    reasons.push('advance_blocked_pending_reverification');
  }

  return { canAdvance, requiresApproval, mustReverify, reasons };
}

/**
 * Produce a durable, resumable checkpoint of mission state. Only verified
 * milestones are stamped with an idempotency key so a resume runs each verified
 * milestone exactly once even if approval retries.
 */
export function checkpoint(state: MissionState): MissionState {
  const milestones = state.milestones.map((m) => {
    if (isMilestoneVerified(m)) {
      return {
        ...m,
        status: 'verified' as MilestoneStatus,
        idempotencyKey:
          m.idempotencyKey ?? `${state.missionId}:${m.id}:${m.order}`,
      };
    }
    return { ...m };
  });
  return { ...state, milestones };
}

/**
 * Replan: revise only the failed/remaining portion. Verified milestones are
 * preserved untouched (clause 4). Returns a new state with an incremented
 * replan attempt count, or a StructuredFailure when the replan cap is hit
 * (clause 6).
 */
export function replan(
  state: MissionState,
  revisedRemaining: Milestone[],
): MissionState | StructuredFailure {
  const verified = state.milestones.filter(isMilestoneVerified);
  const verifiedIds = verified.map((m) => m.id);

  if (state.replanAttempts >= state.replanCap) {
    const stuck = state.milestones.find(
      (m) => m.status === 'failed' || m.status === 'active',
    );
    return {
      ok: false,
      reason: 'replan_cap_exceeded',
      missionId: state.missionId,
      verifiedMilestoneIds: verifiedIds,
      stuckMilestoneId: stuck?.id,
      message: `Replan cap (${state.replanCap}) exceeded; ${verifiedIds.length} verified milestone(s) preserved.`,
    };
  }

  // Never re-plan over verified milestones.
  const revisedFiltered = revisedRemaining.filter(
    (m) => !verifiedIds.includes(m.id),
  );

  const combined = [...verified, ...revisedFiltered]
    .slice()
    .sort((a, b) => a.order - b.order);

  return {
    ...state,
    milestones: combined,
    replanAttempts: state.replanAttempts + 1,
  };
}

/** Build a structured failure for budget/info exhaustion (clause 6). */
export function failStructured(
  state: MissionState,
  reason: 'budget_exhausted' | 'information_exhausted',
  stuckMilestoneId?: string,
): StructuredFailure {
  const verifiedIds = state.milestones.filter(isMilestoneVerified).map((m) => m.id);
  return {
    ok: false,
    reason,
    missionId: state.missionId,
    verifiedMilestoneIds: verifiedIds,
    stuckMilestoneId,
    message: `Mission halted (${reason}); ${verifiedIds.length} verified milestone(s) preserved and resumable.`,
  };
}

export function isStructuredFailure(
  x: MissionState | StructuredFailure,
): x is StructuredFailure {
  return (x as StructuredFailure).ok === false;
}

/** Canonical behavior descriptor registered in the behaviors registry. */
export const beh_mission_monitoring_17 = {
  id: BEHAVIOR_ID,
  description:
    'For long-horizon tasks, maintain explicit mission state of ordered milestones with success criteria; re-evaluate progress and remaining preconditions before advancing; checkpoint verified progress durably so work is resumable; never discard verified milestones when replanning (revise only failed/remaining portion); re-verify on drift and route irreversible/state-changing steps through the canonical HITL surface; prefer structured failure over an unbounded replan loop.',
  hitlRequiredTiers: HITL_REQUIRED_TIERS,
} as const;

export default beh_mission_monitoring_17;
