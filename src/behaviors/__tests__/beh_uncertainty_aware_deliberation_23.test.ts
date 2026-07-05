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
      type: 'tool',
      action: 'run-deploy-script',
    });

    expect(hitlCalled).toBe(true);
    expect(res.status).toBe('success');
  });

  it('downstream planning steps in context assembly are marked with inherited uncertainty flags if they depend on low-confidence upstream milestones', () => {
    const controller = new UncertaintyAwareController({
      taskThreshold: 0.85,
      correctionBudget: 1,
    });

    const lowConfClaim: Claim = {
      id: 'c1',
      statement: 'Server is healthy',
      confidence: 0.6,
    };
    controller.addClaim(lowConfClaim);

    const milestone: Milestone = {
      id: 'm2',
      name: 'Next Step Plan',
      associatedClaims: ['c1'],
      status: 'pending',
    };
    controller.addMilestone(milestone);

    expect(milestone.inheritedUncertainty).toBe(true);
    expect(controller.reasoningTrace.some(trace => trace.includes('inherited uncertainty'))).toBe(true);
  });

  it('the agent explicitly states its calibrated confidence and uncertainty profiles in its reasoning trace and user-facing status updates', async () => {
    const controller = new UncertaintyAwareController({
      taskThreshold: 0.5,
      correctionBudget: 1,
    });

    controller.addClaim({
      id: 'c1',
      statement: 'Database connected',
      confidence: 0.9,
    });
    controller.addMilestone({
      id: 'm1',
      name: 'Connect DB',
      associatedClaims: ['c1'],
      status: 'pending',
    });

    await controller.executeStep({ type: 'action', action: 'ping db' });
    const hasTraceWithConfidence = controller.reasoningTrace.some(trace =>
      trace.includes('Calibrated confidence')
    );
    expect(hasTraceWithConfidence).toBe(true);
  });

  it('contradiction resolution attempts in the claim ledger trigger an immediate uncertainty assessment of the affected claims', () => {
    const controller = new UncertaintyAwareController({
      taskThreshold: 0.7,
      correctionBudget: 1,
    });

    controller.addClaim({
      id: 'c1',
      statement: 'The system is active',
      confidence: 0.9,
    });

    // Adding a contradictory claim triggers immediate assessment
    controller.addClaim({
      id: 'c2',
      statement: 'The system is not active',
      confidence: 0.95,
    });

    const claim1 = controller.claimsLedger.find(c => c.id === 'c1');
    const claim2 = controller.claimsLedger.find(c => c.id === 'c2');

    // Confidences should be severely penalized due to contradictions
    expect(claim1!.confidence).toBeLessThan(0.5);
    expect(claim2!.confidence).toBeLessThan(0.5);
  });

  it('if a correction loop fails to raise calibrated confidence above the threshold and budget is exhausted, the controller returns a structured failure', async () => {
    const controller = new UncertaintyAwareController({
      taskThreshold: 0.95,
      correctionBudget: 1,
      onHITLRequest: async () => 'Still unverified response',
    });

    controller.addClaim({
      id: 'c1',
      statement: 'Highly critical truth',
      confidence: 0.4,
    });
    controller.addMilestone({
      id: 'm1',
      name: 'Critical Validation',
      associatedClaims: ['c1'],
      status: 'pending',
    });

    const res = await controller.executeStep({ type: 'action', action: 'critical step' });
    expect(res.status).toBe('failed');
    expect(res.message).toContain('Execution halted. Confidence calibration failed');
  });

  it("the agent's own previous statements are treated with appropriate epistemic doubt and are calibrated against external, validated observations", () => {
    const calibrator = new UncertaintyCalibrator();

    const internalClaim: Claim = {
      id: 'c1',
      statement: 'We finished processing data',
      confidence: 1.0,
      isExternalObservation: false,
    };

    const externalClaim: Claim = {
      id: 'c2',
      statement: 'We finished processing data',
      confidence: 1.0,
      isExternalObservation: true,
    };

    const resInternal = calibrator.calibrate(internalClaim, []);
    const resExternal = calibrator.calibrate(externalClaim, []);

    // Internal claim should suffer epistemic doubt penalty
    expect(resInternal.calibratedConfidence).toBeLessThan(1.0);
    // External claim should remain at 1.0
    expect(resExternal.calibratedConfidence).toBe(1.0);
  });
});
