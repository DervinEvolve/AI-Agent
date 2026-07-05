import { describe, it, expect, beforeEach } from 'vitest';
import { HitlCommunication, HitlCommunicationOptions } from '../cap_hitl_communication_16';
import { HitlOrchestrator, HitlChannel, HitlRequest, HitlActionDetails } from '../cap_hitl_orchestration_24';

class TestChannel implements HitlChannel {
  requests: HitlRequest[] = [];
  async send(req: HitlRequest): Promise<void> {
    this.requests.push(req);
  }
}

describe('HitlCommunication', () => {
  let channel: TestChannel;
  let orchestrator: HitlOrchestrator;
  let interactiveOptions: HitlCommunicationOptions;
  let nonInteractiveOptions: HitlCommunicationOptions;

  const defaultPolicy = {
    riskClassThreshold: 'high' as const,
    requiredForIrreversible: true,
    requiredForTainted: true,
    requiredForUnknownConsequence: true,
    costThreshold: 500,
  };

  const lowRiskAction: HitlActionDetails = {
    actionId: 'act-low',
    description: 'Read a public file',
    riskClass: 'low',
    irreversibility: false,
    cost: 0,
    unknownConsequence: false,
    tainted: false,
  };

  const highRiskAction: HitlActionDetails = {
    actionId: 'act-high',
    description: 'Delete production database',
    riskClass: 'critical',
    irreversibility: true,
    cost: 10000,
    unknownConsequence: true,
    tainted: true,
  };

  const irreversibleAction: HitlActionDetails = {
    actionId: 'act-irr',
    description: 'Irreversible low-risk action',
    riskClass: 'low',
    irreversibility: true,
    cost: 10,
    unknownConsequence: false,
    tainted: false,
  };

  const taintedAction: HitlActionDetails = {
    actionId: 'act-tainted',
    description: 'Tainted low-risk action',
    riskClass: 'low',
    irreversibility: false,
    cost: 10,
    unknownConsequence: false,
    tainted: true,
  };

  const unknownConsequenceAction: HitlActionDetails = {
    actionId: 'act-unknown',
    description: 'Action with unknown consequences',
    riskClass: 'low',
    irreversibility: false,
    cost: 10,
    unknownConsequence: true,
    tainted: false,
  };

  const expensiveAction: HitlActionDetails = {
    actionId: 'act-expensive',
    description: 'Expensive low-risk action',
    riskClass: 'low',
    irreversibility: false,
    cost: 1000,
    unknownConsequence: false,
    tainted: false,
  };

  beforeEach(() => {
    channel = new TestChannel();
    orchestrator = new HitlOrchestrator({ channel });
    interactiveOptions = {
      orchestrator,
      interactiveContext: true,
      policy: defaultPolicy,
    };
    nonInteractiveOptions = {
      orchestrator,
      interactiveContext: false,
      policy: defaultPolicy,
    };
  });

  describe('policy evaluation', () => {
    it('does not require HITL for low risk action', async () => {
      const comm = new HitlCommunication(interactiveOptions);
      const result = await comm.requestApprovalIfRequired(lowRiskAction);
      expect(result.required).toBe(false);
      expect(channel.requests).toHaveLength(0);
    });

    it('requires HITL when risk class >= threshold', async () => {
      const comm = new HitlCommunication(interactiveOptions);
      const result = await comm.requestApprovalIfRequired(highRiskAction);
      expect(result.required).toBe(true);
      expect(result.approvalId).toBeDefined();
      expect(channel.requests).toHaveLength(1);
    });

    it('requires HITL for irreversible actions when policy requires', async () => {
      const comm = new HitlCommunication(interactiveOptions);
      const result = await comm.requestApprovalIfRequired(irreversibleAction);
      expect(result.required).toBe(true);
      expect(result.approvalId).toBeDefined();
    });

    it('requires HITL for tainted actions when policy requires', async () => {
      const comm = new HitlCommunication(interactiveOptions);
      const result = await comm.requestApprovalIfRequired(taintedAction);
      expect(result.required).toBe(true);
      expect(result.approvalId).toBeDefined();
    });

    it('requires HITL for unknown consequence actions when policy requires', async () => {
      const comm = new HitlCommunication(interactiveOptions);
      const result = await comm.requestApprovalIfRequired(unknownConsequenceAction);
      expect(result.required).toBe(true);
      expect(result.approvalId).toBeDefined();
    });

    it('requires HITL when cost exceeds threshold', async () => {
      const comm = new HitlCommunication(interactiveOptions);
      const result = await comm.requestApprovalIfRequired(expensiveAction);
      expect(result.required).toBe(true);
      expect(result.approvalId).toBeDefined();
    });

    it('does not require HITL if policy does not require for specific conditions', async () => {
      const permissiveOptions: HitlCommunicationOptions = {
        orchestrator,
        interactiveContext: true,
        policy: {
          riskClassThreshold: 'critical', // only critical triggers
          requiredForIrreversible: false,
          requiredForTainted: false,
          requiredForUnknownConsequence: false,
          costThreshold: 10000, // very high
        },
      };
      const comm = new HitlCommunication(permissiveOptions);
      // high risk (critical) should still trigger
      const resultCritical = await comm.requestApprovalIfRequired(highRiskAction);
      expect(resultCritical.required).toBe(true);
      // but these should not
      const resultIrr = await comm.requestApprovalIfRequired(irreversibleAction);
      expect(resultIrr.required).toBe(false);
      const resultTainted = await comm.requestApprovalIfRequired(taintedAction);
      expect(resultTainted.required).toBe(false);
      const resultUnknown = await comm.requestApprovalIfRequired(unknownConsequenceAction);
      expect(resultUnknown.required).toBe(false);
      const resultExp = await comm.requestApprovalIfRequired(expensiveAction);
      expect(resultExp.required).toBe(false);
    });
  });

  describe('interactive context', () => {
    it('delegates to orchestrator and returns approvalId', async () => {
      const comm = new HitlCommunication(interactiveOptions);
      const result = await comm.requestApprovalIfRequired(highRiskAction);
      expect(result.required).toBe(true);
      expect(result.approvalId).toMatch(/^hitl-/);
      expect(channel.requests).toHaveLength(1);
      expect(channel.requests[0].action).toEqual(highRiskAction);
    });
  });

  describe('non-interactive context', () => {
    it('blocks high-risk action and returns policy_blocked reason', async () => {
      const comm = new HitlCommunication(nonInteractiveOptions);
      const result = await comm.requestApprovalIfRequired(highRiskAction);
      expect(result.required).toBe(true);
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe('non-interactive context');
      expect(channel.requests).toHaveLength(0); // orchestrator not called
    });

    it('does not block low-risk action', async () => {
      const comm = new HitlCommunication(nonInteractiveOptions);
      const result = await comm.requestApprovalIfRequired(lowRiskAction);
      expect(result.required).toBe(false);
      expect(result.blocked).toBeUndefined();
    });
  });
});
