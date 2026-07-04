/**
 * Claim Ledger Capability — Structured evidence synthesis and truth maintenance.
 * 
 * Provides an append-only, scoped, provenance-rich knowledge graph of explicit claims
 * extracted from observations. Integrates with secret_redactor for redaction, supports
 * taint propagation, contradiction detection, confidence evaluation, and advisory-only
 * operation (never drives side effects or authorization).
 */

import { secretRedactor } from "./secret_redactor";

// ---- Types ----

export interface SourceRef {
  ref_type: string;                 // e.g., "web_search", "document", "memory", "trace"
  ref_id: string;
  tainted?: boolean;
  [key: string]: unknown;
}

export interface EvidenceRef {
  type: "trace_event" | "artifact" | "memory" | "observation";
  id: string;
  tainted?: boolean;
  meta?: Record<string, unknown>;
}

export interface ClaimInput {
  statement: string;
  source_refs: SourceRef[];
  confidence: number;               // 0-1
  freshness: string;                // ISO datetime
  tags: string[];
  scope: string;
  tainted?: boolean;
}

export interface QueryInput {
  filters?: {
    tags?: string[];
    scope?: string;
    dateRange?: { start?: string; end?: string };
    confidence?: { min?: number; max?: number };
  };
  semantic_query?: string;
  max_results?: number;
}

export interface ExportPolicy {
  redaction_level: "none" | "strip_secrets" | "strip_internal";
  audience_scope?: string[];
  omit_tainted?: boolean;
}

export interface MutationLogEntry {
  timestamp: string;
  action: string;
  reason?: string;
  diff: Record<string, unknown>;
}

export interface ClaimEntry {
  claim_id: string;
  version: number;
  statement: string;
  source_refs: SourceRef[];
  confidence: number;
  freshness: string;
  tags: string[];
  scope: string;
  created_at: string;
  updated_at: string;
  evidence_refs: EvidenceRef[];
  tainted: boolean;
  mutation_log: MutationLogEntry[];
}

export interface ClaimResult {
  claim?: ClaimEntry;
  error?: { code: string; message: string; retryable: boolean };
  status: "ok" | "policy_blocked" | "budget_exhausted" | "not_found" | "contradiction_detected" | "stale" | "tainted" | "requires_review";
  tainted?: boolean;
  candidates?: ClaimEntry[];
  provenance?: {
    claim_id: string;
    version: number;
    created_at: string;
    updated_at: string;
    scope: string;
    evidence_refs: EvidenceRef[];
    mutation_log: MutationLogEntry[];
    taint_sources: string[];
  };
  redacted_export?: ClaimEntry[];
  contradiction_report?: ContradictionReport;
}

export interface ContradictionReport {
  claim_a: string;
  claim_b: string;
  conflict_type: string;
  resolution_suggestion: string;
  confidence_impact: { a: number; b: number };
}

export interface BudgetTracker {
  consume(amount: number): boolean;
}

export interface ScopeValidator {
  isAuthorized(scope: string, operation: string): boolean;
}

// ---- In‑memory store ----

class ClaimStore {
  private claims: Map<string, ClaimEntry[]> = new Map();

  getClaim(claimId: string): ClaimEntry | undefined {
    const versions = this.claims.get(claimId);
    return versions && versions.length > 0 ? versions[versions.length - 1] : undefined;
  }

  addClaim(entry: ClaimEntry): void {
    this.claims.set(entry.claim_id, [entry]);
  }

  updateClaim(entry: ClaimEntry): void {
    const versions = this.claims.get(entry.claim_id);
    if (!versions) throw new Error("Claim not found");
    versions.push(entry);
  }

  getAllClaims(): ClaimEntry[] {
    const all: ClaimEntry[] = [];
    for (const [, versions] of this.claims.entries()) {
      if (versions.length > 0) all.push(versions[versions.length - 1]);
    }
    return all;
  }

  getClaimHistory(claimId: string): ClaimEntry[] | undefined {
    return this.claims.get(claimId);
  }
}

// ---- Claim Evaluator ----

class ClaimEvaluator {
  constructor(private store: ClaimStore) {}

