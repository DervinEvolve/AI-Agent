import { describe, it, expect, beforeEach } from 'vitest';
import {
  ProceduralMemorySkillLibrary,
  UncertaintyCalibrator,
  DryRunResult,
  SkillDefinition
} from '../cap_procedural_memory_skill_library_14';
import { LongTermMemory } from '../cap_long_term_memory_3';
import { ToolRegistry } from '../cap_dynamic_tool_invention_6';

describe('UncertaintyCalibrator', () => {
  it('should calibrate highly consistent dry runs to a high confidence score and mark eligible', () => {
    const dryRuns: DryRunResult[] = [
      { success: true, executionTimeMs: 120, semanticDriftScore: 0.05, outputMatchesSchema: true },
      { success: true, executionTimeMs: 125, semanticDriftScore: 0.02, outputMatchesSchema: true },
      { success: true, executionTimeMs: 118, semanticDriftScore: 0.04, outputMatchesSchema: true },
      { success: true, executionTimeMs: 122, semanticDriftScore: 0.06, outputMatchesSchema: true },
      { success: true, executionTimeMs: 121, semanticDriftScore: 0.03, outputMatchesSchema: true }
    ];

    const result = UncertaintyCalibrator.calibrate(dryRuns);
    expect(result.isEligible).toBe(true);
    expect(result.calibratedConfidence).toBeGreaterThanOrEqual(0.85);
    expect(result.metrics.successRate).toBe(1.0);
    expect(result.metrics.schemaComplianceRate).toBe(1.0);
    expect(result.metrics.entropy).toBe(0);
  });

  it('should reject skills with poor success rates', () => {
    const dryRuns: DryRunResult[] = [
      { success: false, executionTimeMs: 150, semanticDriftScore: 0.5, outputMatchesSchema: true },
      { success: true, executionTimeMs: 120, semanticDriftScore: 0.1, outputMatchesSchema: true },
      { success: true, executionTimeMs: 125, semanticDriftScore: 0.1, outputMatchesSchema: true }
    ];

    const result = UncertaintyCalibrator.calibrate(dryRuns);
    expect(result.isEligible).toBe(false);
    expect(result.calibratedConfidence).toBeLessThan(0.80);
  });

  it('should reject skills with high semantic drift or poor schema compliance', () => {
    const dryRuns: DryRunResult[] = [
      { success: true, executionTimeMs: 120, semanticDriftScore: 0.6, outputMatchesSchema: false },
      { success: true, executionTimeMs: 125, semanticDriftScore: 0.5, outputMatchesSchema: true },
      { success: true, executionTimeMs: 118, semanticDriftScore: 0.7, outputMatchesSchema: true }
    ];

    const result = UncertaintyCalibrator.calibrate(dryRuns);
    expect(result.isEligible).toBe(false);
  });
});

describe('ProceduralMemorySkillLibrary', () => {
  let memory: LongTermMemory;
  let toolRegistry: ToolRegistry;
  let library: ProceduralMemorySkillLibrary;

  beforeEach(() => {
    memory = new LongTermMemory();
    toolRegistry = new ToolRegistry();
    library = new ProceduralMemorySkillLibrary(memory, toolRegistry);
  });

  it('should allow proposing, calibrating, and promoting a procedural skill', async () => {
    const skillCandidate = {
      id: 'fetch_user_data',
      name: 'Fetch User Data',
      description: 'Fetches user details from backend safely',
      scope: 'user_management',
      provenance: 'task_success_reflection_epoch_14',
      taintFlags: [],
      immutableSuccessCriteria: 'Returns valid JSON with user fields',
      preconditions: ['authenticated'],
      inputSchema: { type: 'object', properties: { userId: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      steps: [
        { type: 'run_python' as const, action: 'print("fetching user")' }
      ]
    };

    library.proposeCandidate(skillCandidate);
    expect(library.getCandidateSkill('fetch_user_data')).toBeDefined();

    const successfulDryRuns: DryRunResult[] = [
      { success: true, executionTimeMs: 45, semanticDriftScore: 0.01, outputMatchesSchema: true },
      { success: true, executionTimeMs: 50, semanticDriftScore: 0.02, outputMatchesSchema: true },
      { success: true, executionTimeMs: 48, semanticDriftScore: 0.01, outputMatchesSchema: true }
    ];

    const promotionResult = await library.evaluateAndPromote('fetch_user_data', successfulDryRuns);
    expect(promotionResult.promoted).toBe(true);
    expect(promotionResult.calibratedConfidence).toBeGreaterThanOrEqual(0.85);

    // Check active library and memory persistence
    const activeSkill = library.getActiveSkill('fetch_user_data');
    expect(activeSkill).toBeDefined();
    expect(activeSkill?.verificationEvidence.calibratedConfidence).toBe(promotionResult.calibratedConfidence);

    const searchResult = await library.searchSkills('User Data');
    expect(searchResult.length).toBeGreaterThanOrEqual(1);
    expect(searchResult[0].id).toBe('fetch_user_data');

    // Verify deletion
    await library.deleteSkill('fetch_user_data');
    expect(library.getActiveSkill('fetch_user_data')).toBeUndefined();
  });
});
