/**
 * Constraint: Inter-agent boundary protection, isolation, and non-delegated authority (con_inter_agent_boundary_protection_29)
 * 
 * Establishes a robust security boundary around peer-to-peer agent interactions.
 * Ensures that peer agents are treated as external, untrusted entities, preventing peer exploitation,
 * authority leakage, credential exfiltration, and unauthorized tool execution.
 */

export interface PeerRequest {
  peerId: string;
  action: string;
  payload: Record<string, any>;
  signature?: string;
}

export interface SecurityContext {
  isDomesticHitlApproved?: boolean;
  taintFlags?: Record<string, boolean>;
}

export interface NegotiatorResponse {
  allowed: boolean;
  reason: string;
  tainted?: boolean;
  quarantined?: boolean;
  policyBlocked?: boolean;
}

export class InterAgentBoundaryProtection {
  private static readonly IRREVERSIBLE_ACTIONS = [
    'execute_code',
    'delete_memory',
    'clear_memory',
    'transfer_funds',
    'write_credentials',
    'invoke_local_tool',
    'access_browser',
    'access_desktop',
    'exfiltrate_credentials'
  ];

  /**
   * Detects active content, DTDs, or embedded scripts in any incoming payload
   */
  private static containsActiveContent(payload: any): boolean {
    if (!payload) return false;
    const str = JSON.stringify(payload).toLowerCase();
    
    // Look for typical DTDs, XML entities, script tags, or dangerous patterns
    if (str.includes('<!doctype') || str.includes('<!entity') || str.includes('<script')) {
      return true;
    }
    if (str.includes('javascript:') || str.includes('onload=') || str.includes('onerror=')) {
      return true;
    }
    return false;
  }

  /**
   * Processes peer-to-peer requests through the inter-agent negotiator protocol
   */
  public static negotiateRequest(
    request: PeerRequest,
    context: SecurityContext = {}
  ): NegotiatorResponse {
    // 1. Check for active content / DTDs / embedded scripts (Quarantine immediately)
    if (this.containsActiveContent(request.payload)) {
      return {
        allowed: false,
        reason: 'Payload quarantined: Active content, DTD, or embedded script detected.',
        quarantined: true
      };
    }

    // 2. Peer agents cannot directly invoke local tools or run code
    if (request.action === 'invoke_local_tool' || request.action === 'execute_code') {
      return {
        allowed: false,
        reason: 'Policy Blocked: Peer agents cannot directly invoke local tools or execute code.',
        policyBlocked: true
      };
    }

    // 3. Actions classified as irreversible, state-changing, or identity-bearing must fail closed unless HITL approved
    const isIrreversible = this.IRREVERSIBLE_ACTIONS.includes(request.action);
    if (isIrreversible && !context.isDomesticHitlApproved) {
      return {
        allowed: false,
        reason: 'Policy Blocked: Irreversible, state-changing, or identity-bearing action requires domestic HITL approval.',
        policyBlocked: true
      };
    }

    // 4. Any accepted request derived from peer proposals is permanently marked as tainted
    return {
      allowed: true,
      reason: 'Negotiation successful under isolated sandbox conditions.',
      tainted: true
    };
  }

  /**
   * Verifies that peer proposals cannot bypass or clear local taint flags without independent verification
   */
  public static verifyTaintTransition(
    currentTaint: boolean,
    requestedTaint: boolean,
    independentlyVerified: boolean
  ): boolean {
    if (currentTaint && !requestedTaint) {
      // Peer is trying to clear/bypass a taint flag
      return independentlyVerified;
    }
    return true;
  }

  /**
   * Derives a dedicated peer-signing key from the vault without exposing primary system credentials
   */
  public static derivePeerSigningKey(vault: Record<string, string>): string {
    const primaryKey = vault['primary_system_credential'] || vault['oauth_token'] || vault['private_key'];
    if (!primaryKey) {
      throw new Error('Primary credentials missing in vault.');
    }
    
    // Return a derived cryptographic key representation, ensuring primary key is never exposed
    // Mocking standard SHA-256 derivation for safety boundary contract
    return `derived-peer-signing-key-from-${primaryKey.length}-bytes`;
  }
}
