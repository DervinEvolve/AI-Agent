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
      expect(result.reason).toContain('tainted');
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
        { ...baseProfile, estimatedCost: '$500' },
        interactiveContext,
      );
      expect(result.requiresApproval).toBe(true);
      expect(result.reason).toContain('cost');
    });

    it('returns requiresApproval=false for low-risk, non-tainted, reversible, free actions', () => {
      const result = evaluateHITLPolicy(baseProfile, interactiveContext);
      expect(result.requiresApproval).toBe(false);
    });

    // -------------------------------------------------------------------
    // Non-interactive contexts
    // -------------------------------------------------------------------
    const nonInteractiveContexts: ExecutionContext[] = [
      'sub_agent',
      'scheduled',
      'event_triggered',
      'headless',
    ];

    for (const ctx of nonInteractiveContexts) {
      it(`returns requiresApproval=false for non-interactive context: ${ctx}`, () => {
        const result = evaluateHITLPolicy(
          { ...baseProfile, riskClass: 'critical' },
          ctx,
        );
        expect(result.requiresApproval).toBe(false);
        expect(result.reason).toContain('Non-interactive');
      });
    }
  });

  // -----------------------------------------------------------------------
  // Structured form rendering
  // -----------------------------------------------------------------------
  describe('renderStructuredForm', () => {
    it('renders a form with action and risk sections', () => {
      const profile: ActionProfile = {
        description: 'Deploy v2.0 to production',
        riskClass: 'high',
        taintSources: [],
        irreversible: false,
        estimatedCost: '$0',
        unknownConsequences: false,
        stateChanging: true,
        requiresAuthentication: true,
      };

      const form = renderStructuredForm(profile);
      expect(form.title).toBe('Human Approval Required');
      expect(form.sections).toHaveLength(2); // Action + Risk
      expect(form.sections[0].heading).toBe('Action');
      expect(form.sections[1].heading).toBe('Risk Assessment');
      expect(form.confirmLabel).toBe('Approve');
      expect(form.denyLabel).toBe('Deny');
    });

    it('includes a taint section when taint sources are present', () => {
      const profile: ActionProfile = {
        description: 'Run user script',
        riskClass: 'medium',
        taintSources: ['user-upload', 'untrusted-url'],
        irreversible: false,
        estimatedCost: '$0',
        unknownConsequences: false,
        stateChanging: true,
        requiresAuthentication: false,
      };

      const form = renderStructuredForm(profile);
      const taintSection = form.sections.find(
        (s) => s.heading === 'Taint Sources',
      );
      expect(taintSection).toBeDefined();
      expect(taintSection!.fields).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // requestApproval (delegation to orchestrator)
  // -----------------------------------------------------------------------
  describe('requestApproval', () => {
    const profile: ActionProfile = {
      description: 'Delete production database',
      riskClass: 'critical',
      taintSources: [],
      irreversible: true,
      estimatedCost: '$0',
      unknownConsequences: false,
      stateChanging: true,
      requiresAuthentication: true,
    };

    it('returns policy_blocked for non-interactive contexts', () => {
      const result = requestApproval({
        taskId: 'task-1',
        profile,
        context: 'sub_agent',
      });

      expect(result.requiresApproval).toBe(false);
      expect(result.policyBlocked).toBe(true);
      expect(result.approvalId).toBeUndefined();
    });

    it('returns requiresApproval=false when policy gate says no', () => {
      const result = requestApproval({
        taskId: 'task-2',
        profile: { ...profile, riskClass: 'low', irreversible: false },
        context: 'browser',
      });

      expect(result.requiresApproval).toBe(false);
      expect(result.approvalId).toBeUndefined();
    });

    it('delegates to hitl_orchestrator and returns an approvalId', () => {
      const result = requestApproval({
        taskId: 'task-3',
        profile,
        context: 'browser',
      });

      expect(result.requiresApproval).toBe(true);
      expect(result.approvalId).toBeTruthy();

      // Verify the orchestrator actually has the approval.
      const state = hitl_orchestrator.check_status(result.approvalId!);
      expect(state).not.toBeNull();
      expect(state!.taskId).toBe('task-3');
      expect(state!.status).toBe('pending');
    });

    it('passes channels and timeout to the orchestrator', () => {
      const result = requestApproval({
        taskId: 'task-4',
        profile,
        context: 'dashboard',
        channels: ['slack', 'email'],
        timeoutMs: 120_000,
      });

      const state = hitl_orchestrator.check_status(result.approvalId!);
      expect(state).not.toBeNull();
      // The expiry should reflect the custom timeout.
      const requestedAt = new Date(state!.requestedAt).getTime();
      const expiresAt = new Date(state!.expiresAt).getTime();
      expect(expiresAt - requestedAt).toBe(120_000);
    });
  });

  // -----------------------------------------------------------------------
  // Thin wrappers
  // -----------------------------------------------------------------------
  describe('checkApprovalStatus / applyDecision / cancelApproval', () => {
    it('checkApprovalStatus delegates to orchestrator', () => {
      const created = hitl_orchestrator.request_approval({
        taskId: 't',
        summary: 's',
        form: {},
        riskProfile: {
          riskClass: 'critical',
          taintSources: [],
          irreversible: false,
          estimatedCost: '$0',
          unknownConsequences: false,
        },
        channels: ['dashboard'],
        timeoutMs: 60_000,
        sequenceNumber: 1,
      });

      const state = checkApprovalStatus(created.approvalId);
      expect(state).not.toBeNull();
      expect(state!.status).toBe('pending');
    });

    it('applyDecision delegates to orchestrator', () => {
      const created = hitl_orchestrator.request_approval({
        taskId: 't',
        summary: 's',
        form: {},
        riskProfile: {
          riskClass: 'critical',
          taintSources: [],
          irreversible: false,
          estimatedCost: '$0',
          unknownConsequences: false,
        },
        channels: ['dashboard'],
        timeoutMs: 60_000,
        sequenceNumber: 1,
      });

      const { createBindingHash } = require('../cap_hitl_orchestration_24');
      const token = {
        approvalId: created.approvalId,
        decision: 'allow' as const,
        bindingHash: createBindingHash(created.approvalId, 'allow', 0),
        decidedAt: new Date().toISOString(),
        decidedBy: 'alice',
      };

      const updated = applyDecision(token);
      expect(updated!.status).toBe('approved');
    });

    it('cancelApproval delegates to orchestrator', () => {
      const created = hitl_orchestrator.request_approval({
        taskId: 't',
        summary: 's',
        form: {},
        riskProfile: {
          riskClass: 'critical',
          taintSources: [],
          irreversible: false,
          estimatedCost: '$0',
          unknownConsequences: false,
        },
        channels: ['dashboard'],
        timeoutMs: 60_000,
        sequenceNumber: 1,
      });

      expect(cancelApproval(created.approvalId)).toBe(true);
      expect(checkApprovalStatus(created.approvalId)!.status).toBe('cancelled');
    });
  });
});
