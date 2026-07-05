/**
 * Capability: World Model Simulator
 * Simulates proposed plans and counterfactual scenarios before live execution
 * to proactively identify failure modes, safety violations, and environmental drift.
 */

export interface PlanStep {
  id: string;
  action: string;
  parameters: Record<string, any>;
}

export interface SimulationResult {
  success: boolean;
  predictedState: Record<string, any>;
  failureProbability: number;
  detectedViolations: string[];
  counterfactuals: {
    scenario: string;
    outcome: string;
    mitigationSuggested: string;
  }[];
}

export class WorldModelSimulator {
  /**
   * Simulates execution of a multi-step plan.
   */
  public simulate(plan: PlanStep[], environmentState: Record<string, any> = {}): SimulationResult {
    const detectedViolations: string[] = [];
    let failureProbability = 0.05; // Base low risk
    const counterfactuals: { scenario: string; outcome: string; mitigationSuggested: string; }[] = [];

    for (const step of plan) {
      // Check for safety violations in parameters
      if (step.parameters && typeof step.parameters === 'object') {
        const paramsStr = JSON.stringify(step.parameters).toLowerCase();
        if (paramsStr.includes('rm -rf') || paramsStr.includes('delete_all_files') || paramsStr.includes('force_overwrite_system')) {
          detectedViolations.push(`Critical safety violation in action: ${step.action}`);
          failureProbability = Math.max(failureProbability, 0.95);
        }
        if (paramsStr.includes('untrusted_source') || paramsStr.includes('malicious')) {
          detectedViolations.push(`Untrusted source hazard detected in step: ${step.id}`);
          failureProbability = Math.max(failureProbability, 0.80);
        }
      }

      // Check for specific fragile actions
      if (step.action === 'execute_untested_code') {
        failureProbability = Math.max(failureProbability, 0.65);
        counterfactuals.push({
          scenario: 'What if compilation or syntax check fails?',
          outcome: 'Execution halts with syntax error.',
          mitigationSuggested: 'Add dry-run or validation step before full execution.'
        });
      }

      if (step.action === 'database_migration') {
        failureProbability = Math.max(failureProbability, 0.40);
        counterfactuals.push({
          scenario: 'What if the connection pool is exhausted during migration?',
          outcome: 'Transaction times out and locks tables.',
          mitigationSuggested: 'Ensure auto-rollback is enabled and connection limit is pre-checked.'
        });
      }
    }

    // Generic counterfactual scenarios for multi-step plans
    if (plan.length > 2) {
      counterfactuals.push({
        scenario: 'What if a step fails midway?',
        outcome: 'Subsequent steps are blocked, leaving state inconsistent.',
        mitigationSuggested: 'Implement transactional rollbacks or checkpoint-restore steps.'
      });
    }

    return {
      success: failureProbability < 0.5 && detectedViolations.length === 0,
      predictedState: {
        ...environmentState,
        simulatedStepsCount: plan.length,
        simulationTimestamp: Date.now()
      },
      failureProbability,
      detectedViolations,
      counterfactuals
    };
  }
}
