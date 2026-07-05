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
  isIndependentVerified?: boolean;
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
  public static containsActiveContent(payload: any): boolean {
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
   * Verifies taint status transition
   */
  public static verifyTaintTransition(
    currentTaint: boolean,
    proposedTaint: boolean,
    isIndependentVerified: boolean
  ): boolean {
    if (currentTaint && !proposedTaint) {
      return isIndependentVerified;
    }
    return true;
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
        reason: 'Payload contains active content, DTDs, or embedded scripts. Quarantined.',
        quarantined: true,
        policyBlocked: true
      };
    }

    // 2. Check if the action is irreversible or state-changing
    const isIrreversible = this.IRREVERSIBLE_ACTIONS.includes(request.action);
    if (isIrreversible) {
      if (!context.isDomesticHitlApproved) {
        return {
          allowed: false,
          reason: `Policy Blocked: Action '${request.action}' is irreversible or state-changing and lacks domestic HITL approval.`,
          policyBlocked: true,
          tainted: true
        };
      }
    }

    // All peer requests are permanently tainted by default unless explicitly verified
    return {
      allowed: true,
      reason: 'Request approved under isolation boundary constraints.',
      tainted: true
    };
  }

  /**
   * Signs data using a derived peer-signing key without exposing raw vault credentials
   */
  public static signWithDerivedKey(data: string, mockVaultKey: string): string {
    if (mockVaultKey.includes('primary_system_credential') || mockVaultKey.includes('oauth_token')) {
      throw new Error('Security Breach: Primary credentials cannot be used for peer-signing operations.');
    }
    return `sha256-derived-signature-for-${data}`;
  }
}
