import { secretRedactor } from './secret_redactor';
import { DelegatedAuthVault12 } from './cap_delegated_auth_vault_12';
import * as crypto from 'crypto';

export interface Scope {
  user_id: string;
  project_id: string;
  namespace: string;
}

export interface ProposalPayload {
  proposed_role: string;
  allocated_subtask_id: string;
  budget_share: number;
  resource_claims: string[];
  success_criteria_snapshot: Record<string, any>;
  compensation_clauses?: Record<string, any>[];
}

export interface EvaluationCriteria {
  min_budget_ratio: number;
  required_capabilities: string[];
  risk_tolerance: 'low' | 'medium' | 'high';
}

export interface NegotiationMessage {
  sender: string;
  payload: ProposalPayload;
  timestamp: number;
  signature: string;
  tainted: boolean;
}

export interface NegotiationSession {
  session_id: string;
  scope: Scope;
  status: 'pending_response' | 'agreement_reached' | 'rejected' | 'terminated' | 'policy_blocked' | 'invalid_signature' | 'timeout' | 'limit_exceeded';
  initiator_id: string;
  peer_id: string;
  round_count: number;
  updated_at: number;
  history: NegotiationMessage[];
  active_proposal?: ProposalPayload;
  local_commitments: string[];
  tainted: boolean;
  agreement_hash?: string;
  evaluation_criteria?: EvaluationCriteria;
}

export interface NegotiatorInput {
  scope: Scope;
  action: 'initiate_session' | 'send_proposal' | 'evaluate_proposal' | 'sign_agreement' | 'terminate_session' | 'get_negotiation_state' | 'list_active_sessions';
  session_id?: string;
  target_agent_id?: string;
  proposal_payload?: ProposalPayload;
  evaluation_criteria?: EvaluationCriteria;
  signature_commitment?: string;
  tainted_input?: boolean; // explicit flag for simulation/testing of incoming tainted observations
}

export interface NegotiatorOutput {
  status: 'ok' | 'pending_response' | 'agreement_reached' | 'rejected' | 'terminated' | 'policy_blocked' | 'invalid_signature' | 'timeout' | 'limit_exceeded';
  tainted: boolean;
  provenance: {
    session_id: string;
    initiator_id: string;
    peer_id: string;
    round_count: number;
    updated_at: number;
    agreement_hash_optional?: string;
  };
  negotiation_state?: {
    session_id: string;
    status: string;
    history: { sender: string; payload: any; timestamp: number; signature: string }[];
    active_proposal?: any;
    local_commitments: string[];
  };
}

// Mock database/in-memory store for negotiation sessions
const sessionsStore = new Map<string, NegotiationSession>();

// Track simulated trace_eval events for verification
export const traceEvalEvents: any[] = [];

function emitTraceEval(event: string, data: any) {
  // Run everything through the secret redactor first to prevent raw secrets, keys, or private tokens from leaking
  const safeData = secretRedactor.redact(data);
  traceEvalEvents.push({ event, data: safeData, timestamp: Date.now() });
}

export class InterAgentNegotiator {
  private static MAX_ROUND_LIMIT = 15;
  private static TIMEOUT_SECONDS = 1800;
  private static MAX_CHAR_LIMIT = 5000;

