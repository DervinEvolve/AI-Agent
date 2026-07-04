import { describe, it, expect } from 'vitest';
import {
  HITL_REQUIRED_TIERS,
  requiresHitlApproval,
  type RiskTier,
} from '../beh_mission_monitoring_17';

// This test locks in the cross-invariant that `requiresHitlApproval` is exactly
// membership in `HITL_REQUIRED_TIERS` for every tier in the four-tier risk model.
// It is intentionally derived from the two exports rather than restating hard-coded
// expected booleans, so it stays correct if the tier set is ever revised together
// with the predicate.
const ALL_TIERS: readonly RiskTier[] = [
  'read_only',
  'reversible',
  'external',
  'irreversible',
];

describe('beh_mission_monitoring_17 HITL membership invariant', () => {
  it('requiresHitlApproval agrees with HITL_REQUIRED_TIERS membership for every tier', () => {
    for (const tier of ALL_TIERS) {
      const expected = HITL_REQUIRED_TIERS.includes(tier);
      expect(requiresHitlApproval(tier)).toBe(expected);
    }
  });

  it('requires HITL for at least one tier but not all tiers (real gating, not a rubber stamp)', () => {
    const gated = ALL_TIERS.filter((t) => requiresHitlApproval(t));
    expect(gated.length).toBeGreaterThan(0);
    expect(gated.length).toBeLessThan(ALL_TIERS.length);
  });

  it('never gates the read_only tier', () => {
    // A read-only step must never be forced through human approval.
    expect(requiresHitlApproval('read_only')).toBe(false);
    expect(HITL_REQUIRED_TIERS).not.toContain('read_only');
  });
});
