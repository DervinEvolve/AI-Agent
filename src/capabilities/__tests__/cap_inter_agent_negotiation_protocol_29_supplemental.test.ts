import { describe, it, expect, beforeEach } from 'vitest';
import { InterAgentNegotiator, traceEvalEvents } from '../cap_inter_agent_negotiation_protocol_29';
import { DelegatedAuthVault12 } from '../cap_delegated_auth_vault_12';

describe('InterAgentNegotiator Supplemental Tests', () => {
  const testScope = {
    user_id: 'user_999',
    project_id: 'project_xyz',
    namespace: 'secure_namespace'
  };

  beforeEach(() => {
    traceEvalEvents.length = 0;
  });

  it('should propagate monotonic taint status from input to negotiation state', () => {
    // Initiate session
    const init = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'initiate_session',
      target_agent_id: 'tainted_partner_agent'
    });
    const sessionId = init.provenance.session_id;
    expect(init.tainted).toBe(false);

    // Send an untainted proposal initially
    const payloadUntainted = {
      proposed_role: 'helper',
      allocated_subtask_id: 'task_abc',
      budget_share: 0.25,
      resource_claims: [],
      success_criteria_snapshot: {},
    };

    const step1 = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'send_proposal',
      session_id: sessionId,
      proposal_payload: payloadUntainted,
      tainted_input: false
    });
    expect(step1.tainted).toBe(false);

    // Send a proposal marked as tainted (simulating tainted observation/peer input)
    const step2 = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'send_proposal',
      session_id: sessionId,
      proposal_payload: payloadUntainted,
      tainted_input: true
    });
    expect(step2.tainted).toBe(true);

    // Verify that subsequent actions keep the session tainted (monotonic propagation)
    const step3 = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'get_negotiation_state',
      session_id: sessionId
    });
    expect(step3.tainted).toBe(true);
  });

  it('should evaluate proposals against evaluation_criteria and return expected status', () => {
    const init = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'initiate_session',
      target_agent_id: 'eval_partner_agent'
    });
    const sessionId = init.provenance.session_id;

    // Set criteria on the session
    const criteria = {
      min_budget_ratio: 0.4,
      required_capabilities: ['compute', 'encryption'],
      risk_tolerance: 'medium' as const
    };

    // Send a proposal with a budget share matching or exceeding the criteria
    const goodPayload = {
      proposed_role: 'compute_node',
      allocated_subtask_id: 'task_xyz',
      budget_share: 0.5,
      resource_claims: ['compute', 'encryption'],
      success_criteria_snapshot: {},
    };

    const evalOk = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'evaluate_proposal',
      session_id: sessionId,
      proposal_payload: goodPayload,
      evaluation_criteria: criteria
    });
    expect(evalOk.status).toBe('ok');

    // Send a proposal with insufficient budget_share
    const badPayload = {
      proposed_role: 'compute_node',
      allocated_subtask_id: 'task_xyz',
      budget_share: 0.2, // Below 0.4
      resource_claims: ['compute', 'encryption'],
      success_criteria_snapshot: {},
    };

    const evalRejected = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'evaluate_proposal',
      session_id: sessionId,
      proposal_payload: badPayload,
      evaluation_criteria: criteria
    });
    expect(evalRejected.status).toBe('rejected');
  });

  it('should require a valid cryptographic signature to sign agreements and reject plaintext or invalid ones', () => {
    const init = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'initiate_session',
      target_agent_id: 'signing_partner_agent'
    });
    const sessionId = init.provenance.session_id;

    const payload = {
      proposed_role: 'signer_role',
      allocated_subtask_id: 'task_sign',
      budget_share: 0.8,
      resource_claims: [],
      success_criteria_snapshot: {},
    };

    // Set active proposal
    InterAgentNegotiator.handle({
      scope: testScope,
      action: 'send_proposal',
      session_id: sessionId,
      proposal_payload: payload
    });

    // Attempt to sign with an invalid signature commitment
    const invalidSignRes = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'sign_agreement',
      session_id: sessionId,
      signature_commitment: 'absolutely_invalid_signature_hash'
    });
    expect(invalidSignRes.status).toBe('invalid_signature');

    // Generate a valid signature using the DelegatedAuthVault12 utility
    const signingKey = DelegatedAuthVault12.deriveSigningKey(testScope, 'signing_partner_agent');
    const validSignature = DelegatedAuthVault12.signPayload(signingKey, payload);

    const validSignRes = InterAgentNegotiator.handle({
      scope: testScope,
      action: 'sign_agreement',
      session_id: sessionId,
      signature_commitment: validSignature
    });
    expect(validSignRes.status).toBe('agreement_reached');
    expect(validSignRes.provenance.agreement_hash).toBeDefined();
  });
});
