import { describe, it, expect } from 'vitest';
import { MetacognitiveRouter } from '../../agent_controller/metacognitive_router';
import type { UncertaintySignal } from '../cap_uncertainty_quantification_and_calibration_23';

describe('cap_metacognitive_routing_30', () => {
  const router = new MetacognitiveRouter();
  const lowUnc: UncertaintySignal = { value: 0.2 };
  const highUnc: UncertaintySignal = { value: 0.85 };

  it('router never downgrades effort on HITL-gated or high-uncertainty consequential steps', () => {
    const dec = router.route(3, highUnc, true, true, { remaining: 500 });
    expect(dec.effortLevel).toBeGreaterThanOrEqual(8);
    expect(dec.advisory).toBe(true);
  });

  it('routing decisions are advisory only and do not authorize actions or clear taint', () => {
    const dec = router.route(5, lowUnc, false, false, { remaining: 200 });
    expect(dec.advisory).toBe(true);
    // no side effects or authority
  });

  it('router composes with uncertainty_calibrator and BudgetTracker without creating authority paths', () => {
    const dec = router.route(4, highUnc, false, true, { remaining: 50 });
    expect(dec.effortLevel).toBeGreaterThanOrEqual(8);
    expect(dec.advisory).toBe(true);
  });
});
