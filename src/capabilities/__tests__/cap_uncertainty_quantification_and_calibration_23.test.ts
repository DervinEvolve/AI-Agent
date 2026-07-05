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
        historical_correctness_ratio: 0.6,
        has_conflicting_claims: true,
        freshness_penalty: 0.2
      }
    });

    expect(response.status).toBe('ok');
    expect(response.uncertainty_profile.calibrated_confidence).toBeLessThan(0.95);
  });

  it('propagate_uncertainty calculates downstream cascading risks', async () => {
    const calibrator = new UncertaintyCalibrator();
    const response = await calibrator.execute({
      action: 'propagate_uncertainty',
      task_id: 'task-123',
      target: { step: 'final_milestone' },
      evidence_refs: [],
      calibration_rubric: {
        propagated_steps: [
          { step_id: 'step_1', uncertainty_score: 0.8, weight: 0.5 },
          { step_id: 'step_2', uncertainty_score: 0.4, weight: 0.5 }
        ]
      }
    });

    expect(response.status).toBe('ok');
    expect(response.uncertainty_profile.epistemic_score).toBeGreaterThan(0.5);
    expect(response.explanations.some(e => e.includes('propagated') || e.includes('cascading'))).toBe(true);
  });

  it('evaluate_calibration_metrics computes Expected Calibration Error and Brier scores', async () => {
    const calibrator = new UncertaintyCalibrator();
    const response = await calibrator.execute({
      action: 'evaluate_calibration_metrics',
      task_id: 'task-123',
      target: {},
      evidence_refs: [],
      calibration_rubric: {
        trajectory_decisions: [
          { predicted_confidence: 0.9, actual_outcome: 1 },
          { predicted_confidence: 0.8, actual_outcome: 0 },
          { predicted_confidence: 0.2, actual_outcome: 0 }
        ]
      }
    });

    expect(response.status).toBe('ok');
    expect(response.uncertainty_profile.entropy).toBeGreaterThanOrEqual(0);
  });

  it('inspect_calibration_state returns current evaluator metadata', async () => {
    const calibrator = new UncertaintyCalibrator();
    const response = await calibrator.execute({
      action: 'inspect_calibration_state',
      task_id: 'task-123',
      target: {},
      evidence_refs: []
    });

    expect(response.status).toBe('ok');
    expect(response.provenance.evaluator_version).toBe('1.0.0');
  });

  it('redacts raw secrets and blocks execution via secret_redactor', async () => {
    const calibrator = new UncertaintyCalibrator();
    const response = await calibrator.execute({
      action: 'assess_uncertainty',
      task_id: 'task-123',
      target: { secret: 'sk-abcdef1234567890' },
      evidence_refs: []
    });

    expect(response.status).toBe('policy_blocked');
  });
});
