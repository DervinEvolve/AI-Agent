/**
 * Uncertainty-aware deliberation and forward propagation capability.
 * Monitors confidence, propagates uncertainty flags, and triggers calibration
 * loops or structured failures when confidence falls below the task-scoped threshold.
 */

export interface Claim {
  id: string;
  statement: string;
  confidence: number; // 0.0 to 1.0
  isExternalObservation?: boolean;
  inheritedUncertainty?: boolean;
}

export interface Milestone {
  id: string;
  name: string;
  associatedClaims: string[];
  status: 'pending' | 'finalized' | 'failed';
  inheritedUncertainty?: boolean;
}

export interface CalibrationResult {
  calibratedConfidence: number;
  uncertaintyProfile: {
    hasExternalValidation: boolean;
    contradictionsFound: boolean;
    inheritedUncertainty: boolean;
  };
}

export interface ExecutionStep {
  type: string;
  action: string;
  result?: string;
}

export interface ReActLoopConfig {
  taskThreshold: number;
  correctionBudget: number;
  onHITLRequest?: (prompt: string) => Promise<string>;
}

export class UncertaintyCalibrator {
  /**
   * Calibrates confidence based on external validation, inherited uncertainty,
   * and contradiction flags.
   */
  public calibrate(claim: Claim, claimsLedger: Claim[]): CalibrationResult {
    let hasExternalValidation = !!claim.isExternalObservation;
    let inheritedUncertainty = !!claim.inheritedUncertainty;

    // Check for contradictions in the ledger
    const contradictions = claimsLedger.filter(
      (c) =>
        c.id !== claim.id &&
        this.areContradictory(c.statement, claim.statement)
    );
    const contradictionsFound = contradictions.length > 0;

    // Base confidence
    let confidence = claim.confidence;

    // Epistemic doubt: previous self-statements without external validation are calibrated downwards
    if (!hasExternalValidation) {
      confidence *= 0.85;
    }

    // Lower confidence further if there is inherited uncertainty
    if (inheritedUncertainty) {
      confidence *= 0.8;
    }

    // Severe penalty for contradictions
    if (contradictionsFound) {
      confidence *= 0.5;
    }

    // Clamp to [0, 1]
    confidence = Math.max(0, Math.min(1, confidence));

    return {
      calibratedConfidence: parseFloat(confidence.toFixed(3)),
      uncertaintyProfile: {
        hasExternalValidation,
        contradictionsFound,
        inheritedUncertainty,
      },
    };
  }

  private areContradictory(s1: string, s2: string): boolean {
    const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '');
    const c1 = clean(s1);
    const c2 = clean(s2);
    if (c1.includes('not') !== c2.includes('not')) {
      // Simple heuristic for contradiction detection
      const base1 = c1.replace('not', '').replace(/\s+/g, ' ').trim();
      const base2 = c2.replace('not', '').replace(/\s+/g, ' ').trim();
      if (base1 === base2 || base1.includes(base2) || base2.includes(base1)) {
        return true;
      }
    }
    return false;
  }
}

export class UncertaintyAwareController {
  public calibrator = new UncertaintyCalibrator();
  public claimsLedger: Claim[] = [];
  public milestones: Milestone[] = [];
  public reasoningTrace: string[] = [];
  public executionHistory: ExecutionStep[] = [];

  constructor(public config: ReActLoopConfig) {}

  public addClaim(claim: Claim): void {
    this.claimsLedger.push(claim);
    this.logReasoning(`Added claim "${claim.statement}" with initial confidence ${claim.confidence}`);

    // Contradiction resolution attempts in the claim ledger trigger immediate uncertainty assessment
    const contradictions = this.claimsLedger.filter(
      (c) => c.id !== claim.id && this.calibrator['areContradictory'](c.statement, claim.statement)
    );
    if (contradictions.length > 0) {
      this.logReasoning(`Contradiction detected! Triggering immediate uncertainty assessment.`);
      for (const affected of [claim, ...contradictions]) {
        const res = this.calibrator.calibrate(affected, this.claimsLedger);
        affected.confidence = res.calibratedConfidence;
        this.logReasoning(`Recalibrated claim "${affected.statement}" due to contradiction. New confidence: ${res.calibratedConfidence}`);
      }
    }
  }

  public addMilestone(milestone: Milestone): void {
    // Propagate inherited uncertainty forward if any associated claims are low-confidence
    let hasLowConfidenceClaim = false;
    for (const claimId of milestone.associatedClaims) {
      const claim = this.claimsLedger.find((c) => c.id === claimId);
      if (claim) {
        const res = this.calibrator.calibrate(claim, this.claimsLedger);
        if (res.calibratedConfidence < this.config.taskThreshold) {
          hasLowConfidenceClaim = true;
        }
      }
    }

    if (hasLowConfidenceClaim) {
      milestone.inheritedUncertainty = true;
      this.logReasoning(`Milestone "${milestone.name}" marked with inherited uncertainty due to low-confidence upstream dependencies.`);
    }
    this.milestones.push(milestone);
  }

  public async executeStep(step: ExecutionStep): Promise<{
    status: 'success' | 'halted' | 'failed';
    message: string;
  }> {
    this.logReasoning(`Evaluating step: ${step.action}`);

    // Verify confidence of milestones or upcoming plan steps prior to finalization/execution
    const associatedMilestones = this.milestones.filter(
      (m) => m.associatedClaims.length > 0 && m.status === 'pending'
    );

    for (const milestone of associatedMilestones) {
      for (const claimId of milestone.associatedClaims) {
        const claim = this.claimsLedger.find((c) => c.id === claimId);
        if (!claim) continue;

        let calibration = this.calibrator.calibrate(claim, this.claimsLedger);
        this.logReasoning(`Calibrated confidence for claim "${claim.statement}": ${calibration.calibratedConfidence} (threshold: ${this.config.taskThreshold})`);

        // If calibrated confidence drops below task threshold, halt forward execution and trigger correction
        if (calibration.calibratedConfidence < this.config.taskThreshold) {
          this.logReasoning(`Confidence ${calibration.calibratedConfidence} is below threshold ${this.config.taskThreshold}. Halting execution.`);
          
          let budget = this.config.correctionBudget;
          let success = false;

          while (budget > 0 && !success) {
            budget--;
            this.logReasoning(`Running correction loop step. Remaining budget: ${budget}`);
            
            // Attempt correction: e.g. request details, seek external validation
            if (this.config.onHITLRequest) {
              const correctedVal = await this.config.onHITLRequest(`Please clarify claim: ${claim.statement}`);
              claim.statement = correctedVal;
              claim.isExternalObservation = true; // HITL counts as external validation
            }
            
            // Re-calibrate
            calibration = this.calibrator.calibrate(claim, this.claimsLedger);
            if (calibration.calibratedConfidence >= this.config.taskThreshold) {
              success = true;
              claim.confidence = calibration.calibratedConfidence;
              this.logReasoning(`Correction successful! Calibrated confidence raised to ${calibration.calibratedConfidence}`);
            }
          }

          if (!success) {
            milestone.status = 'failed';
            this.logReasoning(`Correction budget exhausted. Structured failure returned.`);
            return {
              status: 'failed',
              message: `Execution halted. Confidence calibration failed to meet threshold of ${this.config.taskThreshold} for milestone "${milestone.name}".`,
            };
          }
        }
      }
      milestone.status = 'finalized';
    }

    this.executionHistory.push(step);
    this.logReasoning(`Step "${step.action}" completed successfully.`);
    return { status: 'success', message: 'Step executed.' };
  }

  private logReasoning(msg: string): void {
    this.reasoningTrace.push(msg);
  }
}
