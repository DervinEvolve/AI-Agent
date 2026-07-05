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
    const hasExternalValidation = !!claim.isExternalObservation;
    const inheritedUncertainty = !!claim.inheritedUncertainty;

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
      confidence *= 0.75;
    }

    // Severe penalty for active contradictions
    if (contradictionsFound) {
      confidence *= 0.5;
    }

    return {
      calibratedConfidence: Math.max(0, Math.min(1.0, confidence)),
      uncertaintyProfile: {
        hasExternalValidation,
        contradictionsFound,
        inheritedUncertainty,
      },
    };
  }

  private areContradictory(a: string, b: string): boolean {
    const cleanA = a.toLowerCase().trim();
    const cleanB = b.toLowerCase().trim();
    if (cleanA.includes('not') !== cleanB.includes('not')) {
      const baseA = cleanA.replace('not', '').replace(/\s+/g, ' ').trim();
      const baseB = cleanB.replace('not', '').replace(/\s+/g, ' ').trim();
      return baseA === baseB || cleanA.includes(baseB) || cleanB.includes(baseA);
    }
    return false;
  }
}

export class UncertaintyAwareController {
  public calibrator = new UncertaintyCalibrator();
  public claimsLedger: Claim[] = [];
  public milestones: Milestone[] = [];
  public config: ReActLoopConfig;
  public reasoningTrace: string[] = [];
  public correctionAttempts = 0;

  constructor(config: ReActLoopConfig) {
    this.config = config;
  }

  public addClaim(claim: Claim): void {
    this.claimsLedger.push(claim);
    this.resolveContradictions();
  }

  public addMilestone(milestone: Milestone): void {
    this.milestones.push(milestone);
  }

  private resolveContradictions(): void {
    // Whenever a new claim is added, we run a check to see if it triggers an immediate assessment
    this.reasoningTrace.push('Executing contradiction resolution assessment on claim ledger');
    for (const claim of this.claimsLedger) {
      const result = this.calibrator.calibrate(claim, this.claimsLedger);
      if (result.uncertaintyProfile.contradictionsFound) {
        this.reasoningTrace.push(
          `Contradiction identified on claim ${claim.id}: lowering confidence profile.`
        );
      }
    }
  }

  public async executeStep(step: ExecutionStep): Promise<{ status: 'success' | 'failed' | 'halted'; reason?: string }> {
    this.reasoningTrace.push(`Processing execution step: ${step.action}`);

    // Propagate inherited uncertainty flags forward to pending milestones
    this.propagateUncertainty();

    // Before finalizing milestones or committing to actions, calibrate associated claims
    const pendingMilestones = this.milestones.filter((m) => m.status === 'pending');

    for (const milestone of pendingMilestones) {
      const associated = this.claimsLedger.filter((c) =>
        milestone.associatedClaims.includes(c.id)
      );

      for (const claim of associated) {
        let calibration = this.calibrator.calibrate(claim, this.claimsLedger);
        this.reasoningTrace.push(
          `Calibrated claim ${claim.id} [${claim.statement}]: ${calibration.calibratedConfidence.toFixed(2)}`
        );

        // If calibrated confidence is below threshold, trigger correction or HITL
        if (calibration.calibratedConfidence < this.config.taskThreshold) {
          this.reasoningTrace.push(
            `Confidence ${calibration.calibratedConfidence.toFixed(2)} is below task threshold ${this.config.taskThreshold}. Halting forward execution.`
          );

          if (this.correctionAttempts < this.config.correctionBudget) {
            this.correctionAttempts++;
            this.reasoningTrace.push(`Triggering correction loop attempt ${this.correctionAttempts}`);
            
            if (this.config.onHITLRequest) {
              const resolvedStatement = await this.config.onHITLRequest(
                `Uncertainty threshold breach. Please verify claim: ${claim.statement}`
              );
              claim.statement = resolvedStatement;
              claim.isExternalObservation = true;
              claim.confidence = 1.0; // Restored high confidence after external HITL validation
              
              // Re-calibrate
              calibration = this.calibrator.calibrate(claim, this.claimsLedger);
            }
          }

          // If still below threshold after attempt or budget exhausted
          if (calibration.calibratedConfidence < this.config.taskThreshold) {
            milestone.status = 'failed';
            return {
              status: 'failed',
              reason: `Uncertainty threshold breach could not be resolved. Budget exhausted.`,
            };
          }
        }
      }

      // Milestone finalized successfully
      milestone.status = 'finalized';
    }

    return { status: 'success' };
  }

  private propagateUncertainty(): void {
    // If any claim has low confidence, propagate uncertainty flag to downstream milestones
    for (const milestone of this.milestones) {
      const associated = this.claimsLedger.filter((c) =>
        milestone.associatedClaims.includes(c.id)
      );
      const hasLowConfidenceClaim = associated.some((c) => {
        const res = this.calibrator.calibrate(c, this.claimsLedger);
        return res.calibratedConfidence < this.config.taskThreshold;
      });

      if (hasLowConfidenceClaim) {
        milestone.inheritedUncertainty = true;
        // Propagate down to claims belonging to this milestone
        for (const c of associated) {
          c.inheritedUncertainty = true;
        }
      }
    }
  } 
}
