/**
 * Evidence-grounded claim synthesis and verification behavior.
 * Implements a simple in-memory claim ledger with trace events,
 * contradiction detection, taint propagation, and evaluation helpers.
 */

export interface Claim {
  id: string;
  statement: string;
  sources: string[]; // can be external references or claim IDs
  confidence: number; // 0 .. 1
  timestamp: string; // ISO date string
  tainted: boolean;
  contradictions: string[]; // IDs of contradicting claims
  freshUntil?: string; // optional ISO date after which claim is stale
  metadata?: Record<string, unknown>;
}

export interface TraceEvent {
  type: string;
  claimId?: string;
  timestamp: string;
  details?: unknown;
}

let nextId = 1;
function generateId(): string {
  return `claim_${nextId++}`;
}

export class ClaimLedger {
  private claims: Map<string, Claim> = new Map();
  private trace: TraceEvent[] = [];

  private logTrace(type: string, claimId?: string, details?: unknown): void {
    this.trace.push({
      type,
      claimId,
      timestamp: new Date().toISOString(),
      details,
    });
  }

  addClaim(
    statement: string,
    sources: string[],
    confidence: number,
    freshUntil?: string,
    metadata?: Record<string, unknown>,
    tainted?: boolean
  ): Claim {
    // Propagate taint from sources if any source is a tainted claim
    let derivedTainted = tainted ?? false;
    if (!derivedTainted) {
      for (const src of sources) {
        if (this.claims.has(src)) {
          const srcClaim = this.claims.get(src)!;
          if (srcClaim.tainted) {
            derivedTainted = true;
            break;
          }
        } // external sources not tainted by default
      }
    }

    const claim: Claim = {
      id: generateId(),
      statement,
      sources,
      confidence: Math.min(1, Math.max(0, confidence)),
      timestamp: new Date().toISOString(),
      tainted: derivedTainted,
      contradictions: [],
      freshUntil,
      metadata,
    };

    // Simple contradiction detection: exact text match means contradictory (different sources only)
    for (const existing of this.claims.values()) {
      if (
        existing.statement.trim().toLowerCase() === claim.statement.trim().toLowerCase() &&
        existing.id !== claim.id
      ) {
        // Both are contradictory to each other
        existing.contradictions.push(claim.id);
        claim.contradictions.push(existing.id);
        // Update the existing claim in the map
        this.claims.set(existing.id, { ...existing });
      }
    }

    this.claims.set(claim.id, claim);
    this.logTrace('add_claim', claim.id, { statement });

    return claim;
  }

  getClaim(id: string): Claim | undefined {
    return this.claims.get(id);
  }

  getClaims(filter?: {
    statementContains?: string;
    minConfidence?: number;
    maxConfidence?: number;
    tainted?: boolean;
    freshOnly?: boolean;
  }): Claim[] {
    let result = Array.from(this.claims.values());

    if (filter) {
      if (filter.statementContains) {
        const term = filter.statementContains.toLowerCase();
        result = result.filter((c) => c.statement.toLowerCase().includes(term));
      }
      if (typeof filter.minConfidence === 'number') {
        result = result.filter((c) => c.confidence >= filter.minConfidence!);
      }
      if (typeof filter.maxConfidence === 'number') {
        result = result.filter((c) => c.confidence <= filter.maxConfidence!);
      }
      if (filter.tainted !== undefined) {
        result = result.filter((c) => c.tainted === filter.tainted);
      }
      if (filter.freshOnly) {
        const now = new Date();
        result = result.filter((c) => {
          if (!c.freshUntil) return true;
          return new Date(c.freshUntil) >= now;
        });
      }
    }

    return result;
  }

  verifyContradictions(claimId: string): { contradictions: Claim[] } {
    const claim = this.claims.get(claimId);
    if (!claim) {
      return { contradictions: [] };
    }
    this.logTrace('verify_contradictions', claimId);
    const contradictoryClaims = claim.contradictions
      .map((id) => this.claims.get(id))
      .filter((c): c is Claim => c !== undefined);
    return { contradictions: contradictoryClaims };
  }

  propagateTaint(sourceId: string): void {
    const source = this.claims.get(sourceId);
    if (!source || source.tainted) return;

    source.tainted = true;
    this.claims.set(sourceId, source);
    this.logTrace('taint_set', sourceId);

    // Propagate to any claim that lists this source as a source (as claim ID)
    for (const claim of this.claims.values()) {
      if (claim.sources.includes(sourceId) && !claim.tainted) {
        claim.tainted = true;
        this.claims.set(claim.id, { ...claim });
        this.logTrace('taint_propagated', claim.id, { becauseOf: sourceId });
        // Recursive propagation
        this.propagateTaint(claim.id);
      }
    }
  }

  getTrace(): TraceEvent[] {
    return [...this.trace];
  }

  clearTrace(): void {
    this.trace = [];
  }

  evaluateFreshness(claimId: string): boolean {
    const claim = this.claims.get(claimId);
    if (!claim) return false;
    if (!claim.freshUntil) return true;
    return new Date() <= new Date(claim.freshUntil);
  }
}

// --- Behavior helpers that integrate the ledger into agent actions ---

export interface Source {
  reference: string; // description or URL
  isClaimId?: boolean; // if true, the reference is a claim ID
}