  static handle(input: NegotiatorInput): NegotiatorOutput {
    const now = Math.floor(Date.now() / 1000);

    // 1. Validate Scope
    if (!input.scope || !input.scope.user_id || !input.scope.project_id || !input.scope.namespace) {
      throw new Error('Invalid scope authorized through memory policy');
    }

    // Handle list_active_sessions action
    if (input.action === 'list_active_sessions') {
      const active = Array.from(sessionsStore.values()).filter(
        s => s.scope.user_id === input.scope.user_id && s.scope.project_id === input.scope.project_id
      );
      emitTraceEval('list_active_sessions', { count: active.length });
      return {
        status: 'ok',
        tainted: false,
        provenance: {
          session_id: 'batch',
          initiator_id: 'system',
          peer_id: 'system',
          round_count: 0,
          updated_at: Date.now()
        }
      };
    }

    // Handle initiate_session action
    if (input.action === 'initiate_session') {
      if (!input.target_agent_id) {
        throw new Error('target_agent_id is required to initiate a session');
      }
      const session_id = crypto.randomUUID();
      const session: NegotiationSession = {
        session_id,
        scope: input.scope,
        status: 'pending_response',
        initiator_id: 'local_agent',
        peer_id: input.target_agent_id,
        round_count: 0,
        updated_at: now,
        history: [],
        local_commitments: [],
        tainted: !!input.tainted_input,
        evaluation_criteria: input.evaluation_criteria
      };
      sessionsStore.set(session_id, session);

      emitTraceEval('negotiation_session_initiated', { session_id, peer_id: input.target_agent_id });

      return this.formatOutput(session);
    }

    // For all other actions, a session_id is strictly required
    if (!input.session_id) {
      throw new Error('session_id is required for this action');
    }

    const session = sessionsStore.get(input.session_id);
    if (!session) {
      throw new Error(`Session with ID ${input.session_id} not found`);
    }

    // Enforce Timeout check (1800 seconds)
    if (now - session.updated_at > this.TIMEOUT_SECONDS && session.status === 'pending_response') {
      session.status = 'timeout';
      session.updated_at = now;
      emitTraceEval('negotiation_session_timeout', { session_id: session.session_id });
      return this.formatOutput(session);
    }

    // If session is already in a terminal state, reject further actions except reading state
    if (input.action !== 'get_negotiation_state' && session.status !== 'pending_response') {
      return this.formatOutput(session);
    }

    switch (input.action) {
      case 'get_negotiation_state':
        return this.formatOutput(session);

      case 'terminate_session':
        session.status = 'terminated';
        session.updated_at = now;
        emitTraceEval('negotiation_session_terminated', { session_id: session.session_id });
        return this.formatOutput(session);

      case 'send_proposal': {
        if (!input.proposal_payload) {
          throw new Error('proposal_payload is required to send a proposal');
        }

        // Enforce maximum character limits on payloads
        const payloadStr = JSON.stringify(input.proposal_payload);
        if (payloadStr.length > this.MAX_CHAR_LIMIT) {
          session.status = 'limit_exceeded';
          session.updated_at = now;
          emitTraceEval('negotiation_limit_exceeded', { session_id: session.session_id, reason: 'payload length' });
          return this.formatOutput(session);
        }

        // Increment round counter
        session.round_count += 1;
        if (session.round_count > this.MAX_ROUND_LIMIT) {
          session.status = 'limit_exceeded';
          session.updated_at = now;
          emitTraceEval('negotiation_limit_exceeded', { session_id: session.session_id, reason: 'max rounds' });
          return this.formatOutput(session);
        }

        // Monotonic Taint propagation: peer messages are tainted=true by default.
        // If input signals peer input or is explicitly tainted, taint propagates permanently.
        const isPeerMessage = input.target_agent_id === session.initiator_id; 
        const messageTainted = isPeerMessage || !!input.tainted_input;
        if (messageTainted) {
          session.tainted = true;
        }

        // Generate cryptographic signature using vault
        const key = DelegatedAuthVault12.deriveSigningKey(session.scope, 'local_agent');
        const sig = DelegatedAuthVault12.signPayload(key, input.proposal_payload);

        const message: NegotiationMessage = {
          sender: isPeerMessage ? session.peer_id : 'local_agent',
          payload: input.proposal_payload,
          timestamp: now,
          signature: sig,
          tainted: messageTainted
        };

        session.history.push(message);
        session.active_proposal = input.proposal_payload;
        session.updated_at = now;

        emitTraceEval('negotiation_proposal_sent', {
          session_id: session.session_id,
          round: session.round_count,
          tainted: message.tainted
        });

        return this.formatOutput(session);
      }

      case 'evaluate_proposal': {
        if (!session.active_proposal) {
          throw new Error('No active proposal to evaluate');
        }

        const criteria = input.evaluation_criteria || session.evaluation_criteria;
        if (!criteria) {
          throw new Error('Evaluation criteria must be provided or registered first');
        }

        // Evaluate proposal terms against local criteria
        const prop = session.active_proposal;
        let accepted = true;

        if (prop.budget_share < criteria.min_budget_ratio) {
          accepted = false;
        }

        // Check for required capabilities
        if (criteria.required_capabilities && criteria.required_capabilities.length > 0) {
          // In a real environment, we'd check peer capabilities. Here we pass unless mock fails.
        }

        // Reject delegation attempts that bypass HITL approvals
        // If a proposal demands side-effects or high-risk actions without HITL, reject or force pending_approval
        if (criteria.risk_tolerance === 'low' && prop.resource_claims && prop.resource_claims.includes('side_effect')) {
          session.status = 'policy_blocked';
          session.updated_at = now;
          emitTraceEval('negotiation_policy_blocked', { session_id: session.session_id, reason: 'unauthorized side-effect request' });
          return this.formatOutput(session);
        }

        if (accepted) {
          session.status = 'agreement_reached';
        } else {
          session.status = 'rejected';
        }

        session.updated_at = now;
        emitTraceEval('negotiation_proposal_evaluated', { session_id: session.session_id, status: session.status });
        return this.formatOutput(session);
      }

      case 'sign_agreement': {
        if (!session.active_proposal) {
          throw new Error('No active proposal to sign');
        }
        if (!input.signature_commitment) {
          // Plaintext agreements without signatures are rejected
          session.status = 'invalid_signature';
          session.updated_at = now;
          emitTraceEval('negotiation_invalid_signature', { session_id: session.session_id });
          return this.formatOutput(session);
        }

        // Verify cryptographic binding hash representing agreement to terms
        const key = DelegatedAuthVault12.deriveSigningKey(session.scope, 'local_agent');
        const expectedSig = DelegatedAuthVault12.signPayload(key, session.active_proposal);

        if (input.signature_commitment !== expectedSig) {
          session.status = 'invalid_signature';
          session.updated_at = now;
          emitTraceEval('negotiation_invalid_signature', { session_id: session.session_id });
          return this.formatOutput(session);
        }

        session.agreement_hash = crypto.createHash('sha256').update(expectedSig).digest('hex');
        session.status = 'agreement_reached';
        session.updated_at = now;

        emitTraceEval('negotiation_agreement_signed', {
          session_id: session.session_id,
          agreement_hash: session.agreement_hash
        });

        return this.formatOutput(session);
      }

      default:
        throw new Error(`Unsupported negotiator action: ${input.action}`);
    }
  }

  private static formatOutput(session: NegotiationSession): NegotiatorOutput {
    return {
      status: session.status,
      tainted: session.tainted,
      provenance: {
        session_id: session.session_id,
        initiator_id: session.initiator_id,
        peer_id: session.peer_id,
        round_count: session.round_count,
        updated_at: session.updated_at * 1000,
        agreement_hash_optional: session.agreement_hash
      },
      negotiation_state: {
        session_id: session.session_id,
        status: session.status,
        history: session.history.map(h => ({
          sender: h.sender,
          payload: h.payload,
          timestamp: h.timestamp * 1000,
          signature: h.signature
        })),
        active_proposal: session.active_proposal,
        local_commitments: session.local_commitments
      }
    };
  }
}
