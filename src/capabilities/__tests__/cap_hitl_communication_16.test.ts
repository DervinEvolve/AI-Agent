import { describe, it, expect, beforeEach } from 'vitest';
import {
  evaluateHITLPolicy,
  renderStructuredForm,
  requestApproval,
  checkApprovalStatus,
  applyDecision,
  cancelApproval,
  type ActionProfile,
  type ExecutionContext,
} from '../cap_hitl_communication_16';
import { hitl_orchestrator } from '../cap_hitl_orchestration_24';

describe('cap_hitl_communication_16', () => {
  beforeEach(() => {
    hitl_orchestrator._reset();
  });

  // -----------------------------------------------------------------------
  // Policy gate
  // -----------------------------------------------------------------------
  describe('evaluateHITLPolicy', () => {
    const baseProfile: ActionProfile = {
      description: 'delete /prod/db',
      riskClass: 'low',
      taintSources: [],
      irreversible: false,
      estimatedCost: '$0',
      unknownConsequences: false,
      stateChanging: true,
      requiresAuthentication: true,
    };

    const interactiveContext: ExecutionContext = 'browser';

    it('returns requiresApproval=true for critical risk', () => {
      const result = evaluateHITLPolicy(
        { ...baseProfile, riskClass: 'critical' },
        interactiveContext,
      );
      expect(result.requiresApproval).toBe(true);
      expect(result.reason).toContain('Critical');
    });

    it('returns requiresApproval=true for high risk', () => {
      const result = evaluateHITLPolicy(
        { ...baseProfile, riskClass: 'high' },
        interactiveContext,
      );
      expect(result.requiresApproval).toBe(true);
      expect(result.reason).toContain('High');
    });

    it('returns requiresApproval=true for irreversible actions', () => {
      const result = evaluateHITLPolicy(
        { ...baseProfile, irreversible: true },
        interactiveContext,
      );
      expect(result.requiresApproval).toBe(true);
      expect(result.reason).toContain('irreversible');
    });

    it('returns requiresApproval=true for tainted actions', () => {
      const result = evaluateHITLPolicy(
        { ...baseProfile, taintSources: ['user-upload'] },
        interactiveContext,
      );
      expect(result.requiresApproval).toBe(true);
      expect(result.reason).toContain('taint');
    });

    it('returns requiresApproval=true for unknown consequences', () => {
      const result = evaluateHITLPolicy(
        { ...baseProfile, unknownConsequences: true },
        interactiveContext,
      );
      expect(result.requiresApproval).toBe(true);
      expect(result.reason).toContain('unknown');
    });

    it('returns requiresApproval=true for costly actions', () => {
      const result = evaluateHITLPolicy(
        { ...baseProfile, estimatedCost: '$10,000' },
        interactiveContext,
      );
      expect(result.requiresApproval).toBe(true);
      expect(result.reason).toContain('cost');
    });

    it('returns requiresApproval=false for low-risk interactive action', () => {
      const result = evaluateHITLPolicy(baseProfile, interactiveContext);
      expect(result.requiresApproval).toBe(false);
      expect(result.reason).toContain('does not require HITL');
    });

    it('returns policyBlocked=true for non-interactive contexts when approval required', () => {
      const nonInteractive: ExecutionContext = 'sub_agent';
      const result = evaluateHITLPolicy(
        { ...baseProfile, riskClass: 'critical' },
        nonInteractive,
      );
      expect(result.requiresApproval).toBe(true);
      expect(result.policyBlocked).toBe(true);
    });

    it('returns policyBlocked=false for non-interactive contexts when no approval required', () => {
      const nonInteractive: ExecutionContext = 'scheduled';
      const result = evaluateHITLPolicy(baseProfile, nonInteractive);
      expect(result.requiresApproval).toBe(false);
      expect(result.policyBlocked).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Structured form rendering
  // -----------------------------------------------------------------------
  describe('renderStructuredForm', () => {
    it('returns a structured form object from an action profile', () => {
      const profile: ActionProfile = {
        description: 'Delete S3 bucket',
        riskClass: 'high',
        taintSources: ['external-csv'],
        irreversible: true,
        estimatedCost: '$500',
        unknownConsequences: false,
        stateChanging: true,
        requiresAuthentication: true,
      };

      const form = renderStructuredForm(profile);

      expect(form).toHaveProperty('title');
      expect(form).toHaveProperty('sections');
      expect(form).toHaveProperty('riskSummary');
      expect(form.title).toContain('Delete S3 bucket');
      expect(form.riskSummary.riskClass).toBe('high');
      expect(form.riskSummary.irreversible).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Delegation to hitl_orchestrator
  // -----------------------------------------------------------------------
  describe('requestApproval (delegation to orchestrator)', () => {
    it('delegates to hitl_orchestrator and returns approvalId', () => {
      const profile: ActionProfile = {
        description: 'Deploy to prod',
        riskClass: 'critical',
        taintSources: [],
        irreversible: false,
        estimatedCost: '$0',
        unknownConsequences: false,
        stateChanging: true,
        requiresAuthentication: true,
      };

      const decision = evaluateHITLPolicy(profile, 'dashboard');
      expect(decision.requiresApproval).toBe(true);

      const approvalId = requestApproval(profile, 'task-42', 1);
      expect(approvalId).toBeTruthy();

      // Verify the orchestrator knows about this approval
      const state = hitl_orchestrator.check_status(approvalId);
      expect(state).not.toBeNull();
      expect(state!.status).toBe('pending');
      expect(state!.taskId).toBe('task-42');
    });

    it('throws when requestApproval called for non-required action', () => {
      const profile: ActionProfile = {
        description: 'Read a file',
        riskClass: 'low',
        taintSources: [],
        irreversible: false,
        estimatedCost: '$0',
        unknownConsequences: false,
        stateChanging: false,
        requiresAuthentication: false,
      };

      const decision = evaluateHITLPolicy(profile, 'browser');
      expect(decision.requiresApproval).toBe(false);

      expect(() => requestApproval(profile, 'task-99', 1)).toThrow();
    });
  });

  describe('checkApprovalStatus', () => {
    it('returns orchestrator status for a pending request', () => {
      const profile: ActionProfile = {
        description: 'Rotate secrets',
        riskClass: 'high',
        taintSources: [],
        irreversible: false,
        estimatedCost: '$0',
        unknownConsequences: false,
        stateChanging: true,
        requiresAuthentication: true,
      };

      const approvalId = requestApproval(profile, 'task-secret', 3);
      const status = checkApprovalStatus(approvalId);

      expect(status).not.toBeNull();
      expect(status!.status).toBe('pending');
    });

    it('returns null for unknown approvalId', () => {
      const status = checkApprovalStatus('nonexistent-id');
      expect(status).toBeNull();
    });
  });

  describe('applyDecision', () => {
    it('applies an approval decision and returns the token', () => {
      const profile: ActionProfile = {
        description: 'Destroy VM',
        riskClass: 'critical',
        taintSources: [],
        irreversible: true,
        estimatedCost: '$0',
        unknownConsequences: false,
        stateChanging: true,
        requiresAuthentication: true,
      };

      const approvalId = requestApproval(profile, 'task-vm', 7);
      const token = applyDecision(approvalId, 'allow');

      expect(token).not.toBeNull();
      expect(token!.decision).toBe('allow');
      expect(token!.approvalId).toBe(approvalId);
      expect(token!.bindingHash).toBeTruthy();

      // Verify the orchestrator now shows approved
      const state = hitl_orchestrator.check_status(approvalId);
      expect(state!.status).toBe('approved');
      expect(state!.token).toEqual(token);
    });

    it('applies a deny decision', () => {
      const profile: ActionProfile = {
        description: 'Drop table',
        riskClass: 'high',
        taintSources: ['user-input'],
        irreversible: true,
        estimatedCost: '$1000',
        unknownConsequences: false,
        stateChanging: true,
        requiresAuthentication: true,
      };

      const approvalId = requestApproval(profile, 'task-drop', 2);
      const token = applyDecision(approvalId, 'deny');

      expect(token).not.toBeNull();
      expect(token!.decision).toBe('deny');

      const state = hitl_orchestrator.check_status(approvalId);
      expect(state!.status).toBe('denied');
    });

    it('throws when applying decision to unknown approvalId', () => {
      expect(() => applyDecision('ghost-id', 'allow')).toThrow();
    });
  });

  describe('cancelApproval', () => {
    it('cancels a pending approval', () => {
      const profile: ActionProfile = {
        description: 'Archive data',
        riskClass: 'medium',
        taintSources: [],
        irreversible: false,
        estimatedCost: '$50',
        unknownConsequences: false,
        stateChanging: true,
        requiresAuthentication: true,
      };

      const approvalId = requestApproval(profile, 'task-archive', 5);
      cancelApproval(approvalId);

      const state = hitl_orchestrator.check_status(approvalId);
      expect(state!.status).toBe('cancelled');
    });

    it('is a no-op for unknown approvalId', () => {
      expect(() => cancelApproval('no-such-id')).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Integration: full lifecycle through communication gate
  // -----------------------------------------------------------------------
  describe('full lifecycle', () => {
    it('policy gate → request → approve → verify token binding', () => {
      const profile: ActionProfile = {
        description: 'Transfer $1M',
        riskClass: 'critical',
        taintSources: ['external-wire-details'],
        irreversible: true,
        estimatedCost: '$1,000,000',
        unknownConsequences: false,
        stateChanging: true,
        requiresAuthentication: true,
      };

      // 1. Policy evaluation
      const decision = evaluateHITLPolicy(profile, 'dashboard');
      expect(decision.requiresApproval).toBe(true);
      expect(decision.policyBlocked).toBe(false);

      // 2. Request approval
      const approvalId = requestApproval(profile, 'task-wire', 100);
      expect(approvalId).toBeTruthy();

      // 3. Check pending
      const pending = checkApprovalStatus(approvalId);
      expect(pending!.status).toBe('pending');

      // 4. Apply decision
      const token = applyDecision(approvalId, 'allow');
      expect(token).not.toBeNull();
      expect(token!.decision).toBe('allow');

      // 5. Verify final state
      const final = checkApprovalStatus(approvalId);
      expect(final!.status).toBe('approved');
      expect(final!.token).toEqual(token);
    });

    it('policy gate blocks non-interactive context', () => {
      const profile: ActionProfile = {
        description: 'Delete all backups',
        riskClass: 'critical',
        taintSources: [],
        irreversible: true,
        estimatedCost: '$0',
        unknownConsequences: false,
        stateChanging: true,
        requiresAuthentication: true,
      };

      const decision = evaluateHITLPolicy(profile, 'scheduled');
      expect(decision.requiresApproval).toBe(true);
      expect(decision.policyBlocked).toBe(true);
      expect(decision.approvalId).toBeUndefined();
    });
  });
});