  evaluateConfidence(claim: ClaimEntry): ClaimEntry {
    let baseConfidence = claim.confidence;

    // Freshness decay – older claims lose confidence
    const ageMs = Date.now() - new Date(claim.freshness).getTime();
    const freshnessFactor = Math.max(0.5, 1 - ageMs / (1000 * 60 * 60 * 24 * 30)); // 30‑day half‑life
    baseConfidence *= freshnessFactor;

    // Contradiction penalty – if another claim explicitly contradicts
    const allClaims = this.store.getAllClaims().filter(c => c.claim_id !== claim.claim_id);
    const contradictions = allClaims.some(c => this.isContradictory(claim, c));
    if (contradictions) baseConfidence *= 0.7;

    // Source reliability weighting (simple: more distinct sources -> +0.05 per unique ref_type, max +0.15)
    const types = new Set(claim.source_refs.map(s => s.ref_type));
    baseConfidence = Math.min(1, baseConfidence + types.size * 0.05);

    return { ...claim, confidence: Math.max(0, Math.min(1, baseConfidence)) };
  }

  private isContradictory(a: ClaimEntry, b: ClaimEntry): boolean {
    // A simplistic polarity check – may be refined later
    if (
      a.statement.toLowerCase() === b.statement.toLowerCase() ||
      a.statement.includes("not ") !== b.statement.includes("not ") ||
      a.tags.some(t => b.tags.includes(t)) && a.confidence > 0.5 && b.confidence > 0.5 &&
      a.statement !== b.statement
    ) {
      // Very naive – for demonstration we flag as contradictory if share a tag and confidence > 0.5
      // In production a semantic similarity model would be used.
      return true;
    }
    return false;
  }
}

// ---- Claim Resolver ----

class ClaimResolver {
  constructor(private store: ClaimStore) {}

  resolveContradictions(claimIdA: string, claimIdB: string): ContradictionReport {
    const claimA = this.store.getClaim(claimIdA);
    const claimB = this.store.getClaim(claimIdB);
    if (!claimA || !claimB) throw new Error("Claims not found");

    return {
      claim_a: claimIdA,
      claim_b: claimIdB,
      conflict_type: "polarity",
      resolution_suggestion: "Review source freshness and reliability; prefer more recent claim if confidence difference < 0.2, else flag for human review.",
      confidence_impact: { a: -0.05, b: -0.05 },
    };
  }
}

// ---- Main class ----

export class ClaimLedger {
  private store: ClaimStore;
  private evaluator: ClaimEvaluator;
  private resolver: ClaimResolver;
  private scopeValidator?: ScopeValidator;
  private budgetTracker?: BudgetTracker;

  constructor(
    opts?: {
      scopeValidator?: ScopeValidator;
      budgetTracker?: BudgetTracker;
    }
  ) {
    this.store = new ClaimStore();
    this.evaluator = new ClaimEvaluator(this.store);
    this.resolver = new ClaimResolver(this.store);
    this.scopeValidator = opts?.scopeValidator;
    this.budgetTracker = opts?.budgetTracker;
  }

  addClaim(claim: ClaimInput, evidence_refs?: EvidenceRef[], purpose_justification?: string): ClaimResult {
    // Redact statement before storage
    const redactedStatement = secretRedactor(claim.statement);
    if (!redactedStatement || redactedStatement.length === 0) {
      return { status: "policy_blocked", error: { code: "REDACTED_OUT", message: "Statement became ambiguous after redaction", retryable: false } };
    }

    // Check scope authorization
    if (this.scopeValidator && !this.scopeValidator.isAuthorized(claim.scope, "add")) {
      return { status: "policy_blocked", error: { code: "SCOPE_DENIED", message: "Scope not authorized", retryable: false } };
    }

    // Determine taint – from claim input and any tainted evidence
    const tainted = claim.tainted === true || (evidence_refs?.some(e => e.tainted) ?? false) ||
      claim.source_refs?.some(s => s.tainted) ?? false;

    const now = new Date().toISOString();
    const claimId = this.generateClaimId();
    const entry: ClaimEntry = {
      claim_id: claimId,
      version: 1,
      statement: redactedStatement,
      source_refs: claim.source_refs,
      confidence: Math.max(0, Math.min(1, claim.confidence)),
      freshness: claim.freshness,
      tags: claim.tags,
      scope: claim.scope,
      created_at: now,
      updated_at: now,
      evidence_refs: evidence_refs ?? [],
      tainted,
      mutation_log: [{
        timestamp: now,
        action: "claim_added",
        reason: purpose_justification,
        diff: { statement: redactedStatement },
      }],
    };

    this.store.addClaim(entry);

    return {
      status: tainted ? "tainted" : "ok",
      claim: entry,
      tainted,
      provenance: this.buildProvenance(entry),
    };
  }

