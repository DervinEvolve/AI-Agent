import { describe, it, expect, beforeEach } from 'vitest';
import { InterAgentNegotiator, traceEvalEvents } from '../cap_inter_agent_negotiation_protocol_29';
import { DelegatedAuthVault12 } from '../cap_delegated_auth_vault_12';

describe('cap_inter_agent_negotiation_protocol_29', () => {
  const testScope = {
    user_id: 'user_123',
    project_id: 'project_abc',
    namespace: 'test_space'
  };

  beforeEach(() => {
    traceEvalEvents.length = 0;
  });

  it("initiate_session validates scope, registers peer, and initializes a secure session state in 'pending_response'", () => {
    const output = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'initiate_session',
      target_agent_id: 'peer_agent_xyz'
    });

    expect(output.status).toBe('pending_response');
    expect(output.tainted).toBe(false);
    expect(output.provenance.peer_id).toBe('peer_agent_xyz');
    expect(output.provenance.session_id).toBeDefined();
  });

  it('send_proposal enforces maximum character limits and increments the round counter; exceeding max_negotiation_rounds terminates the session with limit_exceeded', () => {
    const init = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'initiate_session',
      target_agent_id: 'peer_agent_xyz'
    });
    const sessionId = init.provenance.session_id;

    const payload = {
      proposed_role: 'executor',
      allocated_subtask_id: 'task_1',
      budget_share: 0.5,
      resource_claims: ['cpu'],
      success_criteria_snapshot: { status: 'complete' }
    };

    // Send valid proposal
    const step1 = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'send_proposal',
      session_id: sessionId,
      proposal_payload: payload
    });
    expect(step1.provenance.round_count).toBe(1);

    // Test character limit payload restriction
    const hugePayload = {
      ...payload,
      proposed_role: 'a'.repeat(6000)
    };
    const oversizedResult = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'send_proposal',
      session_id: sessionId,
      proposal_payload: hugePayload
    });
    expect(oversizedResult.status).toBe('limit_exceeded');
  });

  it('negotiation payloads carry monotonic taint; any proposal containing tainted parameters propagates tainted=true to the session state', () => {
    const init = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'initiate_session',
      target_agent_id: 'peer_agent_xyz'
    });
    const sessionId = init.provenance.session_id;

    const payload = {
      proposed_role: 'executor',
      allocated_subtask_id: 'task_1',
      budget_share: 0.5,
      resource_claims: ['cpu'],
      success_criteria_snapshot: { status: 'complete' }
    };

    const output = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'send_proposal',
      session_id: sessionId,
      proposal_payload: payload,
      tainted_input: true
    });

    expect(output.tainted).toBe(true);
  });

  it('evaluate_proposal checks incoming terms against local evaluation_criteria (budget, capabilities, risk) and returns accepted, counter, or rejected', () => {
    const init = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'initiate_session',
      target_agent_id: 'peer_agent_xyz',
      evaluation_criteria: {
        min_budget_ratio: 0.4,
        required_capabilities: ['compute'],
        risk_tolerance: 'medium'
      }
    });
    const sessionId = init.provenance.session_id;

    // Send a proposal with satisfying budget ratio of 0.5
    InterAgentNegotiator.handle({
      scope: testScope,
      action: 'send_proposal',
      session_id: sessionId,
      proposal_payload: {
        proposed_role: 'executor',
        allocated_subtask_id: 'task_1',
        budget_share: 0.5,
        resource_claims: ['cpu'],
        success_criteria_snapshot: { status: 'complete' }
      }
    });

    const evalOutput = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'evaluate_proposal',
      session_id: sessionId
    });

    expect(evalOutput.status).toBe('agreement_reached');
  });

  it('sign_agreement requires cryptographic binding of the final proposal payload, returning a verified agreement_hash; plaintext agreements without signatures are rejected', () => {
    const init = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'initiate_session',
      target_agent_id: 'peer_agent_xyz'
    });
    const sessionId = init.provenance.session_id;

    const payload = {
      proposed_role: 'executor',
      allocated_subtask_id: 'task_1',
      budget_share: 0.5,
      resource_claims: ['cpu'],
      success_criteria_snapshot: { status: 'complete' }
    };

    InterAgentNegotiator.handle({
      scope: testScope,
      action: 'send_proposal',
      session_id: sessionId,
      proposal_payload: payload
    });

    // Rejects unsigned plaintext agreement
    const rejectPlain = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'sign_agreement',
      session_id: sessionId
    });
    expect(rejectPlain.status).toBe('invalid_signature');

    // Signs cryptographically with vault
    const key = DelegatedAuthVault12.deriveSigningKey(testScope, 'local_agent');
    const signature = DelegatedAuthVault12.signPayload(key, payload);

    const signedOutput = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'sign_agreement',
      session_id: sessionId,
      signature_commitment: signature
    });

    expect(signedOutput.status).toBe('agreement_reached');
    expect(signedOutput.provenance.agreement_hash_optional).toBeDefined();
  });

  it('negotiator rejects any proposal attempting to delegate an action that requires local HITL confirmation without generating a pending_approval on the target agents side', () => {
    const init = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'initiate_session',
      target_agent_id: 'peer_agent_xyz',
      evaluation_criteria: {
        min_budget_ratio: 0.3,
        required_capabilities: [],
        risk_tolerance: 'low'
      }
    });
    const sessionId = init.provenance.session_id;

    InterAgentNegotiator.handle({
      scope: testScope,
      action: 'send_proposal',
      session_id: sessionId,
      proposal_payload: {
        proposed_role: 'executor',
        allocated_subtask_id: 'task_1',
        budget_share: 0.5,
        resource_claims: ['side_effect'], // low risk tolerance rejects side effects
        success_criteria_snapshot: { status: 'complete' }
      }
    });

    const evalOutput = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'evaluate_proposal',
      session_id: sessionId
    });

    expect(evalOutput.status).toBe('policy_blocked');
  });

  it('the protocol prevents deadlocks and escalation spirals by capping negotiation rounds to 15', () => {
    const init = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'initiate_session',
      target_agent_id: 'peer_agent_xyz'
    });
    const sessionId = init.provenance.session_id;

    const payload = {
      proposed_role: 'executor',
      allocated_subtask_id: 'task_1',
      budget_share: 0.5,
      resource_claims: [],
      success_criteria_snapshot: {}
    };

    let lastOutput: any;
    for (let r = 0; r < 16; r++) {
      lastOutput = InterAgentNegotiator.handle({
        scope: testScope,
        action: 'send_proposal',
        session_id: sessionId,
        proposal_payload: payload
      });
    }

    expect(lastOutput.status).toBe('limit_exceeded');
  });

  it('all session events, proposals, and signatures are recorded as trace_eval events with full provenance and secret redaction', () => {
    const init = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'initiate_session',
      target_agent_id: 'peer_agent_xyz'
    });
    const sessionId = init.provenance.session_id;

    InterAgentNegotiator.handle({
      scope: testScope,
      action: 'send_proposal',
      session_id: sessionId,
      proposal_payload: {
        proposed_role: 'executor',
        allocated_subtask_id: 'task_1',
        budget_share: 0.5,
        resource_claims: ['SUPER_SECRET_API_KEY_123'], // Should get redacted
        success_criteria_snapshot: {}
      }
    });

    expect(traceEvalEvents.length).toBeGreaterThan(0);
    const sentEvent = traceEvalEvents.find(e => e.event === 'negotiation_proposal_sent');
    expect(sentEvent).toBeDefined();
    // Verify the secret redactor works on trace_eval logs
    const logsStr = JSON.stringify(traceEvalEvents);
    expect(logsStr).not.toContain('SUPER_SECRET_API_KEY_123');
  });
});
