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
    expect(responseWithHitl.tainted).toBe(true);
  });

  it('peer-signing operations do not expose raw vault keys or allow peers to query the local vault', () => {
    const mockVault = {
      primary_system_credential: 'super-secret-primary-oauth-token-xyz',
      other_data: 'public-info'
    };

    const derivedKey = InterAgentBoundaryProtection.derivePeerSigningKey(mockVault);
    expect(derivedKey).not.toContain('super-secret-primary-oauth-token-xyz');
    expect(derivedKey).toContain('derived-peer-signing-key');
  });

  it('proposals containing active content, DTDs, or embedded scripts are quarantined and rejected', () => {
    const requestWithDtd: PeerRequest = {
      peerId: 'peer-abc',
      action: 'propose_task',
      payload: { description: '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' }
    };

    const responseDtd = InterAgentBoundaryProtection.negotiateRequest(requestWithDtd);
    expect(responseDtd.allowed).toBe(false);
    expect(responseDtd.quarantined).toBe(true);
    expect(responseDtd.reason).toContain('quarantined');

    const requestWithScript: PeerRequest = {
      peerId: 'peer-abc',
      action: 'propose_task',
      payload: { description: '<script>alert(1)</script>' }
    };

    const responseScript = InterAgentBoundaryProtection.negotiateRequest(requestWithScript);
    expect(responseScript.allowed).toBe(false);
    expect(responseScript.quarantined).toBe(true);
  });
});
