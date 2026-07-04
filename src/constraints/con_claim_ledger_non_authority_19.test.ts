import {
  storeClaim,
  exportClaim,
  enforceClaimConstraints,
  createClaim,
  validateClaimEvidence,
} from './con_claim_ledger_non_authority_19';
import { redactSecrets } from '../capabilities/secret_redactor';

describe('Claim ledger non-authority constraint', () => {
  const taintedClaim = createClaim({ id: 'tainted-1', content: 'User reported success', tainted: true });
  const cleanClaim = createClaim({ id: 'clean-1', content: 'Evidence shows success', tainted: false });

  describe('authorization / HITL / clearTaint prohibitions', () => {
    it('a claim cannot be used as the authorization for a browser/API dispatch', () => {
      expect(() => enforceClaimConstraints(cleanClaim, 'authorization')).toThrow(
        'Claims must not be used as authorization for any action',
      );
    });

    it('a claim cannot satisfy a HITL gate or serve as an approval token', () => {
      expect(() => enforceClaimConstraints(cleanClaim, 'HITL')).toThrow(
        'Claims cannot satisfy HITL confirmation requirements',
      );
    });

    it('a claim cannot clear taint or convert tainted evidence into trusted tool arguments', () => {
      expect(() => enforceClaimConstraints(taintedClaim, 'clearTaint')).toThrow(
        'Claims cannot clear taint or convert tainted evidence into trusted arguments',
      );
    });
  });

  describe('secret redaction during storage', () => {
    it('redacts raw secrets and rejects storage if content becomes ambiguous', () => {
      const secretOnlyClaim = createClaim({ id: 'secret-only', content: 'password123' });
      const redacted = redactSecrets(secretOnlyClaim.content);
      // Assuming redaction replaces the secret, leaving only [REDACTED] or similar
      expect(() => storeClaim(secretOnlyClaim)).toThrow(
        'Claim storage rejected: content too ambiguous after secret redaction',
      );
    });

    it('stores claim when redaction leaves sufficient context', () => {
      const okClaim = createClaim({ id: 'ok-context', content: 'The API key is abc123 but result is valid' });
      const stored = storeClaim(okClaim);
      expect(stored.content).not.toContain('abc123');
      expect(stored.content).toContain('The API key is');
      expect(stored.content).toContain('[REDACTED]');
      expect(stored.tainted).toBe(false);
    });

    it('preserves taint during storage even after redaction', () => {
      const taintedSecretClaim = createClaim({
        id: 'tainted-secret',
        content: 'key=secret, but evidence is tainted',
        tainted: true,
      });
      const stored = storeClaim(taintedSecretClaim);
      expect(stored.tainted).toBe(true);
      expect(stored.content).not.toContain('secret');
    });
  });

  describe('exported claims safety', () => {
    it('exported claims never contain raw secrets, live auth state, or internal-only metadata', () => {
      const claimWithInternalMeta = createClaim({
        id: 'export-test',
        content: 'Some claim with token 12345',
        tainted: false,
        metadata: {
          'internal-token': 'should-be-stripped',
          publicNote: 'hello',
        },
      });
      storeClaim(claimWithInternalMeta);

      const exported = exportClaim('export-test');
      expect(exported.content).not.toContain('12345');
      // Internal metadata field removed
      expect(exported.metadata).toBeDefined();
      expect(exported.metadata).not.toHaveProperty('internal-token');
      expect(exported.metadata).toHaveProperty('publicNote', 'hello');
    });
  });

  describe('tool argument validation', () => {
    it('rejects claims used as tool arguments without independent validation', () => {
      expect(() => enforceClaimConstraints(cleanClaim, 'toolArg')).toThrow(
        'Claim must be independently validated before being used as a tool argument',
      );
    });

    it('allows claim as tool argument after independent evidence validation', () => {
      storeClaim(cleanClaim);
      validateClaimEvidence(cleanClaim.id);
      expect(() => enforceClaimConstraints(cleanClaim, 'toolArg')).not.toThrow();
    });

    it('allows tainted claim as tool argument if validated (taint remains but does not block tool usage)', () => {
      const taintedValidated = createClaim({ id: 'tv-1', content: 'tainted but validated', tainted: true });
      storeClaim(taintedValidated);
      validateClaimEvidence('tv-1');
      expect(() => enforceClaimConstraints(taintedValidated, 'toolArg')).not.toThrow();
    });
  });

  describe('controller integration test', () => {
    it('verifies that claims are never passed directly to tool adapters as arguments without independent validation', () => {
      const claim = createClaim({ id: 'integ-1', content: 'some conclusion' });
      function toolAdapter(claimArg: unknown) {
        enforceClaimConstraints(claim as any, 'toolArg');
        return 'action executed';
      }

      // Without validation, should throw
      expect(() => toolAdapter(claim)).toThrow();

      // After validation, should work
      storeClaim(claim);
      validateClaimEvidence(claim.id);
      expect(() => toolAdapter(claim)).not.toThrow();
    });
  });
});
