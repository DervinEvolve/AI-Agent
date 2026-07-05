import { HitlOrchestrator, HitlActionDetails, HitlRequest } from './cap_hitl_orchestration_24';

export interface HitlCommunicationOptions {
  orchestrator: HitlOrchestrator;
  interactiveContext: boolean;
  policy: {
    riskClassThreshold: HitlActionDetails['riskClass'];
    requiredForIrreversible: boolean;
    requiredForTainted: boolean;
    requiredForUnknownConsequence: boolean;
    costThreshold: number;
  };
}

export class HitlCommunication {
  private orchestrator: HitlOrchestrator;
  private options: HitlCommunicationOptions;

  constructor(options: HitlCommunicationOptions) {
    this.options = options;
    this.orchestrator = options.orchestrator;
  }

  async requestApprovalIfRequired(action: HitlActionDetails): Promise<{
    required: boolean;
    approvalId?: string;
    blocked?: boolean;
    reason?: string;
  }> {
    const requiresHITL = this.evaluatePolicy(action);
    if (!requiresHITL) {
      return { required: false };
    }
    if (!this.options.interactiveContext) {
      return { required: true, blocked: true, reason: 'non-interactive context' };
    }
    const approvalId = await this.orchestrator.requestApproval(action);
    return { required: true, approvalId };
  }

  private evaluatePolicy(action: HitlActionDetails): boolean {
    const p = this.options.policy;
    const riskLevels: Record<HitlActionDetails['riskClass'], number> = {
      low: 0,
      medium: 1,
      high: 2,
      critical: 3,
    };
    const actionRisk = riskLevels[action.riskClass];
    const threshold = riskLevels[p.riskClassThreshold];
    if (actionRisk >= threshold) return true;
    if (p.requiredForIrreversible && action.irreversibility) return true;
    if (p.requiredForTainted && action.tainted) return true;
    if (p.requiredForUnknownConsequence && action.unknownConsequence) return true;
    if (action.cost >= p.costThreshold) return true;
    return false;
  }

  generateForm(approvalId: string, action: HitlActionDetails): object {
    return {
      approvalId,
      actionDescription: action.description,
      riskClass: action.riskClass,
      consequences: {
        irreversible: action.irreversibility,
        cost: action.cost,
        unknown: action.unknownConsequence,
      },
      instructions: 'Approve or deny this action. A cryptographic token will be required.',
    };
  }

  getOrchestrator(): HitlOrchestrator {
    return this.orchestrator;
  }
}