  updateClaim(
    claim_id: string,
    updates: Partial<ClaimInput>,
    evidence_refs?: EvidenceRef[],
    purpose_justification?: string,
  ): ClaimResult {
    if (this.budgetTracker && !this.budgetTracker.consume(1)) {
      return { status: "budget_exhausted", error: { code: "BUDGET_EXHAUSTED", message: "Budget exhausted", retryable: true } };
    }

    const current = this.store.getClaim(claim_id);
    if (!current) {
      return { status: "not_found", error: { code: "NOT_FOUND", message: `Claim ${claim_id} not found`, retryable: false } };
    }

    // Scope mismatch check
    if (updates.scope && updates.scope !== current.scope) {
      return { status: "policy_blocked", error: { code: "SCOPE_MISMATCH", message: "Cannot change scope of existing claim", retryable: false } };
    }

    // Redact statement if updated
    let newStatement = current.statement;
    if (updates.statement) {
      const redacted = secretRedactor(updates.statement);
      if (!redacted || redacted.length === 0) {
        return { status: "policy_blocked", error: { code: "REDACTED_OUT", message: "Updated statement became ambiguous after redaction", retryable: false } };
      }
      newStatement = redacted;
    }

    // Taint propagation: if any incoming evidence is tainted, the updated claim remains tainted
    const taintUpdated = (evidence_refs?.some(e => e.tainted)) ?? false;
    const tainted = current.tainted || taintUpdated || (updates.tainted ?? false);

    const now = new Date().toISOString();
    const newVersion = current.version + 1;
    const updatedEntry: ClaimEntry = {
      ...current,
      version: newVersion,
      statement: newStatement,
      source_refs: updates.source_refs ?? current.source_refs,
      confidence: updates.confidence !== undefined ? Math.max(0, Math.min(1, updates.confidence)) : current.confidence,
      freshness: updates.freshness ?? current.freshness,
      tags: updates.tags ?? current.tags,
      updated_at: now,
      evidence_refs: [...current.evidence_refs, ...(evidence_refs ?? [])],
      tainted,
      mutation_log: [
        ...current.mutation_log,
        {
          timestamp: now,
          action: "claim_updated",
          reason: purpose_justification,
          diff: { statement: newStatement !== current.statement ? newStatement : undefined, version: newVersion },
        },
      ],
    };

    this.store.updateClaim(updatedEntry);

    return {
      status: tainted ? "tainted" : "ok",
      claim: updatedEntry,
      tainted,
      provenance: this.buildProvenance(updatedEntry),
    };
  }

  retrieveClaims(query: QueryInput): ClaimResult {
    if (this.budgetTracker && !this.budgetTracker.consume(1)) {
      return { status: "budget_exhausted", error: { code: "BUDGET_EXHAUSTED", message: "Budget exhausted", retryable: true } };
    }

    const all = this.store.getAllClaims();
    let results = all.filter(c => {
      // Scope filter – default to query.filters.scope if present
      if (query.filters?.scope && c.scope !== query.filters.scope) return false;
      if (query.filters?.tags && query.filters.tags.length > 0) {
        if (!query.filters.tags.some(t => c.tags.includes(t))) return false;
      }
      if (query.filters?.dateRange) {
        const created = new Date(c.created_at).getTime();
        if (query.filters.dateRange.start && created < new Date(query.filters.dateRange.start).getTime()) return false;
        if (query.filters.dateRange.end && created > new Date(query.filters.dateRange.end).getTime()) return false;
      }
      if (query.filters?.confidence) {
        if (query.filters.confidence.min !== undefined && c.confidence < query.filters.confidence.min) return false;
        if (query.filters.confidence.max !== undefined && c.confidence > query.filters.confidence.max) return false;
      }
      // Semantic query – simple exact or substring match on statement (placeholder)
      if (query.semantic_query && !c.statement.toLowerCase().includes(query.semantic_query.toLowerCase())) return false;
      return true;
    });

    if (query.max_results && query.max_results < results.length) {
      results = results.slice(0, query.max_results);
    }

    return {
      status: "ok",
      candidates: results,
    };
  }

  resolveContradictions(claimIdA: string, claimIdB: string): ClaimResult {
    try {
      const report = this.resolver.resolveContradictions(claimIdA, claimIdB);
      return { status: "requires_review", contradiction_report: report };
    } catch (e) {
      return { status: "not_found", error: { code: "NOT_FOUND", message: (e as Error).message, retryable: false } };
    }
  }

