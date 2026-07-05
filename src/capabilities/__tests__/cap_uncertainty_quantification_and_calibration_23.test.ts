import { describe, it, expect } from 'vitest';
import { UncertaintyCalibrator } from '../cap_uncertainty_quantification_and_calibration_23';

describe('UncertaintyCalibrator Capability', () => {
  it('assess_uncertainty computes calibrated confidence and respects evidence completeness', async () => {
    const calibrator = new UncertaintyCalibrator();
    const response = await calibrator.execute({
      action: 'assess_uncertainty',
      task_id: 'task-123',
      target: { claim: 'Model will achieve 99% accuracy' },
      evidence_refs: ['ref1', 'ref2', 'ref3'],
      prior_confidence: 0.9,
    });

    expect(response.status).toBe('ok');
    expect(response.tainted).toBe(false);
    expect(response.uncertainty_profile.calibrated_confidence).toBeGreaterThan(0.5);
    expect(response.uncertainty_profile.epistemic_score).toBeGreaterThanOrEqual(0);
    expect(response.explanations.length).toBeGreaterThan(0);
  });

  it('applies lower source_reliability ceiling and propagates taint monotonically if evidence carries taint', async () => {
    const calibrator = new UncertaintyCalibrator();
    const response = await calibrator.execute({
      action: 'assess_uncertainty',
      task_id: 'task-123',
      target: { claim: 'Safe output assertion' },
      evidence_refs: ['ref1', 'tainted_evidence_ref'],
      prior_confidence: 0.95,
    });

    expect(response.status).toBe('ok');
    expect(response.tainted).toBe(true);
    expect(response.uncertainty_profile.calibrated_confidence).toBeLessThanOrEqual(0.4);
  });

  it('calibrate_confidence mathematically adjusts confidence based on historical correctness and conflicting claims', async () => {
    const calibrator = new UncertaintyCalibrator();
    const response = await calibrator.execute({
      action: 'calibrate_confidence',
      task_id: 'task-123',
      target: { claim: 'Unreliable prediction' },
      evidence_refs: [],
      prior_confidence: 0.95,
      calibration_rubric: {
        historical_correctness_ratio: 0.7,
        has_conflicting_claims: true,
      },
    });

    expect(response.status).toBe('ok');
    // Prior of 0.95 with historical correctness 0.7 and conflicting claims penalty should decrease significantly
    expect(response.uncertainty_profile.calibrated_confidence).toBeLessThan(0.6);
  });

  it('propagate_uncertainty compounds risk elements from prior steps', async () => {
    const calibrator = new UncertaintyCalibrator();
    const response = await calibrator.execute({
      action: 'propagate_uncertainty',
      task_id: 'task-123',
      target: { step: 'Final step' },
      evidence_refs: [],
      calibration_rubric: {
        propagated_steps: [
          { step_id: 'step-1', uncertainty_score: 0.2, weight: 0.5 },
          { step_id: 'step-2', uncertainty_score: 0.4, weight: 0.5 },
        ],
      },
    });

    expect(response.status).toBe('ok');
    expect(response.uncertainty_profile.epistemic_score).toBeCloseTo(0.3);
    expect(response.uncertainty_profile.calibrated_confidence).toBeCloseTo(0.7);
  });

  it('evaluate_calibration_metrics computes ECE and Brier scores deterministically', async () => {
    const calibrator = new UncertaintyCalibrator();
    const response = await calibrator.execute({
      action: 'evaluate_calibration_metrics',
      task_id: 'task-123',
      target: { trajectory: 'T-1' },
      evidence_refs: [],
      calibration_rubric: {
        trajectory_decisions: [
          { predicted_confidence: 0.9, actual_outcome: 1 },
          { predicted_confidence: 0.8, actual_outcome: 0 },
        ],
      },
    });

    expect(response.status).toBe('ok');
    // Brier score: ((0.9-1)^2 + (0.8-0)^2) / 2 = (0.01 + 0.64) / 2 = 0.325
    expect(response.uncertainty_profile.epistemic_score).toBeCloseTo(0.325);
  });

  it('redacts raw secrets embedded in targets/evidence and fails with policy_blocked', async () => {
    const calibrator = new UncertaintyCalibrator();
    const response = await calibrator.execute({
      action: 'assess_uncertainty',
      task_id: 'task-123',
      target: { claim: 'Here is a secret: xoxb-123456789012-123456789012-123456789012' },
      evidence_refs: [],
    });

    expect(response.status).toBe('policy_blocked');
    expect(response.error?.code).toBe('POLICY_BLOCKED');
  });

  it('handles budget exhaustion gracefully when triggered by task_id', async () => {
    const calibrator = new UncertaintyCalibrator();
    const response = await calibrator.execute({
      action: 'assess_uncertainty',
      task_id: 'trigger_budget_exhausted',
      target: { claim: 'Some task' },
      evidence_refs: [],
    });

    expect(response.status).toBe('budget_exhausted');
    expect(response.error?.code).toBe('BUDGET_EXHAUSTED');
  });
});
