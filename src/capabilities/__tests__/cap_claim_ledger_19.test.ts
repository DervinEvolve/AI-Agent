import { describe, it, expect, beforeEach } from 'vitest';
import { claimLedger, ClaimInputSchema } from '../cap_claim_ledger_19';
import { redactSecrets } from '../secret_redactor';

// Mock secret_redactor to return original string (no secrets) for most tests,
// but allow override for redaction tests.
vi.mock('../secret_redactor', () => ({
  redactSecrets: vi.fn((input: string) => input),
}));

const mockedRedact = vi.mocked(redactSecrets);

beforeEach(() => {
  mockedRedact.mockClear();
  mockedRedact.mockImplementation((input: string) => input);
});

// Helper to create a valid claim input
const validClaim = () => ({
  statement: 'The sky is blue',
  source_refs: [{ type: 'observation', id: 'obs1', tainted: false }],
  confidence: 0.9,
  freshness: new Date().toISOString(),
  tags: ['test'],
  scope: { task: 'test' },
});

describe('claim_ledger capability', () => {
  describe('add_claim', () => {
    it('stores a claim with statement, source_refs, confidence, freshness, scope, and initial version=1; returns claim_id and provenance', async () => {
      const result = await claimLedger({
        action: 'add_claim',
        claim: validClaim(),
      });
      expect(result.status).toBe('ok');
      expect(result.claim).toBeDefined();
      expect(result.claim.version).toBe(1);
      expect(result.claim.statement).toBe('The sky is blue');
      expect(result.claim.source_refs).toHaveLength(1);
      expect(result.claim.confidence).toBe(0.9);
      expect(result.claim.tainted).toBe(false);
      expect(result.provenance).toBeDefined();
      expect(result.provenance.claim_id).toBeDefined();
      expect(result.provenance.version).toBe(1);
      expect(result.provenance.mutation_log).toHaveLength(1);
    });

    it('marks claim as tainted if any source_ref is tainted', async () => {
      const result = await claimLedger({
        action: 'add_claim',
        claim: {
          ...validClaim(),
          source_refs: [{ type: 'observation', id: 'obs2', tainted: true }],
        },
      });
      expect(result.status).toBe('ok');
      expect(result.claim.tainted).toBe(true);
      // Tainted claims are still stored but flagged
      expect(result.claim.statement).toBe('The sky is blue');
    });
  });

  describe('update_claim', () => {
    it('creates a new version with mutation log entry; never overwrites previous versions', async () => {
      // First add a claim
      const addResult = await claimLedger({
        action: 'add_claim',
        claim: validClaim(),
      });
      expect(addResult.status).toBe('ok');
      const claimId = addResult.provenance.claim_id;

      // Update the claim (change confidence)
      const updateResult = await claimLedger({
        action: 'update_claim',
        claim_id: claimId,
        claim: { confidence: 0.5 },
      });
      expect(updateResult.status).toBe('ok');
      expect(updateResult.claim).toBeDefined();
      expect(updateResult.claim.version).toBe(2);
      expect(updateResult.claim.confidence).toBe(0.5);
      // Statement should remain unchanged
      expect(updateResult.claim.statement).toBe('The sky is blue');
      // Mutation log should have grown
      expect(updateResult.provenance.mutation_log).toHaveLength(2);
      // The original claim should still be retrievable as version 1 (implicitly via provenance)
      // but we can't fetch version 1 directly here; just confirm mutation_log contains two entries.
    });

    it('rejects update if claim_id not found', async () => {
      const result = await claimLedger({
        action: 'update_claim',
        claim_id: 'nonexistent-id',
        claim: { confidence: 0.5 },
      });
      expect(result.status).not.toBe('ok');
      expect(result.error).toBeDefined();
    });

    it('rejects update if scope mismatch (simulated via different scope)', async () => {
      // Add a claim with a specific scope
      const addResult = await claimLedger({
        action: 'add_claim',
        claim: { ...validClaim(), scope: { task: 'secret-project' } },
      });
      expect(addResult.status).toBe('ok');
      const claimId = addResult.provenance.claim_id;

      // Attempt update with a different scope (the ledger should reject based on scope authorization)
      // We'll pass the claim update with a scope that doesn't match; the implementation should block.
      const result = await claimLedger({
        action: 'update_claim',
        claim_id: claimId,
        claim: { scope: { task: 'other-project' } },
      });
      expect(result.status).not.toBe('ok');
      expect(result.error).toBeDefined();
    });
  });

  describe('secret redaction', () => {
    it('rejects storage if redaction makes claim ambiguous', async () => {
      // Mock redactSecrets to return an empty string (ambiguous)
      mockedRedact.mockReturnValueOnce('');

      const result = await claimLedger({
        action: 'add_claim',
        claim: {
          ...validClaim(),
          statement: 'my api key is sk-1234',
        },
      });
      expect(result.status).not.toBe('ok');
      expect(result.error).toBeDefined();
    });

    it('stores claim if redaction does not make it ambiguous', async () => {
      // Mock redactSecrets to return a redacted but still meaningful statement
      mockedRedact.mockReturnValueOnce('my api key is [REDACTED]');

      const result = await claimLedger({
        action: 'add_claim',
        claim: {
          ...validClaim(),
          statement: 'my api key is sk-1234',
        },
      });
      expect(result.status).toBe('ok');
      expect(result.claim.statement).toBe('my api key is [REDACTED]');
    });
  });

  describe('resolve_contradictions', () => {
    it('returns a contradiction report for two conflicting claims', async () => {
      // Add two claims that might conflict
      const claim1 = await claimLedger({
        action: 'add_claim',
        claim: { ...validClaim(), statement: 'The sky is blue' },
      });
      const claim2 = await claimLedger({
        action: 'add_claim',
        claim: { ...validClaim(), statement: 'The sky is red', confidence: 0.8 },
      });
      expect(claim1.status).toBe('ok');
      expect(claim2.status).toBe('ok');

      const result = await claimLedger({
        action: 'resolve_contradictions',
        contradiction_pair: [claim1.provenance.claim_id, claim2.provenance.claim_id],
      });
      expect(result.status).toBe('ok');
      expect(result.contradiction_report).toBeDefined();
      expect(result.contradiction_report.claim_a).toBe(claim1.provenance.claim_id);
      expect(result.contradiction_report.claim_b).toBe(claim2.provenance.claim_id);
      expect(result.contradiction_report.conflict_type).toBeDefined();
      expect(result.contradiction_report.resolution_suggestion).toBeDefined();
    });
  });

  describe('evaluate_confidence', () => {
    it('recalculates confidence and returns updated claim with new version', async () => {
      const addResult = await claimLedger({
        action: 'add_claim',
        claim: validClaim(),
      });
      expect(addResult.status).toBe('ok');
      const claimId = addResult.provenance.claim_id;

      const evalResult = await claimLedger({
        action: 'evaluate_confidence',
        claim_id: claimId,
      });
      expect(evalResult.status).toBe('ok');
      expect(evalResult.claim).toBeDefined();
      expect(evalResult.claim.version).toBe(2);
      expect(evalResult.claim.confidence).toBeDefined();
      // The confidence may have changed based on internal rules; we just verify it's a number
      expect(typeof evalResult.claim.confidence).toBe('number');
      expect(evalResult.provenance.mutation_log).toHaveLength(2);
    });
  });

  describe('retrieve_claims', () => {
    it('returns claims matching filters and semantic query', async () => {
      // Add a claim with specific tags
      await claimLedger({
        action: 'add_claim',
        claim: { ...validClaim(), tags: ['important'], statement: 'Important observation' },
      });

      const result = await claimLedger({
        action: 'retrieve_claims',
        query: {
          filters: { tags: ['important'] },
          semantic_query: 'observation',
          max_results: 5,
        },
        scope: { task: 'test' },
      });
      expect(result.status).toBe('ok');
      expect(result.candidates).toBeDefined();
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates[0].statement).toBe('Important observation');
    });

    it('never returns deleted or out-of-scope claims', async () => {
      // Add a claim with a different scope
      await claimLedger({
        action: 'add_claim',
        claim: { ...validClaim(), scope: { task: 'other' }, statement: 'Out of scope' },
      });

      const result = await claimLedger({
        action: 'retrieve_claims',
        query: { filters: {} },
        scope: { task: 'test' },
      });
      expect(result.status).toBe('ok');
      const outOfScopeClaim = result.candidates.find((c: any) => c.statement === 'Out of scope');
      expect(outOfScopeClaim).toBeUndefined();
    });
  });
});