  evaluateConfidence(claim_id: string): ClaimResult {
    if (this.budgetTracker && !this.budgetTracker.consume(1)) {
      return { status: "budget_exhausted", error: { code: "BUDGET_EXHAUSTED", message: "Budget exhausted", retryable: true } };
    }

    const current = this.store.getClaim(claim_id);
    if (!current) {
      return { status: "not_found", error: { code: "NOT_FOUND", message: `Claim ${claim_id} not found`, retryable: false } };
    }

    const updated = this.evaluator.evaluateConfidence(current);
    const newVersion = updated.version + 1;
    const now = new Date().toISOString();
    const entry: ClaimEntry = {
      ...updated,
      version: newVersion,
      updated_at: now,
      mutation_log: [
        ...current.mutation_log,
        { timestamp: now, action: "confidence_evaluation", diff: { confidence: updated.confidence } },
      ],
    };

    this.store.updateClaim(entry);

    return {
      status: entry.tainted ? "tainted" : "ok",
      claim: entry,
      provenance: this.buildProvenance(entry),
    };
  }

  linkEvidence(claim_id: string, evidence_refs: EvidenceRef[], purpose_justification?: string): ClaimResult {
    if (this.budgetTracker && !this.budgetTracker.consume(1)) {
      return { status: "budget_exhausted", error: { code: "BUDGET_EXHAUSTED", message: "Budget exhausted", retryable: true } };
    }

    const current = this.store.getClaim(claim_id);
    if (!current) {
      return { status: "not_found", error: { code: "NOT_FOUND", message: `Claim ${claim_id} not found`, retryable: false } };
    }

    const now = new Date().toISOString();
    const newVersion = current.version + 1;
    const tainted = current.tainted || evidence_refs.some(e => e.tainted);
    const entry: ClaimEntry = {
      ...current,
      version: newVersion,
      evidence_refs: [...current.evidence_refs, ...evidence_refs],
      tainted,
      updated_at: now,
      mutation_log: [
        ...current.mutation_log,
        { timestamp: now, action: "evidence_linked", reason: purpose_justification, diff: { evidence_count: evidence_refs.length } },
      ],
    };

    this.store.updateClaim(entry);

    return {
      status: entry.tainted ? "tainted" : "ok",
      claim: entry,
      provenance: this.buildProvenance(entry),
    };
  }

  exportClaims(policy: ExportPolicy): ClaimResult {
    if (this.budgetTracker && !this.budgetTracker.consume(1)) {
      return { status: "budget_exhausted", error: { code: "BUDGET_EXHAUSTED", message: "Budget exhausted", retryable: true } };
    }

    let all = this.store.getAllClaims();
    if (policy.omit_tainted) {
      all = all.filter(c => !c.tainted);
    }

    const redacted: ClaimEntry[] = all.map(c => {
      if (policy.redaction_level === "none") return c;
      const redactedStatement = policy.redaction_level === "strip_secrets" ? secretRedactor(c.statement) : "[REDACTED]";
      return {
        ...c,
        statement: redactedStatement,
        // strip internal metadata
        mutation_log: policy.redaction_level === "strip_internal" ? [] : c.mutation_log,
        evidence_refs: policy.redaction_level === "strip_internal" ? [] : c.evidence_refs,
      };
    });

    return { status: "ok", redacted_export: redacted };
  }

  inspectClaim(claim_id: string): ClaimResult {
    const history = this.store.getClaimHistory(claim_id);
    if (!history || history.length === 0) {
      return { status: "not_found", error: { code: "NOT_FOUND", message: `Claim ${claim_id} not found`, retryable: false } };
    }

    const latest = history[history.length - 1];
    return {
      status: "ok",
      claim: latest,
      provenance: this.buildProvenance(latest),
    };
  }

  // helper
  private generateClaimId(): string {
    return `claim_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private buildProvenance(entry: ClaimEntry) {
    return {
      claim_id: entry.claim_id,
      version: entry.version,
      created_at: entry.created_at,
      updated_at: entry.updated_at,
      scope: entry.scope,
      evidence_refs: entry.evidence_refs,
      mutation_log: entry.mutation_log,
      taint_sources: entry.tainted ? entry.evidence_refs.filter(e => e.tainted).map(e => e.id) : [],
    };
  }
}

// default convenience
const defaultClaimLedger = new ClaimLedger();
export default defaultClaimLedger;
