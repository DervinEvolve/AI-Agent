import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assessUncertainty,
  calibrateConfidence,
  evaluateCalibrationMetrics,
  propagateUncertainty,
} from "../cap_uncertainty_quantification_and_calibration_23";

describe("cap_uncertainty_quantification_and_calibration_23 deterministic metrics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("assessUncertainty returns calibrated_confidence from deterministic evidence completeness and consistency", () => {
    const consistencyScore = vi.fn(() => 0.25);

    const result = assessUncertainty(
      {
        prior_confidence: 0.8,
        valid_evidence_count: 3,
        required_evidence_count: 4,
      },
      { consistencyScore },
    );

    expect(consistencyScore).toHaveBeenCalledTimes(1);
    expect(result.evidence_completeness).toBe(0.75);
    expect(result.consistency_score).toBe(0.25);
    expect(result.calibrated_confidence).toBeCloseTo(0.44, 12);
    expect(result.validation_status).toBe("validated");
    expect(result.tainted).toBe(false);
  });

  it("assessUncertainty defaults non-positive required evidence to 1 and clamps confidence inputs", () => {
    const result = assessUncertainty({
      prior_confidence: 2,
      valid_evidence_count: 2,
      required_evidence_count: 0,
      consistency_score: 2,
    });

    expect(result.evidence_completeness).toBe(1);
    expect(result.consistency_score).toBe(1);
    expect(result.calibrated_confidence).toBe(1);
  });

  it("tainted evidence forces tainted status and applies the tainted source reliability ceiling", () => {
    const result = assessUncertainty(
      {
        prior_confidence: 1,
        valid_evidence_count: 1,
        required_evidence_count: 1,
        evidence: [{ id: "fixture", valid: true, tainted: true }],
      },
      { consistencyScore: () => 1 },
    );

    expect(result.tainted).toBe(true);
    expect(result.validation_status).toBe("tainted");
    expect(result.source_reliability_ceiling).toBeLessThanOrEqual(0.65);
    expect(result.calibrated_confidence).toBeCloseTo(0.65, 12);
  });

  it("calibrateConfidence reduces confidence for stale evidence, contradictions, and poor historical calibration", () => {
    const result = calibrateConfidence({
      prior_confidence: 0.8,
      ece: 0.4,
      evidence_freshness: "stale",
      unresolved_contradictions: true,
      source_tainted: true,
    });

    expect(result.historical_factor).toBeCloseTo(0.6, 12);
    expect(result.freshness_factor).toBe(0.75);
    expect(result.contradiction_factor).toBe(0.5);
    expect(result.source_reliability_ceiling).toBe(0.65);
    expect(result.calibrated_confidence).toBeCloseTo(0.117, 12);
    expect(result.validation_status).toBe("tainted");
  });

  it("propagateUncertainty marks downstream steps with inherited uncertainty and cascading risk", () => {
    const result = propagateUncertainty({
      dependencies: [
        { id: "high", calibrated_confidence: 0.9 },
        { id: "low", calibrated_confidence: 0.6 },
      ],
      local_step_confidence: 0.8,
    });

    expect(result.downstream_confidence).toBeCloseTo(0.48, 12);
    expect(result.cascading_risk).toBeCloseTo(0.52, 12);
    expect(result.inherited_uncertainty).toBe(true);
    expect(result.validation_status).toBe("inherited_uncertainty");
    expect(result.low_confidence_dependencies).toEqual([{ id: "low", calibrated_confidence: 0.6 }]);
  });

  it("evaluateCalibrationMetrics computes deterministic Brier score and equal-width-bin ECE", () => {
    const result = evaluateCalibrationMetrics(
      [
        { predicted_confidence: 0.1, outcome: 0 },
        { predicted_confidence: 0.4, outcome: 1 },
        { predicted_confidence: 0.8, outcome: 1 },
        { predicted_confidence: 1.0, outcome: 1 },
      ],
      2,
    );

    expect(result.status).toBe("evaluated");
    expect(result.sample_count).toBe(4);
    expect(result.brier_score).toBeCloseTo(0.1025, 12);
    expect(result.ece).toBeCloseTo(0.175, 12);
    expect(result.bins[0]).toMatchObject({ count: 2, mean_confidence: 0.25, accuracy: 0.5 });
    expect(result.bins[1]).toMatchObject({ count: 2, mean_confidence: 0.9, accuracy: 1 });
  });

  it("evaluateCalibrationMetrics returns unverifiable for empty input instead of NaN", () => {
    const result = evaluateCalibrationMetrics([]);

    expect(result.status).toBe("unverifiable");
    expect(result.sample_count).toBe(0);
    expect(result.brier_score).toBeNull();
    expect(result.ece).toBeNull();
    expect(result.bins).toEqual([]);
  });
});
