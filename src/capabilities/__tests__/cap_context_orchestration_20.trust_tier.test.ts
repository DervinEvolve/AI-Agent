import { describe, it, expect } from 'vitest';
import { TRUST_TIER, AUTO_PIN_KINDS } from '../cap_context_orchestration_20';

// These tests exercise the two fully-specified, foundational invariants of the
// context orchestration capability:
//   1. Trust-tier ordering (lower number == higher authority), which the
//      layout logic relies on to guarantee system/policy > goal/requirements >
//      validated evidence > tainted observations.
//   2. Auto-pin kind membership, which guarantees immutable requirements and
//      system_policy items can never be evicted or weakened.

describe('TRUST_TIER ordering invariant', () => {
  it('assigns strictly increasing tier numbers from highest to lowest authority', () => {
    // Lower number == higher authority.
    expect(TRUST_TIER.SYSTEM_POLICY).toBeLessThan(TRUST_TIER.GOAL_REQUIREMENT);
    expect(TRUST_TIER.GOAL_REQUIREMENT).toBeLessThan(TRUST_TIER.VALIDATED_EVIDENCE);
    expect(TRUST_TIER.VALIDATED_EVIDENCE).toBeLessThan(TRUST_TIER.TAINTED);
  });

  it('places system/policy at the top (0) and tainted at the bottom', () => {
    const tiers = [
      TRUST_TIER.SYSTEM_POLICY,
      TRUST_TIER.GOAL_REQUIREMENT,
      TRUST_TIER.VALIDATED_EVIDENCE,
      TRUST_TIER.TAINTED,
    ];
    expect(TRUST_TIER.SYSTEM_POLICY).toBe(Math.min(...tiers));
    expect(TRUST_TIER.TAINTED).toBe(Math.max(...tiers));
  });

  it('has four distinct tiers', () => {
    const tiers = new Set([
      TRUST_TIER.SYSTEM_POLICY,
      TRUST_TIER.GOAL_REQUIREMENT,
      TRUST_TIER.VALIDATED_EVIDENCE,
      TRUST_TIER.TAINTED,
    ]);
    expect(tiers.size).toBe(4);
  });

  it('guarantees tainted observations can never outrank validated evidence', () => {
    // Central safety property: a tainted item's tier is always numerically
    // greater (lower authority) than any validated-evidence item.
    expect(TRUST_TIER.TAINTED > TRUST_TIER.VALIDATED_EVIDENCE).toBe(true);
  });
});

describe('AUTO_PIN_KINDS membership', () => {
  it('always auto-pins immutable requirements and system policy', () => {
    expect(AUTO_PIN_KINDS.has('requirement')).toBe(true);
    expect(AUTO_PIN_KINDS.has('system_policy')).toBe(true);
  });

  it('does not auto-pin freely-evictable candidate kinds', () => {
    // Observations, memory, and skills are subject to scoring/eviction and must
    // NOT be forcibly pinned.
    expect(AUTO_PIN_KINDS.has('observation')).toBe(false);
    expect(AUTO_PIN_KINDS.has('memory')).toBe(false);
    expect(AUTO_PIN_KINDS.has('skill')).toBe(false);
  });
});
