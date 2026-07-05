import { describe, it, expect, vi } from 'vitest';
import {
  UncertaintyCalibrator,
  UncertaintyAwareController,
  Claim,
  Milestone,
} from '../beh_uncertainty_aware_deliberation_23';

describe('beh_uncertainty_aware_deliberation_23 tests', () => {
  it('controller invokes uncertainty_calibrator before finalizing any milestone or committing to a high-impact plan step', async () => {
    const controller = new UncertaintyAwareController({
      taskThreshold: 0.7,
      correctionBudget: 2,
    });

    const claim: Claim = {
      id: 'c1',
      statement: 'Deployment is safe',
      confidence: 0.95,
      isExternalObservation: true,
    };
    controller.addClaim(claim);

    const milestone: Milestone = {
      id: 'm1',
      name: 'Finalize Deployment Plan',
      associatedClaims: ['c1'],
      status: 'pending',
    };
    controller.addMilestone(milestone);

    const spy = vi.spyOn(controller.calibrator, 'calibrate');
    const res = await controller.executeStep({
      type: 'plan',
      action: 'Commit deployment',
    });

    expect(spy).toHaveBeenCalled();
    expect(res.status).toBe('success');
    expect(milestone.status).toBe('finalized');
  });

  it('when calibrated confidence drops below the threshold, the agent halts forward tool execution and triggers a correction attempt or requests clarification', async () => {
    let hitlCalled = false;
    const controller = new UncertaintyAwareController({
      taskThreshold: 0.8,
      correctionBudget: 2,
      onHITLRequest: async (prompt) => {
        hitlCalled = true;
        return 'Deployment is verified safe by DevOps team';
      },
    });

    // Low confidence claim
    const claim: Claim = {
      id: 'c1',
      statement: 'Deployment is safe',
      confidence: 0.5,
    };
    controller.addClaim(claim);

    const milestone: Milestone = {
      id: 'm1',
      name: 'Finalize Deployment Plan',
      associatedClaims: ['c1'],
      status: 'pending',
    };
    controller.addMilestone(milestone);

    const res = await controller.executeStep({
      type: 'tool_call',
      action: 'perform_deployment',
    });

    expect(hitlCalled).toBe(true);
    expect(res.status).toBe('success');
    expect(milestone.status).toBe('finalized');
  });

  it('downstream planning steps and milestones inherit uncertainty flags', async () => {
    const controller = new UncertaintyAwareController({
      taskThreshold: 0.85,
      correctionBudget: 0,
    });

    const claim: Claim = {
      id: 'c1',
      statement: 'Database migration completed successfully',
      confidence: 0.6,
    };
    controller.addClaim(claim);

    const milestone: Milestone = {
      id: 'm1',
      name: 'Migration Milestone',
      associatedClaims: ['c1'],
      status: 'pending',
    };
    controller.addMilestone(milestone);

    // Run step to trigger uncertainty propagation
    await controller.executeStep({
      type: 'plan',
      action: 'Check status',
    });

    expect(milestone.inheritedUncertainty).toBe(true);
    expect(claim.inheritedUncertainty).toBe(true);
  });

  it('returns a structured failure if the correction loop fails and budget is exhausted', async () => {
    const controller = new UncertaintyAwareController({
      taskThreshold: 0.9,
      correctionBudget: 1,
      onHITLRequest: async () => {
        // Still returns unverified low-confidence result
        return 'Unverified statement';
      },
    });

    const claim: Claim = {
      id: 'c1',
      statement: 'Server is healthy',
      confidence: 0.4,
    };
    controller.addClaim(claim);

    const milestone: Milestone = {
      id: 'm1',
      name: 'Verify Server Status',
      associatedClaims: ['c1'],
      status: 'pending',
    };
    controller.addMilestone(milestone);

    const res = await controller.executeStep({
      type: 'action',
      action: 'Start traffic routing',
    });

    expect(res.status).toBe('failed');
    expect(res.reason).toContain('Uncertainty threshold breach');
    expect(milestone.status).toBe('failed');
  });

  it('detects contradictions and applies severe confidence penalty', () => {
    const calibrator = new UncertaintyCalibrator();
    const claimA: Claim = {
      id: 'c1',
      statement: 'Service is completely offline',
      confidence: 0.9,
    };
    const claimB: Claim = {
      id: 'c2',
      statement: 'Service is not completely offline',
      confidence: 0.8,
    };

    const ledger = [claimA, claimB];
    const res = calibrator.calibrate(claimA, ledger);

    expect(res.uncertaintyProfile.contradictionsFound).toBe(true);
    // Original (0.9) * epistemic doubt penalty (0.85) * contradiction penalty (0.5) = 0.3825
    expect(res.calibratedConfidence).toBeCloseTo(0.3825, 4);
  });
});
