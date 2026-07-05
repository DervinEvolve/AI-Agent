/**
 * Behavior: Pre-action simulation, counterfactual evaluation, and risk mitigation
 * 
 * Before executing high-stakes, complex, or potentially risky sequences of actions,
 * the agent invokes the world_model_simulator to run pre-action simulations.
 * If critical failures or safety violations are predicted, the agent halts and either
 * revises its plan, triggers uncertainty-aware System-2 deliberation, or requests HITL clarification.
 */

import { WorldModelSimulator, PlanStep, SimulationResult } from '../capabilities/cap_world_model_simulator_31';
import { UncertaintyAwareDeliberator } from './beh_uncertainty_aware_deliberation_23';

export interface EvaluationOutcome {
  decision: 'PROCEED' | 'REVISE' | 'DELIBERATE' | 'HITL_GATE';
  reason: string;
  simulationResult: SimulationResult;
  revisedPlan?: PlanStep[];
}

export class WorldModelSimulationBehavior {
  private simulator: WorldModelSimulator;
  private deliberator: UncertaintyAwareDeliberator;

  constructor() {
    this.simulator = new WorldModelSimulator();
    this.deliberator = new UncertaintyAwareDeliberator();
  }

  /**
   * Evaluates the proposed plan and returns a decision on how to proceed.
   */
  public evaluatePlan(
    plan: PlanStep[],
    environmentState: Record<string, any> = {},
    isHighStakes: boolean = false
  ): EvaluationOutcome {
    const simResult = this.simulator.simulate(plan, environmentState);

    // 1. Check for safety violations
    if (simResult.detectedViolations.length > 0) {
      return {
        decision: 'HITL_GATE',
        reason: `Critical safety violation detected during simulation: ${simResult.detectedViolations.join(', ')}`,
        simulationResult: simResult
      };
    }

    // 2. High failure probability
    if (simResult.failureProbability >= 0.7) {
      // Attempt automatic plan revision by filtering out risky steps, or trigger System-2 deliberation
      const revised = this.attemptPlanRevision(plan);
      if (revised) {
        return {
          decision: 'REVISE',
          reason: `High failure probability (${simResult.failureProbability * 100}%). Plan automatically revised to mitigate risks.`,
          simulationResult: simResult,
          revisedPlan: revised
        };
      }

      // Fallback to System-2 Deliberation
      return {
        decision: 'DELIBERATE',
        reason: `High simulated failure probability (${simResult.failureProbability * 100}%). Demoting to uncertainty-aware System-2 deliberation.`,
        simulationResult: simResult
      };
    }

    // 3. Medium failure probability or high-stakes context
    if (simResult.failureProbability >= 0.3 || isHighStakes) {
      // Check if we can trigger System-2 deliberation
      const deliberationResult = this.deliberator.deliberate({
        taskComplexity: 'high',
        uncertaintyLevel: simResult.failureProbability,
        context: 'Pre-action simulation warning'
      });

      if (deliberationResult.requiresHITL) {
        return {
          decision: 'HITL_GATE',
          reason: `Medium failure probability or high-stakes context requiring human-in-the-loop validation: ${deliberationResult.reason}`,
          simulationResult: simResult
        };
      }

      return {
        decision: 'DELIBERATE',
        reason: `Medium risk detected. Deliberation triggered: ${deliberationResult.reason}`,
        simulationResult: simResult
      };
    }

    // 4. Safe to proceed
    return {
      decision: 'PROCEED',
      reason: 'Simulation succeeded with acceptable risk levels.',
      simulationResult: simResult
    };
  }

  /**
   * Tries to safely revise a plan (e.g. replacing unsafe commands or partitioning actions)
   */
  private attemptPlanRevision(plan: PlanStep[]): PlanStep[] | undefined {
    let revised = false;
    const newPlan = plan.map(step => {
      if (step.action === 'execute_untested_code') {
        revised = true;
        return {
          ...step,
          action: 'execute_tested_code_sandbox',
          parameters: { ...step.parameters, sandbox: true, preflightCheck: true }
        };
      }
      return step;
    });

    return revised ? newPlan : undefined;
  }
}
