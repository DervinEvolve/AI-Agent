import { describe, it, expect, beforeEach } from 'vitest';
import {
  ClaimLedger,
  synthesizeAndRecord,
  evaluateDecisionContext,
  wrapResultWithClaimFlags,
  evaluateCriterion,
  checkSuccessCriterionTaint,
} from '../beh_evidence_grounded_claims_19';
import type { Source } from '../beh_evidence_grounded_claims_19';

describe('Evidence-grounded claim synthesis and verification behavior', () => {
  let ledger: ClaimLedger;

  beforeEach(() => {
    ledger = new ClaimLedger();
    ledger.clearTrace();
  });

  describe('Claim Ledger basic operations', () => {
    it('should add a claim and retrieve it', () => {
      const claim = ledger.addClaim('Test statement', ['src1'], 0.9);
      expect(claim.id).toBeDefined();
      expect(claim.statement).toBe('Test statement');
      expect(claim.sources).toEqual(['src1']);
      expect(claim.tainted).toBe(false);

      const retrieved = ledger.getClaim(claim.id);
      expect(retrieved).toEqual(claim);
    });

    it('should record trace events for operations', () => {
      ledger.clearTrace();
      const claim = ledger.addClaim('Trace test', ['s1'], 0.8);
      const trace = ledger.getTrace();
      expect(trace.length).toBeGreaterThanOrEqual(1);
      const addEvent = trace.find((e) => e.type === 'add_claim');
      expect(addEvent).toBeTruthy();
      expect(addEvent?.claimId).toBe(claim.id);

      ledger.verifyContradictions(claim.id);
      const updatedTrace = ledger.getTrace();
      expect(updatedTrace.filter((e) => e.type === 'verify_contradictions')).toHaveLength(1);
    });

    it('should detect contradictions when identical statement added from different source', () => {
      const c1 = ledger.addClaim('The sky is blue', ['src_a'], 0.95);
      const c2 = ledger.addClaim('The sky is blue', ['src_b'], 0.95);
      expect(c1.contradictions).toContain(c2.id);
      expect(c2.contradictions).toContain(c1.id);

      const { contradictions } = ledger.verifyContradictions(c1.id);
      expect(contradictions).toHaveLength(1);
      expect(contradictions[0].id).toBe(c2.id);
    });

    it('should propagate taint from a source claim to a derived claim', () => {
      const srcClaim = ledger.addClaim('Original', ['ext'], 0.9, undefined, undefined, false);
      expect(srcClaim.tainted).toBe(false);

      // Propagate taint on the source
      ledger.propagateTaint(srcClaim.id);
      expect(srcClaim.tainted).toBe(true);

      // Derive a new claim that references the source
      const derived = ledger.addClaim('Derived from original', [srcClaim.id], 0.8);
      // Because source is tainted, derived should be tainted automatically
      expect(derived.tainted).toBe(true);
    });
  });

  describe('Controller synthesis of multi-source information', () => {
    it('creates at least one claim in the ledger with source refs', () => {
      const sources: Source[] = [
        { reference: 'doc1' },
        { reference: 'doc2' },
      ];
      const synthesis = (srcs: Source[]) => `Synthesized from ${srcs.map((s) => s.reference).join(' and ')}`;

      const { claim, conclusion, flagged, warning } = synthesizeAndRecord(
        ledger,
        'topic',
        sources,
        synthesis
      );

      // Assert claim created
      expect(claim.id).toBeDefined();
      expect(claim.statement).toContain('topic:');
      expect(claim.sources).toEqual(['doc1', 'doc2']);
      expect(claim.confidence).toBeGreaterThan(0);

      // Conclusion should match
      expect(conclusion).toContain('doc1');
      expect(conclusion).toContain('doc2');

      // Not flagged by default
      expect(flagged).toBe(false);

      // Check that claim is in ledger
      const retrieved = ledger.getClaim(claim.id);
      expect(retrieved).toBeTruthy();
      expect(retrieved!.sources).toEqual(['doc1', 'doc2']);
    });
  });

  describe('Before a consequential decision, controller retrieves relevant claims and checks contradictions and confidence', () => {
    it('evaluates required claims and flags low confidence, contradictions, missing, tainted', () => {
      const claim1 = ledger.addClaim('Important fact', ['s1'], 0.9);
      const claim2 = ledger.addClaim('Another fact', ['s2'], 0.4); // low confidence
      // Create contradiction: same statement
      ledger.addClaim('Important fact', ['s3'], 0.7); // will contradict claim1

      const required = [claim1.id, claim2.id];
      const check = evaluateDecisionContext(ledger, required);

      expect(check.ok).toBe(false);
      expect(check.lowConfidenceClaims).toContain(claim2.id);
      expect(check.warnings.some((w) => w.includes('contradiction'))).toBe(true);
      // No missing claims
      expect(check.claimsMissing).toHaveLength(0);
    });
  });

  describe('Low-confidence or contradicted claim is flagged in the final answer or triggers a clarification request', () => {
    it('wraps result with warnings for low confidence and contradictions', () => {
      const claim = ledger.addClaim('Risky statement', ['src'], 0.3);
      // create contradiction
      ledger.addClaim('Risky statement', ['other'], 0.9);

      const resultText = 'Final answer text';
      const wrapped = wrapResultWithClaimFlags(ledger, resultText, [claim.id]);

      expect(wrapped).toContain('⚠️ Warnings:');
      expect(wrapped).toContain('LOW CONFIDENCE');
      expect(wrapped).toContain('CONTRADICTED');
      expect(wrapped).toContain(resultText);
    });

    it('does not add warnings when all claims are healthy', () => {
      const claim = ledger.addClaim('Reliable', ['src'], 0.9);
      const resultText = 'Good answer';
      const wrapped = wrapResultWithClaimFlags(ledger, resultText, [claim.id]);
      expect(wrapped).toBe(resultText);
    });
  });

  describe('Claims derived from tainted observations are marked tainted and not used as sole evidence for success criterion', () => {
    it('marks derived claim as tainted when source observation is tainted', () => {
      // 'observation' claim that is tainted
      const obs = ledger.addClaim('Observation data', ['sensor'], 0.9, undefined, undefined, true);
      expect(obs.tainted).toBe(true);

      // Derive claim using that observation as source
      const derived = ledger.addClaim('Conclusion from observation', [obs.id], 0.8);
      expect(derived.tainted).toBe(true);
    });

    it('success criterion fails when only tainted claims support it', () => {
      const tainted = ledger.addClaim('Supporting evidence', ['bad_source'], 0.9, undefined, undefined, true);
      // criterion check
      const { met, reason } = checkSuccessCriterionTaint(ledger, 'Task done', [tainted.id]);
      expect(met).toBe(false);
      expect(reason).toContain('All supporting claims are tainted');
    });

    it('success criterion passes when at least one non-tainted claim supports it', () => {
      const good = ledger.addClaim('Good evidence', ['good_source'], 0.9, undefined, undefined, false);
      const bad = ledger.addClaim('Bad evidence', ['bad_source'], 0.9, undefined, undefined, true);
      const { met } = checkSuccessCriterionTaint(ledger, 'Task done', [good.id, bad.id]);
      expect(met).toBe(true);
    });
  });

  describe('trace_eval can cite claim_ids as evidence refs for criterion satisfaction', () => {
    it('returns claim_ids as evidence references', () => {
      const claimA = ledger.addClaim('Result A', ['link1'], 0.8);
      const claimB = ledger.addClaim('Result B', ['link2'], 0.9);

      const evalResult = evaluateCriterion(ledger, 'User asked', [claimA.id, claimB.id]);
      expect(evalResult.evidenceRefs).toEqual([claimA.id, claimB.id]);
      // Should be satisfied because claims exist
      expect(evalResult.satisfied).toBe(true);
    });

    it('fails if an evidence claim is missing', () => {
      const { satisfied, failures } = evaluateCriterion(ledger, 'Something', ['nonexistent']);
      expect(satisfied).toBe(false);
      expect(failures).toContainEqual(expect.stringContaining('not found'));
    });
  });

  describe('Claim ledger operations are recorded in trace events for full auditability', () => {
    it('add_claim, verify_contradictions, and propagate_taint generate trace events', () => {
      const c = ledger.addClaim('Audit test', ['src'], 0.7);
      ledger.verifyContradictions(c.id);
      ledger.propagateTaint(c.id); // will set taint and record events

      const trace = ledger.getTrace();
      const eventTypes = trace.map((e) => e.type);
      expect(eventTypes).toContain('add_claim');
      expect(eventTypes).toContain('verify_contradictions');
      expect(eventTypes).toContain('taint_set');
    });
  });
});
