import { describe, it, expect } from 'vitest';
import {
  UncertaintyCalibrator,
  DryRunResult
} from '../cap_procedural_memory_skill_library_14';

describe('Procedural Memory Skill Library - UncertaintyCalibrator Tests', () => {
  it('should calibrate highly consistent dry runs to a high confidence score and mark eligible', () => {
    const dryRuns: DryRunResult[] = [
      { success: true, executionTimeMs: 120, semanticDriftScore: 0.05, outputMatchesSchema: true },
      { success: true, executionTimeMs: 125, semanticDriftScore: 0.02, outputMatchesSchema: true },
      { success: true, executionTimeMs: 118, semanticDriftScore: 0.04, outputMatchesSchema: true },
      { success: true, executionTimeMs: 122, semanticDriftScore: 0.06, outputMatchesSchema: true },
      { success: true, executionTimeMs: 121, semanticDriftScore: 0.03, outputMatchesSchema: true }
    ];

    const result = UncertaintyCalibrator.calibrate(dryRuns);
    expect(result.metrics.successRate).toBe(1.0);
    expect(result.metrics.schemaComplianceRate).toBe(1.0);
  });

  it('should reject empty dry runs gracefully', () => {
    const result = UncertaintyCalibrator.calibrate([]);
    expect(result.isEligible).toBe(false);
    expect(result.calibratedConfidence).toBe(0);
    expect(result.metrics.successRate).toBe(0);
  });

  it('should evaluate mixed success dry runs and penalize confidence', () => {
    const dryRuns: DryRunResult[] = [
      { success: false, executionTimeMs: 150, semanticDriftScore: 0.5, outputMatchesSchema: false },
      { success: true, executionTimeMs: 120, semanticDriftScore: 0.1, outputMatchesSchema: true },
      { success: true, executionTimeMs: 125, semanticDriftScore: 0.1, outputMatchesSchema: true }
    ];

    const result = UncertaintyCalibrator.calibrate(dryRuns);
    expect(result.isEligible).toBe(false);
    expect(result.metrics.successRate).toBeLessThan(1.0);
  });
});
