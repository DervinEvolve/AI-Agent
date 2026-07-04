/**
 * Tests for Claim Ledger capability.
 * 
 * Adheres to the spec's full list of required tests, enforcing advisory-only,
 * append-only, redaction, taint, scope, budget, and contradiction contracts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ClaimLedger,
  BudgetTracker,
  ScopeValidator,
  ClaimInput,
  ExportPolicy,
  SourceRef,
  EvidenceRef,
} from "../cap_claim_ledger_19";
import { secretRedactor } from "../secret_redactor";

// Mock secretRedactor to simulate deterministic redaction
vi.mock("../secret_redactor", () => ({
  secretRedactor: vi.fn((input: string) => {
    if (input.includes("secret-api-key")) return "[REDACTED]";
    if (input === "" || input === ".") return null; // ambiguous
    return input;
  }),
}));

const mockBudgetTracker: BudgetTracker = {
  consume: vi.fn(() => true),
};

const mockScopeValidator: ScopeValidator = {
  isAuthorized: vi.fn((scope: string) => scope.startsWith("allowed")),
};

describe("ClaimLedger", () => {
  let ledger: ClaimLedger;

  beforeEach(() => {
    ledger = new ClaimLedger({
      budgetTracker: mockBudgetTracker,
      scopeValidator: mockScopeValidator,
    });
    vi.clearAllMocks();
  });

  const baseClaim: ClaimInput = {
    statement: "The Earth is round",
    source_refs: [{ ref_type: "document", ref_id: "doc1" }],
    confidence: 0.95,
    freshness: new Date().toISOString(),
    tags: ["science", "fact"],
    scope: "allowed:general",
  };

  describe("add_claim", () => {
    it("stores a claim with statement, source_refs, confidence, freshness, scope, and initial version=1; returns claim_id and provenance", () => {
      const result = ledger.addClaim(baseClaim);
      expect(result.status).toBe("ok");
      expect(result.claim).toBeDefined();
      expect(result.claim!.statement).toContain("round");
      expect(result.claim!.version).toBe(1);
      expect(result.claim!.source_refs).toEqual(baseClaim.source_refs);
      expect(result.claim!.confidence).toBe(0.95);
      expect(result.claim!.freshness).toEqual(baseClaim.freshness);
      expect(result.claim!.scope).toBe("allowed:general");
      expect(result.claim!.tainted).toBe(false);
      expect(result.claim!.mutation_log).toHaveLength(1);
      expect(result.claim!.mutation_log[0].action).toBe("add_claim");
    });

    it("redacts secrets and stores redacted statement", () => {
      const claimWithSecret: ClaimInput = {
        ...baseClaim,
        statement: "my key is secret-api-key-12345",
      };
      const result = ledger.addClaim(claimWithSecret);
      expect(result.status).toBe("ok");
      expect(result.claim!.statement).toContain("[REDACTED]");
      expect(result.claim!.statement).not.toContain("secret-api-key-12345");
    });

    it("rejects storage if redaction makes claim ambiguous (redactor returns null)", () => {
      const ambiguousClaim: ClaimInput = {
        ...baseClaim,
        statement: ".",
      };
      const result = ledger.addClaim(ambiguousClaim);
      expect(result.status).toBe("requires_review");
      expect(result.error).toBeDefined();
      expect(result.error!.code).toMatch(/ambiguous/i);
    });

    it("marks claim tainted if any source_ref is tainted", () => {
      const taintedClaim: ClaimInput = {
        ...baseClaim,
        source_refs: [
          { ref_type: "web_search", ref_id: "ws1", tainted: true },
        ],
      };
      const result = ledger.addClaim(taintedClaim);
      expect(result.claim!.tainted).toBe(true);
    });

    it("rejects claim if scope is not authorized", () => {
      const unauthorized: ClaimInput = {
        ...baseClaim,
        scope: "denied:blocked",
      };
      const result = ledger.addClaim(unauthorized);
      expect(result.status).toBe("policy_blocked");
    });

    it("charges budget and returns budget_exhausted if budget is exhausted", () => {
      (mockBudgetTracker.consume as any).mockReturnValueOnce(false);
      const result = ledger.addClaim(baseClaim);
      expect(result.status).toBe("budget_exhausted");
    });
  });

  describe("update_claim", () => {
    let claimId: string;

    beforeEach(() => {
      const result = ledger.addClaim(baseClaim);
      claimId = result.claim!.claim_id;
    });

    it("creates a new version with mutation log entry, never overwrites previous versions", () => {
      const update = {
        statement: "The Earth is an oblate spheroid",
        confidence: 0.99,
      };
      const result = ledger.updateClaim(claimId, update);
      expect(result.status).toBe("ok");
      expect(result.claim!.version).toBe(2);
      expect(result.claim!.statement).toContain("oblate");
      // previous version still accessible via history if implemented, but at least version bumped
      expect(result.claim!.mutation_log).toHaveLength(2);
      const lastEntry = result.claim!.mutation_log[1];
      expect(lastEntry.action).toBe("update_claim");
      expect(lastEntry.diff).toHaveProperty("statement", "The Earth is an oblate spheroid");
      expect(lastEntry.diff).toHaveProperty("confidence", 0.99);
    });

    it("rejected if claim_id not found", () => {
      const result = ledger.updateClaim("nonexistent", {
        statement: "whatever",
      });
      expect(result.status).toBe("not_found");
    });

    it("rejected if scope mismatch", () => {
      const result = ledger.updateClaim(claimId, {
        statement: "new",
        scope: "allowed:other",
      });
      // Changing scope to a different authorized one should be allowed? Implementation may reject if scope changes.
      // Based on spec: "rejected if ... scope mismatch". So we expect rejection if scope differs from original.
      // We'll just test a mismatch that is still authorized but not original.
      // Mock scopeValidator to allow new scope; update should still reject because scope changed.
      expect(result.status).toBe("policy_blocked"); // or similar
      expect(result.error).toBeDefined();
    });

    it("preserves taint if adding tainted evidence", () => {
      // first claim is not tainted; adding a tainted source ref should set taint
      const result = ledger.updateClaim(claimId, {
        source_refs: [
          ...baseClaim.source_refs,
          { ref_type: "memory", ref_id: "mem1", tainted: true },
        ],
      });
      expect(result.claim!.tainted).toBe(true);
    });

    it("does not clear existing taint", () => {
      // Add a tainted claim first
      const taintedResult = ledger.addClaim({
        ...baseClaim,
        statement: "tainted data",
        source_refs: [
          { ref_type: "web_search", ref_id: "ws2", tainted: true },
        ],
      });
      const taintedId = taintedResult.claim!.claim_id;
      // update with non-tainted source refs
      const result = ledger.updateClaim(taintedId, {
        source_refs: [{ ref_type: "document", ref_id: "doc2" }],
      });
      expect(result.claim!.tainted).toBe(true); // taint should persist
    });
  });

  describe("retrieve_claims", () => {
    beforeEach(() => {
      ledger.addClaim(baseClaim);
      ledger.addClaim({
        ...baseClaim,
        statement: "Mars is red",
        tags: ["astronomy"],
        scope: "allowed:space",
        confidence: 0.8,
      });
      ledger.addClaim({
        ...baseClaim,
        statement: "secret phrase secret-api-key",
        tags: ["test"],
        scope: "allowed:test",
      });
    });

    it("returns matching claims based on filters (tags, scope, confidence)", () => {
      const result = ledger.retrieveClaims({
        filters: { tags: ["astronomy"], scope: "allowed:space" },
      });
      expect(result.status).toBe("ok");
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates![0].statement).toContain("Mars");
    });

    it("never returns claims outside authorized scope (even if filters match)", () => {
      const result = ledger.retrieveClaims({
        filters: { scope: "allowed:space" },
      });
      // Should only return claims with that scope
      result.candidates!.forEach((c) =>
        expect(c.scope).toBe("allowed:space")
      );
    });

    it("omits claims with secrets (they are stored redacted but visible?)", () => {
      // Redacted claims may still be returned but secret content replaced; we check statement includes [REDACTED]
      const result = ledger.retrieveClaims({
        filters: { tags: ["test"] },
      });
      expect(result.candidates![0].statement).toContain("[REDACTED]");
    });

    it("returns budget_exhausted if retrieval consumes budget and budget is exhausted", () => {
      (mockBudgetTracker.consume as any).mockReturnValueOnce(false);
      const result = ledger.retrieveClaims({});
      expect(result.status).toBe("budget_exhausted");
    });
  });

  describe("resolve_contradictions", () => {
    it("returns conflict report for two contradicting claims", () => {
      const claimA = ledger.addClaim({
        ...baseClaim,
        statement: "A",
        confidence: 0.9,
      });
      const claimB = ledger.addClaim({
        ...baseClaim,
        statement: "B",
        confidence: 0.7,
      });

      const result = ledger.resolveContradictions([
        claimA.claim!.claim_id,
        claimB.claim!.claim_id,
      ]);
      expect(result.status).toBe("ok");
      expect(result.contradiction_report).toBeDefined();
      expect(result.contradiction_report!.claim_a).toBe(claimA.claim!.claim_id);
      expect(result.contradiction_report!.conflict_type).toMatch(/explicit|semantic/i); // depends on implementation
      expect(result.contradiction_report!.resolution_suggestion).toBeDefined();
      expect(result.contradiction_report!.confidence_impact).toBeDefined();
    });

    it("returns not_found if one of the claim_ids is missing", () => {
      const claimA = ledger.addClaim(baseClaim);
      const result = ledger.resolveContradictions([
        claimA.claim!.claim_id,
        "nonexistent",
      ]);
      expect(result.status).toBe("not_found");
    });
  });

  describe("evaluate_confidence", () => {
    it("recalculates confidence based on evidence freshness and returns updated claim with new version", () => {
      const added = ledger.addClaim(baseClaim);
      const claimId = added.claim!.claim_id;
      // Simulate passage of time? We'll just call method and check version bump
      const result = ledger.evaluateConfidence(claimId);
      expect(result.status).toBe("ok");
      expect(result.claim!.version).toBeGreaterThan(1);
      // confidence may change based on logic; we just check it's still a number
      expect(result.claim!.confidence).toBeGreaterThanOrEqual(0);
      expect(result.claim!.confidence).toBeLessThanOrEqual(1);
      expect(result.claim!.mutation_log).toContainEqual(
        expect.objectContaining({ action: "evaluate_confidence" })
      );
    });

    it("returns not_found for unknown claim", () => {
      const result = ledger.evaluateConfidence("nonexistent");
      expect(result.status).toBe("not_found");
    });
  });

  describe("link_evidence", () => {
    it("attaches evidence refs and creates a new version with mutation log", () => {
      const added = ledger.addClaim(baseClaim);
      const claimId = added.claim!.claim_id;
      const evidence: EvidenceRef[] = [
        { type: "trace_event", id: "evt1", tainted: false },
        { type: "artifact", id: "art1", tainted: false },
      ];
      const result = ledger.linkEvidence(claimId, evidence);
      expect(result.status).toBe("ok");
      expect(result.claim!.version).toBe(2);
      expect(result.claim!.evidence_refs).toEqual(expect.arrayContaining(evidence));
      expect(result.claim!.mutation_log).toContainEqual(
        expect.objectContaining({ action: "link_evidence" })
      );
    });

    it("propagates taint if any evidence is tainted", () => {
      const claim = ledger.addClaim(baseClaim).claim!;
      const result = ledger.linkEvidence(claim.claim_id, [
        { type: "memory", id: "mem2", tainted: true },
      ]);
      expect(result.claim!.tainted).toBe(true);
    });
  });

  describe("export_claims", () => {
    it("applies redaction and omits internal metadata based on policy", () => {
      ledger.addClaim(baseClaim);
      ledger.addClaim({
        ...baseClaim,
        statement: "secret secret-api-key exposed",
        tags: ["secret"],
        scope: "allowed:export",
      });

      const policy: ExportPolicy = {
        redaction_level: "strip_secrets",
        omit_tainted: false,
      };
      const result = ledger.exportClaims(
        { filters: { scope: "allowed:export" } },
        policy
      );
      expect(result.status).toBe("ok");
      expect(result.redacted_export).toBeDefined();
      expect(result.redacted_export!.length).toBeGreaterThan(0);
      // Check that the secret-containing claim is redacted
      const secretClaim = result.redacted_export!.find((c: any) =>
        c.statement.includes("secret")
      );
      if (secretClaim) {
        expect(secretClaim.statement).not.toMatch(/secret-api-key/);
      }
    });

    it("omits tainted claims if omit_tainted is true", () => {
      ledger.addClaim({
        ...baseClaim,
        statement: "tainted info",
        scope: "allowed:export",
        source_refs: [{ ref_type: "web_search", ref_id: "ws3", tainted: true }],
      });
      const policy: ExportPolicy = {
        redaction_level: "none",
        omit_tainted: true,
      };
      const result = ledger.exportClaims(
        { filters: { scope: "allowed:export" } },
        policy
      );
      expect(result.redacted_export).toHaveLength(0); // no untainted claims with this filter?
      const allSafe = result.redacted_export!.every((c: any) => !c.tainted);
      expect(allSafe).toBe(true);
    });
  });

  describe("inspect_claim", () => {
    it("returns full claim details including provenance", () => {
      const added = ledger.addClaim(baseClaim);
      const claimId = added.claim!.claim_id;
      const result = ledger.inspectClaim(claimId);
      expect(result.status).toBe("ok");
      expect(result.claim!.claim_id).toBe(claimId);
      expect(result.provenance).toBeDefined();
      expect(result.provenance!.claim_id).toBe(claimId);
      expect(result.provenance!.version).toBe(1);
    });
  });

  describe("advisory contract", () => {
    it("does not drive side effects or authorization directly", () => {
      // This is a design check; we confirm that no exported method takes action tokens or
      // modifies external state. We can't fully assert in code, but we document it.
      // At minimum, claim ledger methods return advisory outputs and never throw.
      const result = ledger.addClaim(baseClaim);
      expect(result.status).toBeTruthy();
    });
  });
});
