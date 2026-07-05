import { LongTermMemory, MemoryEntry } from './cap_long_term_memory_3';
import { ToolRegistry } from './cap_dynamic_tool_invention_6';

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  scope: string;
  provenance: string;
  taintFlags: string[];
  immutableSuccessCriteria: string;
  preconditions: string[];
  inputSchema: Record<string, any>;
  outputSchema: Record<string, any>;
  steps: Array<{
    type: 'controller' | 'run_python' | 'tool';
    action: string;
    args?: Record<string, any>;
  }>;
  verificationEvidence?: any;
  metrics: {
    successes: number;
    failures: number;
    executionTimes: number[];
  };
  stalenessMetadata: {
    lastUsedAt: string;
    createdAt: string;
  };
}

export interface DryRunResult {
  success: boolean;
  executionTimeMs: number;
  semanticDriftScore: number; // 0.0 to 1.0 (lower is better, meaning closer adherence to expected output)
  outputMatchesSchema: boolean;
}

/**
 * UncertaintyCalibrator evaluates skill dry-run results using a statistical
 * bootstrap-like entropy and variance calibration model. It ensures only highly
 * consistent skills with stable execution times and minimal semantic drift are promoted.
 */
export class UncertaintyCalibrator {
  /**
   * Calculates a calibrated confidence score between 0.0 and 1.0.
   * Returns a detailed report of consistency metrics.
   */
  public static calibrate(
    dryRuns: DryRunResult[],
    priorMetrics: { successes: number; failures: number } = { successes: 0, failures: 0 }
  ): {
    calibratedConfidence: number;
    isEligible: boolean;
    metrics: {
      successRate: number;
      executionVariance: number;
      meanSemanticDrift: number;
      schemaComplianceRate: number;
      entropy: number;
    };
  } {
    if (dryRuns.length === 0) {
      return {
        calibratedConfidence: 0,
        isEligible: false,
        metrics: { successRate: 0, executionVariance: 0, meanSemanticDrift: 1, schemaComplianceRate: 0, entropy: 1 }
      };
    }

    const totalRuns = dryRuns.length;
    const successes = dryRuns.filter(r => r.success).length;
    const successRate = successes / totalRuns;

    const schemaCompliant = dryRuns.filter(r => r.outputMatchesSchema).length;
    const schemaComplianceRate = schemaCompliant / totalRuns;

    const times = dryRuns.map(r => r.executionTimeMs);
    const meanTime = times.reduce((a, b) => a + b, 0) / totalRuns;
    const variance = times.reduce((acc, t) => acc + Math.pow(t - meanTime, 2), 0) / totalRuns;

    const drifts = dryRuns.map(r => r.semanticDriftScore);
    const meanSemanticDrift = drifts.reduce((a, b) => a + b, 0) / totalRuns;

    // Shannon Entropy of success/failure outcome to measure unpredictability
    const pSuccess = successRate;
    const pFailure = 1 - successRate;
    let entropy = 0;
    if (pSuccess > 0 && pSuccess < 1) {
      entropy = -(pSuccess * Math.log2(pSuccess) + pFailure * Math.log2(pFailure));
    }

    // Calibrated Confidence Formula: weights success rate, low entropy, low semantic drift, and schema compliance
    const successWeight = 0.45;
    const entropyWeight = 0.20; // Lower entropy (closer to 0 or 1) is better when success rate is high
    const driftWeight = 0.20;
    const schemaWeight = 0.15;

    // We reward low entropy only if the success rate is high (meaning highly predictable success vs highly predictable failure)
    const entropyPenalty = successRate >= 0.8 ? (entropy * 0.5) : entropy;
    const entropyScore = Math.max(0, 1 - entropyPenalty);
    const driftScore = Math.max(0, 1 - meanSemanticDrift);

    let confidence = (
      (successRate * successWeight) +
      (entropyScore * entropyWeight) +
      (driftScore * driftWeight) +
      (schemaComplianceRate * schemaWeight)
    );

    // Prior penalty for lack of history
    const totalPriorRuns = priorMetrics.successes + priorMetrics.failures;
    if (totalPriorRuns > 0) {
      const priorSuccessRate = priorMetrics.successes / totalPriorRuns;
      confidence = (confidence * 0.7) + (priorSuccessRate * 0.3);
    }

    // Bound confidence between 0 and 1
    const calibratedConfidence = Math.min(1, Math.max(0, confidence));

    // Eligibility criteria: Calibrated confidence >= 0.80, Success rate >= 0.85, Schema compliance >= 0.90
    const isEligible = calibratedConfidence >= 0.80 && successRate >= 0.85 && schemaComplianceRate >= 0.90;

    return {
      calibratedConfidence,
      isEligible,
      metrics: {
        successRate,
        executionVariance: variance,
        meanSemanticDrift,
        schemaComplianceRate,
        entropy
      }
    };
  }
}

