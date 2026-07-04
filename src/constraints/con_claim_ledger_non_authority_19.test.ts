import { ClaimLedger } from './con_claim_ledger_non_authority_19';
import { redactSecrets } from '../capabilities/secret_redactor';

describe('ClaimLedger', () => {
  let ledger: ClaimLedger;

  beforeEach(() => {
    ledger = new ClaimLedger();
  });

  const sampleClaim = {
    id: 'c1',
    content: 'Service operational after patching',
    tainted: true,
    metadata: { source: 'monitor', 'internal-audit-id': 'abc123' },
    evidenceValidated: false,
  };

  describe('storeClaim()', () => {
    it('stores a claim and redacts secrets in content', () => {
      const withSecret = { ...sampleClaim, content: 'API token: sk-12345-abcdef' };
      const stored = ledger.storeClaim(withSecret);
      expect(stored.content).not.toContain('sk-12345-abcdef');
      expect(stored.content).toContain('[REDACTED]');
      expect(stored.tainted).toBe(true);
      expect(stored.metadata).toEqual(sampleClaim.metadata);
      expect(stored.evidenceValidated).toBe(false);

      const retrieved = ledger.getClaim('c1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.content).toEqual(stored.content);
    });

    it('rejects storage when redaction makes content too ambiguous', () => {
      const secretOnly = { ...sampleClaim, content: '123-45-6789' };
      // redactSecrets will replace the entire string if it matches a secret pattern,
      // leaving only placeholders. After trimming, content may become too short.
      expect(() => ledger.storeClaim(secretOnly)).toThrow(
        'Claim storage rejected: content too ambiguous after secret redaction'
      );
    });

    it('allows storage when redaction leaves enough context', () => {
      const mixed = { ...sampleClaim, content: 'User verified with password: [REDACTED] on login page' };
      // The redaction already present; redactSecrets may re-apply but overall content remains.
      const stored = ledger.storeClaim(mixed);
      expect(stored.content).toBeDefined();
      expect(stored.content.length).toBeGreaterThanOrEqual(5);
    });

    it('preserves evidenceValidated flag', () => {
      const claim = { ...sampleClaim, evidenceValidated: true };
      const stored = ledger.storeClaim(claim);
      expect(stored.evidenceValidated).toBe(true);
    });
  });

  describe('getClaim()', () => {
    it('returns stored claim by id', () => {
      ledger.storeClaim(sampleClaim);
      const claim = ledger.getClaim('c1');
      expect(claim).toBeDefined();
      expect(claim!.id).toBe('c1');
    });

    it('returns undefined for missing claim', () => {
      expect(ledger.getClaim('nonexistent')).toBeUndefined();
    });
  });

  describe('exportClaim()', () => {
    it('exports a sanitised snapshot without internal metadata', () => {
      ledger.storeClaim(sampleClaim);
      const snapshot = ledger.exportClaim('c1');
      expect(snapshot.id).toBe('c1');
      expect(snapshot.content).toEqual(sampleClaim.content); // no secret in this test
      expect(snapshot.tainted).toBe(true);
      expect(snapshot.metadata).toEqual({ source: 'monitor' }); // internal-audit-id stripped
    });

    it('re-redacts content to ensure no secrets leak', () => {
      const withSecret = { ...sampleClaim, content: 'Token: sk-live-abcdef' };
      ledger.storeClaim(withSecret);
      const snapshot = ledger.exportClaim('c1');
      expect(snapshot.content).not.toContain('sk-live-abcdef');
      expect(snapshot.content).toContain('[REDACTED]');
    });

    it('throws if claim is not found', () => {
      expect(() => ledger.exportClaim('missing')).toThrow();
    });
  });

  describe('validateClaimUsage()', () => {
    it('throws when claim is used as authorization', () => {
      const claim = ledger.storeClaim(sampleClaim);
      expect(() => ledger.validateClaimUsage(claim, 'authorization')).toThrow();
    });

    it('throws when claim is used as HITL confirmation', () => {
      const claim = ledger.storeClaim(sampleClaim);
      expect(() => ledger.validateClaimUsage(claim, 'HITL')).toThrow();
    });

    it('throws when claim is used to clear taint', () => {
      const claim = ledger.storeClaim(sampleClaim);
      expect(() => ledger.validateClaimUsage(claim, 'clearTaint')).toThrow();
    });

    it('throws when claim is used as direct tool argument', () => {
      const claim = ledger.storeClaim(sampleClaim);
      // 'toolArg' is defined in ClaimUsage – must be rejected
      expect(() => ledger.validateClaimUsage(claim, 'toolArg')).toThrow();
    });

    it('allows advisory usage (export) without throwing', () => {
      const claim = ledger.storeClaim(sampleClaim);
      // 'export' may be allowed as an advisory usage; we do not expect it to throw unless
      // the implementation explicitly forbids it. If forbidden, adapt test accordingly.
      // Currently exportClaim() itself is allowed, so we assume 'export' usage is not restricted.
      expect(() => ledger.validateClaimUsage(claim, 'export')).not.toThrow();
    });
  });
});
