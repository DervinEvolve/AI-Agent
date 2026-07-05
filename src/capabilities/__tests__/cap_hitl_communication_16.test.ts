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
  let nonInteractiveOptions: HitlCommunicationOptions;
  let interactiveOptions: HitlCommunicationOptions;

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

  beforeEach(() => {
    channel = new TestChannel();
    orchestrator = new HitlOrchestrator({ channel });
    nonInteractiveOptions = {
      orchestrator,
      interactiveContext: false,
      policy: defaultPolicy,
    };
    interactiveOptions = {
      orchestrator,
      interactiveContext: true,
      policy: defaultPolicy,
    };
  });

  it('does not require HITL for low risk action', async () => {
    const comm = new HitlCommunication(nonInteractiveOptions);
    const result = await comm.requestApprovalIfRequired(lowRiskAction);
    expect(result.required).toBe(false);
    expect(channel.requests).toHaveLength(0);
  });

  it('returns policy_blocked in non-interactive context for high risk', async () => {
    const comm = new HitlCommunication(nonInteractiveOptions);
    const result = await comm.requestApprovalIfRequired(highRiskAction);
    expect(result.required).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('non-interactive context');
    expect(result.approvalId).toBeUndefined();
    expect(channel.requests).toHaveLength(0);
  });

  it('delegates to orchestrator and returns approvalId in interactive context', async () => {
    const comm = new HitlCommunication(interactiveOptions);
    const result = await comm.requestApprovalIfRequired(highRiskAction);
    expect(result.required).toBe(true);
    expect(result.blocked).toBeUndefined();
    expect(result.approvalId).toMatch(/^hitl-/);
    expect(channel.requests).toHaveLength(1);
    expect(channel.requests[0].approvalId).toBe(result.approvalId);
  });

  it('policy gate triggers on risk class threshold', async () => {
    const medAction = { ...lowRiskAction, riskClass: 'high' as const, description: 'high risk action' };
    const comm = new HitlCommunication(interactiveOptions);
    const result = await comm.requestApprovalIfRequired(medAction);
    expect(result.required).toBe(true);
  });

  it('policy gate triggers on irreversibility', async () => {
    const irrAction = { ...lowRiskAction, irreversibility: true, riskClass: 'low' as const };
    const comm = new HitlCommunication(interactiveOptions);
    const result = await comm.requestApprovalIfRequired(irrAction);
    expect(result.required).toBe(true);
  });

  it('policy gate triggers on tainted', async () => {
    const taintAction = { ...lowRiskAction, tainted: true };
    const comm = new HitlCommunication(interactiveOptions);
    const result = await comm.requestApprovalIfRequired(taintAction);
    expect(result.required).toBe(true);
  });

  it('policy gate triggers on unknown consequence', async () => {
    const unknownAction = { ...lowRiskAction, unknownConsequence: true };
    const comm = new HitlCommunication(interactiveOptions);
    const result = await comm.requestApprovalIfRequired(unknownAction);
    expect(result.required).toBe(true);
  });

  it('policy gate triggers on cost threshold', async () => {
    const costAction = { ...lowRiskAction, cost: 600 };
    const comm = new HitlCommunication(interactiveOptions);
    const result = await comm.requestApprovalIfRequired(costAction);
    expect(result.required).toBe(true);
  });

  it('generates structured form', () => {
    const comm = new HitlCommunication(interactiveOptions);
    const form = comm.generateForm('ap-1', highRiskAction);
    expect(form).toHaveProperty('approvalId', 'ap-1');
    expect(form).toHaveProperty('actionDescription', highRiskAction.description);
    expect(form).toHaveProperty('consequences');
  });
});
