import { describe, it, expect } from 'vitest';
import { InterAgentBoundaryProtection, PeerRequest } from '../con_inter_agent_boundary_protection_29';

describe('con_inter_agent_boundary_protection_29', () => {
  it('should block peer agent attempting to execute code or call local tools directly', () => {
    const request: PeerRequest = {
      peerId: 'peer-999',
      action: 'execute_code',
      payload: { code: 'console.log("exploit")' }
    };

    const response = InterAgentBoundaryProtection.negotiateRequest(request);
    expect(response.allowed).toBe(false);
    expect(response.policyBlocked).toBe(true);
    expect(response.reason).toContain('Policy Blocked');
  });

  it('proposals from peer agents cannot clear local taint flags without independent verification', () => {
    const currentTaint = true;
    const peerProposalTaintClear = false;

    // Without independent verification, clearing the taint flag is blocked
    const outcomeWithoutVerification = InterAgentBoundaryProtection.verifyTaintTransition(
      currentTaint,
      peerProposalTaintClear,
      false
    );
    expect(outcomeWithoutVerification).toBe(false);

    // With independent verification, clearing the taint flag is permitted
    const outcomeWithVerification = InterAgentBoundaryProtection.verifyTaintTransition(
      currentTaint,
      peerProposalTaintClear,
      true
    );
    expect(outcomeWithVerification).toBe(true);
  });

  it('actions classified as irreversible, state-changing, or identity-bearing must fail closed unless approved by HITL', () => {
    const request: PeerRequest = { 
      peerId: 'peer-123',
      action: 'transfer_funds',
      payload: { amount: 1000 }
    };

    // Fails closed without HITL
    const responseNoHitl = InterAgentBoundaryProtection.negotiateRequest(request, {
      isDomesticHitlApproved: false
    });
    expect(responseNoHitl.allowed).toBe(false);
    expect(responseNoHitl.policyBlocked).toBe(true);

    // Succeeds with domestic HITL
    const responseWithHitl = InterAgentBoundaryProtection.negotiateRequest(request, {
      isDomesticHitlApproved: true
    });
    expect(responseWithHitl.allowed).toBe(true);
  });

  it('should quarantine and reject payloads containing active content, DTDs, or embedded scripts', () => {
    const requestWithScript: PeerRequest = {
      peerId: 'peer-malicious',
      action: 'process_data',
      payload: { value: '<script>alert("XSS")</script>' }
    };

    const response = InterAgentBoundaryProtection.negotiateRequest(requestWithScript);
    expect(response.allowed).toBe(false);
    expect(response.quarantined).toBe(true);
    expect(response.reason).toContain('active content');
  });

  it('should prevent peer-signing operations from exposing raw primary credentials', () => {
    const dataToSign = 'negotiation-proposal-v1';
    
    // Safe derived signing key should succeed
    const signature = InterAgentBoundaryProtection.signWithDerivedKey(dataToSign, 'peer_signing_key_derived_from_vault');
    expect(signature).toContain('sha256-derived-signature-for');

    // Using primary system credential must throw
    expect(() => {
      InterAgentBoundaryProtection.signWithDerivedKey(dataToSign, 'primary_system_credential_secret');
    }).toThrow('Security Breach');
  });
});
