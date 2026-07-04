import { describe, it, expect } from 'vitest';
import beh_mission_monitoring_17, {
  BEHAVIOR_ID,
  HITL_REQUIRED_TIERS,
  isMilestoneVerified,
  requiresHitlApproval,
  hasDrifted,
  decideAdvance,
  checkpoint,
  replan,
  failStructured,
  isStructuredFailure,
  type Milestone,
  type MissionState,
  type RevalidationChecklist,
} from '../beh_mission_monitoring_17';

const freshChecklist: RevalidationChecklist = {
  sourceFresh: true,
  dataUnchanged: true,
  policyVersionMatches: true,
  identityValid: true,
};

function milestone(over: Partial<Milestone> = {}): Milestone {
  return {
    id: 'm1',
    order: 0,
    description: 'do a thing',
    riskTier: 'reversible',
    status: 'active',
    successCriteria: [{ id: 'c1', description: 'done', satisfied: true }],
    ...over,
  };
}

describe('beh_mission_monitoring_17 descriptor', () => {
  it('exposes the canonical id and matching descriptor', () => {
    expect(BEHAVIOR_ID).toBe('beh_mission_monitoring_17');
    expect(beh_mission_monitoring_17.id).toBe('beh_mission_monitoring_17');
    expect(beh_mission_monitoring_17.description.length).toBeGreaterThan(20);
  });

  it('only requires HITL for external and irreversible tiers', () => {
    expect(HITL_REQUIRED_TIERS).toEqual(['external', 'irreversible']);
    expect(requiresHitlApproval('read_only')).toBe(false);
    expect(requiresHitlApproval('reversible')).toBe(false);
    expect(requiresHitlApproval('external')).toBe(true);
    expect(requiresHitlApproval('irreversible')).toBe(true);
  });
});

