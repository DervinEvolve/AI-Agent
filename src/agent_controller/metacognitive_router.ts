import type { UncertaintySignal } from '../capabilities/cap_uncertainty_quantification_and_calibration_23';

export interface BudgetTracker {
  remaining: number;
}

export interface RoutingDecision {
  modelTier: 'cheap' | 'expensive' | 'deep';
  effortLevel: number; // 0-10
  skipDeliberation: boolean;
  advisory: true; // always advisory only
}

export class MetacognitiveRouter {
  route(
    taskDifficulty: number,
    uncertainty: UncertaintySignal,
    isHITL: boolean,
    isConsequential: boolean,
    budget: BudgetTracker
  ): RoutingDecision {
    const minEffort = (isHITL || uncertainty.value > 0.7 || isConsequential) ? 8 : 2;
    let effortLevel = Math.max(minEffort, Math.floor(taskDifficulty * 5));
    if (budget.remaining < 100) effortLevel = Math.max(effortLevel, minEffort);
    const modelTier = effortLevel >= 8 ? 'deep' : (effortLevel >= 4 ? 'expensive' : 'cheap');
    return {
      modelTier,
      effortLevel,
      skipDeliberation: effortLevel < 2 && !isHITL && uncertainty.value < 0.3,
      advisory: true
    };
  }
}
