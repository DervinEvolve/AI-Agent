import { redactSecrets } from '../capabilities/secret_redactor';

export interface Claim {
  id: string;
  content: string;
  tainted: boolean;
  metadata?: Record<string, unknown>;
  evidenceValidated?: boolean;
}

export type ClaimUsage = 'authorization' | 'HITL' | 'clearTaint' | 'toolArg' | 'export';

class ClaimLedger {
  private claims = new Map<string, Claim>();

  storeClaim(claim: Claim): Claim {
    const redactedContent = redactSecrets(claim.content);
    const trimmed = redactedContent.replace(/\[REDACTED\]/g, '').trim();
    if (trimmed.length < 5) {
      throw new Error('Claim storage rejected: content too ambiguous after secret redaction');
    }
    const stored: Claim = {
      id: claim.id,
      content: redactedContent,
      tainted: claim.tainted,
      metadata: claim.metadata ? { ...claim.metadata } : undefined,
      evidenceValidated: claim.evidenceValidated ?? false,
    };
    this.claims.set(claim.id, stored);
    return stored;
  }

  getClaim(id: string): Claim | undefined {
    return this.claims.get(id);
  }

  exportClaim(id: string): Pick<Claim, 'id' | 'content' | 'tainted'> & { metadata?: Record<string, unknown> } {
    const claim = this.claims.get(id);
    if (!claim) throw new Error('Claim not found');
    const safeContent = redactSecrets(claim.content);
    // Strip internal-only metadata (keys starting with 'internal-')
    const sanitizedMetadata = claim.metadata
      ? Object.fromEntries(
          Object.entries(claim.metadata).filter(([key]) => !key.startsWith('internal-'))
        )
      : undefined;
    return {
      id: claim.id,
      content: safeContent,
      tainted: claim.tainted,
      metadata: sanitizedMetadata,
    };
  }

  validateClaimUsage(claim: Claim, usage: ClaimUsage): void {
    switch (usage) {
      case 'authorization':
        throw new Error('Claims must not be used as authorization for any action');
      case 'HITL':
        throw new Error('Claims cannot satisfy HITL confirmation requirements');
      case 'clearTaint':
        throw new Error('Claims cannot clear taint or convert tainted evidence into trusted arguments');
      case 'toolArg':
        if (!claim.evidenceValidated) {
          throw new Error('Claim must be independently validated before being used as a tool argument');
        }
        break;
      case 'export':
        // export is allowed (content already redacted)
        break;
      default:
        throw new Error(`Unknown claim usage: ${usage}`);
    }
  }
}

const ledger = new ClaimLedger();

export function storeClaim(claim: Claim): Claim {
  return ledger.storeClaim(claim);
}

export function getClaim(id: string): Claim | undefined {
  return ledger.getClaim(id);
}

export function exportClaim(id: string): ReturnType<ClaimLedger['exportClaim']> {
  return ledger.exportClaim(id);
}

export function validateClaimEvidence(id: string): void {
  const claim = ledger.getClaim(id);
  if (!claim) throw new Error('Claim not found');
  claim.evidenceValidated = true;
}

export function enforceClaimConstraints(claim: Claim, usage: ClaimUsage): void {
  ledger.validateClaimUsage(claim, usage);
}

export function createClaim(partial: Partial<Claim> & { id: string; content: string }): Claim {
  return {
    tainted: false,
    evidenceValidated: false,
    ...partial,
  };
}

// The constraint definition object that can be added to constraints.constraints
export const conClaimLedgerNonAuthority19 = {
  id: 'con_claim_ledger_non_authority_19',
  name: 'Claim ledger non-authority and taint preservation',
  status: 'active' as const,
  added_epoch: 19,
  description:
    'The claim ledger must never be used to authorize side effects, clear taint, satisfy HITL confirmation requirements, directly set tool arguments, directly write long-term memory, or substitute for validated evidence. Claims are advisory synthesis only and must be independently validated before any action. Tainted claims remain tainted and cannot be used as sole evidence for success criteria, milestone completion, or skill verification. The ledger must not store raw secrets, OAuth tokens, private keys, browser cookies, approval tokens, or live auth state.',
  implementation: {
    tests: [
      'a claim cannot be used as the authorization for a browser/API dispatch',
      'a claim cannot satisfy a HITL gate or serve as an approval token',
      'a claim cannot clear taint or convert tainted evidence into trusted tool arguments',
      'a claim containing a raw secret is redacted before storage; if redaction makes the claim ambiguous, storage is rejected',
      'exported claims never contain raw secrets, live auth state, or internal-only metadata',
      'controller integration test verifies that claims are never passed directly to tool adapters as arguments without independent validation',
    ],
  },
};