describe('milestone verification (verified vs attempted)', () => {
  it('is verified only when all criteria satisfied', () => {
    expect(isMilestoneVerified(milestone())).toBe(true);
    expect(
      isMilestoneVerified(
        milestone({
          successCriteria: [
            { id: 'c1', description: 'a', satisfied: true },
            { id: 'c2', description: 'b', satisfied: false },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('cannot verify a milestone with no criteria (no bad-state checkpoint)', () => {
    expect(isMilestoneVerified(milestone({ successCriteria: [] }))).toBe(false);
  });
});

describe('drift detection', () => {
  it('reports no drift on a clean checklist', () => {
    expect(hasDrifted(freshChecklist)).toBe(false);
  });

  it('detects freshness/policy/identity drift', () => {
    expect(hasDrifted({ ...freshChecklist, sourceFresh: false })).toBe(true);
    expect(hasDrifted({ ...freshChecklist, dataUnchanged: false })).toBe(true);
    expect(hasDrifted({ ...freshChecklist, policyVersionMatches: false })).toBe(true);
    expect(hasDrifted({ ...freshChecklist, identityValid: false })).toBe(true);
  });

  it('detects action-hash divergence at resume', () => {
    expect(
      hasDrifted({ ...freshChecklist, proposedActionHash: 'a', liveActionHash: 'b' }),
    ).toBe(true);
    expect(
      hasDrifted({ ...freshChecklist, proposedActionHash: 'a', liveActionHash: 'a' }),
    ).toBe(false);
  });
});

describe('advance decision (re-verify + HITL routing)', () => {
  it('allows reversible read-only steps with no drift (avoids confirmation fatigue)', () => {
    const d = decideAdvance(milestone({ riskTier: 'reversible' }), freshChecklist);
    expect(d.canAdvance).toBe(true);
    expect(d.requiresApproval).toBe(false);
    expect(d.mustReverify).toBe(false);
  });

  it('blocks and requires approval for irreversible steps', () => {
    const d = decideAdvance(milestone({ riskTier: 'irreversible' }), freshChecklist);
    expect(d.mustReverify).toBe(true);
    expect(d.requiresApproval).toBe(true);
    expect(d.canAdvance).toBe(false);
    expect(d.reasons).toContain('risk_tier_irreversible');
  });

  it('requires reverification when external state drifted', () => {
    const d = decideAdvance(
      milestone({ riskTier: 'reversible' }),
      { ...freshChecklist, sourceFresh: false },
    );
    expect(d.mustReverify).toBe(true);
    expect(d.canAdvance).toBe(false);
    expect(d.reasons).toContain('external_state_drifted');
  });
});

describe('durable checkpointing with idempotency keys', () => {
  it('stamps idempotency keys on verified milestones only', () => {
    const state: MissionState = {
      missionId: 'mission-x',
      replanAttempts: 0,
      replanCap: 3,
      milestones: [
        milestone({ id: 'a', order: 0 }),
        milestone({
          id: 'b',
          order: 1,
          successCriteria: [{ id: 'c', description: 'x', satisfied: false }],
        }),
      ],
    };
    const cp = checkpoint(state);
    const a = cp.milestones.find((m) => m.id === 'a')!;
    const b = cp.milestones.find((m) => m.id === 'b')!;
    expect(a.idempotencyKey).toBe('mission-x:a:0');
    expect(a.status).toBe('verified');
    expect(b.idempotencyKey).toBeUndefined();
  });

  it('keeps existing idempotency keys stable across re-checkpoints (runs exactly once)', () => {
    const state: MissionState = {
      missionId: 'mission-x',
      replanAttempts: 0,
      replanCap: 3,
      milestones: [milestone({ id: 'a', order: 0, idempotencyKey: 'preset-key' })],
    };
    expect(checkpoint(state).milestones[0].idempotencyKey).toBe('preset-key');
  });
});

describe('bounded replan preserves verified milestones', () => {
  it('never discards verified milestones and only revises the remainder', () => {
    const state: MissionState = {
      missionId: 'm',
      replanAttempts: 0,
      replanCap: 3,
      milestones: [
        milestone({ id: 'done', order: 0 }),
        milestone({
          id: 'failed',
          order: 1,
          status: 'failed',
          successCriteria: [{ id: 'c', description: 'x', satisfied: false }],
        }),
      ],
    };
    const result = replan(state, [
      milestone({
        id: 'newstep',
        order: 1,
        status: 'pending',
        successCriteria: [{ id: 'c', description: 'x', satisfied: false }],
      }),
    ]);
    expect(isStructuredFailure(result)).toBe(false);
    const s = result as MissionState;
    const ids = s.milestones.map((m) => m.id);
    expect(ids).toContain('done');
    expect(ids).toContain('newstep');
    expect(s.replanAttempts).toBe(1);
  });

  it('returns structured failure when replan cap exceeded', () => {
    const state: MissionState = {
      missionId: 'm',
      replanAttempts: 3,
      replanCap: 3,
      milestones: [
        milestone({ id: 'done', order: 0 }),
        milestone({
          id: 'stuck',
          order: 1,
          status: 'failed',
          successCriteria: [{ id: 'c', description: 'x', satisfied: false }],
        }),
      ],
    };
    const result = replan(state, []);
    expect(isStructuredFailure(result)).toBe(true);
    const f = result as ReturnType<typeof failStructured>;
    expect(f.reason).toBe('replan_cap_exceeded');
    expect(f.verifiedMilestoneIds).toEqual(['done']);
    expect(f.stuckMilestoneId).toBe('stuck');
  });
});

describe('structured failure over unbounded loop', () => {
  it('emits a structured failure on budget exhaustion, preserving verified work', () => {
    const state: MissionState = {
      missionId: 'm',
      replanAttempts: 1,
      replanCap: 3,
      milestones: [milestone({ id: 'done', order: 0 })],
    };
    const f = failStructured(state, 'budget_exhausted', 'next');
    expect(f.ok).toBe(false);
    expect(f.reason).toBe('budget_exhausted');
    expect(f.verifiedMilestoneIds).toEqual(['done']);
    expect(f.stuckMilestoneId).toBe('next');
    expect(f.message).toMatch(/resumable/);
  });
});