export function synthesizeAndRecord(
  ledger: ClaimLedger,
  topic: string,
  rawSources: Source[],
  synthesisLogic: (sources: Source[]) => string
): { claim: Claim; conclusion: string; flagged: boolean; warning?: string } {
  const conclusion = synthesisLogic(rawSources);
  // Build claim statement: a summary about the topic
  const statement = `${topic}: ${conclusion}`;
  const sources = rawSources.map((s) => s.reference);
  // Default confidence: moderate; could be adjusted by logic
  const confidence = 0.7;
  const claim = ledger.addClaim(statement, sources, confidence);

  // After recording, check for low confidence or contradictions
  let flagged = false;
  let warning: string | undefined;
  if (claim.confidence < 0.5) {
    flagged = true;
    warning = `Low-confidence claim (${claim.id}) was used.`;
  }
  const { contradictions } = ledger.verifyContradictions(claim.id);
  if (contradictions.length > 0) {
    flagged = true;
    const contradictIds = contradictions.map((c) => c.id).join(', ');
    warning = (warning ? warning + ' ' : '') + 
      `Claim ${claim.id} is contradicted by claims ${contradictIds}.`;
  }

  return { claim, conclusion, flagged, warning };
}

export interface DecisionCheck {
  ok: boolean;
  warnings: string[];
  claimsMissing: string[];
  lowConfidenceClaims: string[];
  taintedClaims: string[];
}

export function evaluateDecisionContext(
  ledger: ClaimLedger,
  requiredClaimIds: string[],
  options?: { minConfidence?: number; allowTainted?: boolean }
): DecisionCheck {
  const minConf = options?.minConfidence ?? 0.5;
  const allowTainted = options?.allowTainted ?? false;
  const warnings: string[] = [];
  const claimsMissing: string[] = [];
  const lowConfidenceClaims: string[] = [];
  const taintedClaims: string[] = [];

  for (const id of requiredClaimIds) {
    const claim = ledger.getClaim(id);
    if (!claim) {
      claimsMissing.push(id);
      continue;
    }
    if (claim.tainted && !allowTainted) {
      taintedClaims.push(id);
      warnings.push(`Claim ${id} is tainted and cannot be used.`);
    }
    if (claim.confidence < minConf) {
      lowConfidenceClaims.push(id);
      warnings.push(`Claim ${id} has low confidence (${claim.confidence}).`);
    }
    if (claim.contradictions.length > 0) {
      warnings.push(`Claim ${id} has known contradictions: ${claim.contradictions.join(', ')}`);
    }
    if (!ledger.evaluateFreshness(id)) {
      warnings.push(`Claim ${id} is stale.`);
    }
  }

  const ok = claimsMissing.length === 0 && taintedClaims.length === 0 && lowConfidenceClaims.length === 0 && warnings.length === 0;
  return { ok, warnings, claimsMissing, lowConfidenceClaims, taintedClaims };
}

export function wrapResultWithClaimFlags(
  ledger: ClaimLedger,
  resultText: string,
  claimIds: string[]
): string {
  const warnings: string[] = [];
  for (const id of claimIds) {
    const claim = ledger.getClaim(id);
    if (!claim) continue;
    if (claim.tainted) {
      warnings.push(`[TAINTED] Claim ${id} is tainted.`);
    }
    if (claim.confidence < 0.5) {
      warnings.push(`[LOW CONFIDENCE] Claim ${id} confidence=${claim.confidence}.`);
    }
    if (claim.contradictions.length > 0) {
      warnings.push(`[CONTRADICTED] Claim ${id} contradicted by ${claim.contradictions.join(',')}.`);
    }
  }
  if (warnings.length === 0) return resultText;
  return `${resultText}\n\n\u26a0\ufe0f Warnings:\n${warnings.map((w) => ' - ' + w).join('\n')}`;
}

export function evaluateCriterion(
  ledger: ClaimLedger,
  criterion: string,
  evidenceClaimIds: string[],
  requireNonTainted?: boolean
): { satisfied: boolean; evidenceRefs: string[]; failures: string[] } {
  const evidenceRefs: string[] = [];
  const failures: string[] = [];
  let satisfied = true;

  for (const id of evidenceClaimIds) {
    const claim = ledger.getClaim(id);
    if (!claim) {
      satisfied = false;
      failures.push(`Evidence claim ${id} not found.`);
      continue;
    }
    if (requireNonTainted && claim.tainted) {
      satisfied = false;
      failures.push(`Claim ${id} is tainted and cannot be sole evidence.`);
    }
    evidenceRefs.push(claim.id);
  }

  if (evidenceRefs.length === 0) {
    satisfied = false;
    failures.push('No evidence claims provided.');
  }

  return { satisfied, evidenceRefs, failures };
}

/**
 * Check that a success criterion is not met solely by tainted claims.
 * Returns true if criterion can be considered satisfied, false otherwise.
 */
export function checkSuccessCriterionTaint(
  ledger: ClaimLedger,
  criterion: string,
  supportingClaimIds: string[]
): { met: boolean; reason?: string } {
  const nonTainted = supportingClaimIds.filter((id) => {
    const c = ledger.getClaim(id);
    return c && !c.tainted;
  });

  if (nonTainted.length === 0) {
    return { met: false, reason: 'All supporting claims are tainted.' };
  }

  // Additional checks could be added; for now, having at least one non-tainted claim suffices.
  return { met: true };
}