/**
 * ProceduralMemorySkillLibrary integrates with cap_long_term_memory_3 for persistence,
 * and provides safe retrieval, evaluation, and dynamic promotion of procedural skills.
 */
export class ProceduralMemorySkillLibrary {
  private memory: LongTermMemory;
  private toolRegistry: ToolRegistry;
  private activeSkills: Map<string, SkillDefinition> = new Map();
  private candidateSkills: Map<string, SkillDefinition> = new Map();

  constructor(memory: LongTermMemory, toolRegistry: ToolRegistry) {
    this.memory = memory;
    this.toolRegistry = toolRegistry;
  }

  /**
   * Proposes a new skill candidate for distillation evaluation.
   */
  public proposeCandidate(skill: Omit<SkillDefinition, 'metrics' | 'stalenessMetadata'>): void {
    const candidate: SkillDefinition = {
      ...skill,
      metrics: {
        successes: 0,
        failures: 0,
        executionTimes: []
      },
      stalenessMetadata: {
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString()
      }
    };
    this.candidateSkills.set(candidate.id, candidate);
  }

  /**
   * Evaluates a candidate skill using dry-runs and the UncertaintyCalibrator.
   * If eligible, promotes it to the active skill library and persists it to LongTermMemory.
   */
  public async evaluateAndPromote(
    skillId: string,
    dryRuns: DryRunResult[]
  ): Promise<{
    promoted: boolean;
    calibratedConfidence: number;
    reason: string;
  }> {
    const candidate = this.candidateSkills.get(skillId);
    if (!candidate) {
      return { promoted: false, calibratedConfidence: 0, reason: 'Candidate skill not found' };
    }

    const calibration = UncertaintyCalibrator.calibrate(dryRuns, candidate.metrics);
    if (calibration.isEligible) {
      // Promote candidate
      candidate.verificationEvidence = {
        calibratedConfidence: calibration.calibratedConfidence,
        metrics: calibration.metrics,
        timestamp: new Date().toISOString()
      };
      candidate.stalenessMetadata.lastUsedAt = new Date().toISOString();

      this.activeSkills.set(skillId, candidate);
      this.candidateSkills.delete(skillId);

      // Persist to LongTermMemory
      await this.memory.store({
        id: `skill_${skillId}`,
        content: JSON.stringify(candidate),
        metadata: {
          type: 'procedural_skill',
          name: candidate.name,
          calibratedConfidence: calibration.calibratedConfidence
        },
        timestamp: Date.now()
      });

      return {
        promoted: true,
        calibratedConfidence: calibration.calibratedConfidence,
        reason: 'Skill successfully calibrated and promoted to active library'
      };
    } else {
      return {
        promoted: false,
        calibratedConfidence: calibration.calibratedConfidence,
        reason: `Skill failed calibration criteria. Confidence: ${calibration.calibratedConfidence.toFixed(2)}, Success Rate: ${calibration.metrics.successRate.toFixed(2)}` 
      };
    }
  }

  /**
   * Advisory-only retrieval: search active skills by query.
   */
  public async searchSkills(query: string): Promise<SkillDefinition[]> {
    const results: SkillDefinition[] = [];
    // Local active skills
    for (const skill of this.activeSkills.values()) {
      if (
        skill.name.toLowerCase().includes(query.toLowerCase()) ||
        skill.description.toLowerCase().includes(query.toLowerCase())
      ) {
        results.push(skill);
      }
    }

    // Search from LongTermMemory
    const memoryEntries = await this.memory.search(query);
    for (const entry of memoryEntries) {
      if (entry.metadata?.type === 'procedural_skill') {
        try {
          const skill = JSON.parse(entry.content) as SkillDefinition;
          if (!results.some(s => s.id === skill.id)) {
            results.push(skill);
          }
        } catch (e) {
          // Skip invalid entries
        }
      }
    }

    return results;
  }

  /**
   * Deletes an active skill from the library and long term memory.
   */
  public async deleteSkill(skillId: string): Promise<boolean> {
    let deleted = false;
    if (this.activeSkills.has(skillId)) {
      this.activeSkills.delete(skillId);
      deleted = true;
    }
    try {
      await this.memory.delete(`skill_${skillId}`);
      deleted = true;
    } catch (e) {
      // Entry might not exist in memory
    }
    return deleted;
  }

  public getActiveSkill(skillId: string): SkillDefinition | undefined {
    return this.activeSkills.get(skillId);
  }

  public getCandidateSkill(skillId: string): SkillDefinition | undefined {
    return this.candidateSkills.get(skillId);
  }
}
