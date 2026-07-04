import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { redactSecrets } from './secret_redactor';

// ── Schemas ──────────────────────────────────────────────────────────────────

const SourceRefSchema = z.object({
  type: z.string(),
  id: z.string(),
  tainted: z.boolean().optional().default(false),
  description: z.string().optional(),
});

export const ClaimInputSchema = z.object({
  statement: z.string().min(1),
  source_refs: z.array(SourceRefSchema).min(1),
  confidence: z.number().min(0).max(1),
  freshness: z.string().datetime(),
  tags: z.array(z.string()).optional().default([]),
  scope: z.record(z.unknown()).optional().default({}),
});

export const QuerySchema = z.object({
  filters: z.record(z.unknown()).optional().default({}),
  semantic_query: z.string().optional(),
  max_results: z.number().int().positive().optional().default(10),
});

export const ExportPolicySchema = z.object({
  audience: z.enum(['internal', 'external']).optional().default('internal'),
  redact_secrets: z.boolean().optional().default(true),
});

export const ActionInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add_claim'),
    claim: ClaimInputSchema,
    purpose_justification: z.string().optional(),
  }),
  z.object({
    action: z.literal('update_claim'),
    claim_id: z.string(),
    claim: ClaimInputSchema.partial(),
    purpose_justification: z.string().optional(),
  }),
  z.object({
    action: z.literal('retrieve_claims'),
    query: QuerySchema,
    scope: z.record(z.unknown()).optional().default({}),
  }),
  z.object({
    action: z.literal('resolve_contradictions'),
    contradiction_pair: z.tuple([z.string(), z.string()]),
  }),
  z.object({
    action: z.literal('evaluate_confidence'),
    claim_id: z.string(),
  }),
  z.object({
    action: z.literal('link_evidence'),
    claim_id: z.string(),
    evidence_refs: z.array(
      z.object({
        type: z.string(),
        id: z.string(),
        description: z.string().optional(),
      })
    ).min(1),
  }),
  z.object({
    action: z.literal('export_claims'),
    claim_ids: z.array(z.string()).optional(),
    export_policy: ExportPolicySchema.optional().default({}),
  }),
  z.object({
    action: z.literal('inspect_claim'),
    claim_id: z.string(),
  }),
]);

export type ActionInput = z.infer<typeof ActionInputSchema>;
export type ClaimInput = z.infer<typeof ClaimInputSchema>;

// ── Internal claim representation ───────────────────────────────────────────

interface ClaimVersion {
  version: number;
  statement: string;
  source_refs: z.infer<typeof SourceRefSchema>[];
  confidence: number;
  freshness: string;
  tags: string[];
  scope: Record<string, unknown>;
  tainted: boolean;
  taint_sources: string[];
  evidence_refs: { type: string; id: string; description?: string }[];
  mutation_log: MutationEntry[];
  created_at: string;
  updated_at: string;
}

interface MutationEntry {
  timestamp: string;
  reason: string;
  scope: Record<string, unknown>;
  changes: Record<string, unknown>;
}

interface StoredClaim {
  claim_id: string;
  versions: ClaimVersion[];
  deleted: boolean;
}

// ── Claim store (in-memory, append-only) ────────────────────────────────────

class ClaimStore {
  private claims = new Map<string, StoredClaim>();

  addClaim(input: ClaimInput & { tainted?: boolean; taint_sources?: string[] }): {
    claim_id: string;
    claim: ClaimVersion;
    provenance: Record<string, unknown>;
  } {
    const claim_id = uuidv4();
    const now = new Date().toISOString();
    const version: ClaimVersion = {
      version: 1,
      statement: input.statement,
      source_refs: input.source_refs,
      confidence: input.confidence,
      freshness: input.freshness,
      tags: input.tags || [],
      scope: input.scope || {},
      tainted: input.tainted || input.source_refs.some((s) => s.tainted),
      taint_sources: input.taint_sources || input.source_refs.filter((s) => s.tainted).map((s) => s.id),
      evidence_refs: [],
      mutation_log: [
        {
          timestamp: now,
          reason: 'initial_claim',
          scope: input.scope || {},
          changes: {},
        },
      ],
      created_at: now,
      updated_at: now,
    };
    this.claims.set(claim_id, { claim_id, versions: [version], deleted: false });
    return {
      claim_id,
      claim: version,
      provenance: this.buildProvenance(claim_id, version),
    };
  }

  updateClaim(
    claim_id: string,
    updates: Partial<ClaimInput> & { tainted?: boolean; taint_sources?: string[] },
    reason: string,
    scope: Record<string, unknown>
  ): ClaimVersion {
    const stored = this.claims.get(claim_id);
    if (!stored || stored.deleted) {
      throw new Error(`Claim ${claim_id} not found`);
    }
    const latest = stored.versions[stored.versions.length - 1];
    // scope mismatch check (simple: compare scope keys)
    const currentScope = latest.scope;
    const newScope = updates.scope || currentScope;
    if (JSON.stringify(Object.keys(currentScope).sort()) !== JSON.stringify(Object.keys(newScope).sort())) {
      throw new Error('Scope mismatch');
    }
    const now = new Date().toISOString();
    const newVersion: ClaimVersion = {
      ...latest,
      version: latest.version + 1,
      statement: updates.statement ?? latest.statement,
      source_refs: updates.source_refs ?? latest.source_refs,
      confidence: updates.confidence ?? latest.confidence,
      freshness: updates.freshness ?? latest.freshness,
      tags: updates.tags ?? latest.tags,
      scope: newScope,
      tainted:
        updates.tainted ??
        latest.tainted ||
        (updates.source_refs ? updates.source_refs.some((s) => s.tainted) : false),
      taint_sources: [
        ...new Set([
          ...latest.taint_sources,
          ...(updates.taint_sources || []),
          ...(updates.source_refs?.filter((s) => s.tainted).map((s) => s.id) || []),
        ]),
      ],
      evidence_refs: latest.evidence_refs,
      mutation_log: [
        ...latest.mutation_log,
        {
          timestamp: now,
          reason,
          scope,
          changes: updates,
        },
      ],
      updated_at: now,
    };
    stored.versions.push(newVersion);
    return newVersion;
  }

  getClaim(claim_id: string): StoredClaim | undefined {
    const stored = this.claims.get(claim_id);
    return stored && !stored.deleted ? stored : undefined;
  }

  retrieveClaims(query: { filters?: Record<string, unknown>; semantic_query?: string; max_results?: number }, scope: Record<string, unknown>): ClaimVersion[] {
    const candidates: ClaimVersion[] = [];
    for (const stored of this.claims.values()) {
      if (stored.deleted) continue;
      const latest = stored.versions[stored.versions.length - 1];
      // scope filtering: must match all scope keys/values
      if (scope && Object.keys(scope).length > 0) {
        const match = Object.entries(scope).every(([k, v]) => latest.scope[k] === v);
        if (!match) continue;
      }
      // structured filters
      if (query.filters && Object.keys(query.filters).length > 0) {
        // simple: match tags or statement contains
        const filterMatch = Object.entries(query.filters).every(([k, v]) => {
          if (k === 'tags' && Array.isArray(v)) {
            return v.every((tag: string) => latest.tags.includes(tag));
          }
          if (k === 'statement_contains' && typeof v === 'string') {
            return latest.statement.includes(v);
          }
          if (k === 'confidence_gte' && typeof v === 'number') {
            return latest.confidence >= v;
          }
          return true;
        });
        if (!filterMatch) continue;
      }
      // semantic query (simple keyword match)
      if (query.semantic_query) {
        const q = query.semantic_query.toLowerCase();
        if (!latest.statement.toLowerCase().includes(q)) continue;
      }
      candidates.push(latest);
    }
    const max = query.max_results || 10;
    return candidates.slice(0, max);
  }

  resolveContradictions(claim_a_id: string, claim_b_id: string): {
    claim_a: ClaimVersion;
    claim_b: ClaimVersion;
    conflict_type: string;
    resolution_suggestion: string;
    confidence_impact: { a: number; b: number };
  } {
    const storedA = this.getClaim(claim_a_id);
    const storedB = this.getClaim(claim_b_id);
    if (!storedA || !storedB) {
      throw new Error('One or both claims not found');
    }
    const a = storedA.versions[storedA.versions.length - 1];
    const b = storedB.versions[storedB.versions.length - 1];
    // Simple contradiction detection: if statements are direct opposites or confidence inverted
    const conflict_type =
      a.statement.trim().toLowerCase() === `not ${b.statement.trim().toLowerCase()}` ||
      b.statement.trim().toLowerCase() === `not ${a.statement.trim().toLowerCase()}`
        ? 'direct_negation'
        : 'confidence_conflict';
    const resolution_suggestion =
      conflict_type === 'direct_negation'
        ? 'Review source evidence for both claims; one may be based on tainted or outdated information.'
        : 'Re-evaluate confidence using fresh evidence and source reliability.';
    return {
      claim_a: a,
      claim_b: b,
      conflict_type,
      resolution_suggestion,
      confidence_impact: {
        a: -0.1,
        b: -0.1,
      },
    };
  }

  evaluateConfidence(claim_id: string): ClaimVersion {
    const stored = this.getClaim(claim_id);
    if (!stored) throw new Error('Claim not found');
    const latest = stored.versions[stored.versions.length - 1];
    // Recalculate based on evidence freshness, source reliability, contradictions (simplified)
    const now = Date.now();
    const ageHours = (now - new Date(latest.freshness).getTime()) / 3600000;
    const freshnessFactor = Math.max(0, 1 - ageHours / 720); // 30 days half-life
    const sourceReliability = latest.source_refs.reduce(
      (acc, s) => acc + (s.tainted ? 0.3 : 0.9),
      0
    ) / latest.source_refs.length;
    let newConfidence = latest.confidence * freshnessFactor * sourceReliability;
    // clamp
    newConfidence = Math.min(1, Math.max(0, newConfidence));
    // create new version via updateClaim
    return this.updateClaim(
      claim_id,
      { confidence: newConfidence },
      'confidence_evaluation',
      latest.scope
    );
  }

  linkEvidence(
    claim_id: string,
    evidence_refs: { type: string; id: string; description?: string }[]
  ): ClaimVersion {
    const stored = this.getClaim(claim_id);
    if (!stored) throw new Error('Claim not found');
    const latest = stored.versions[stored.versions.length - 1];
    const updatedRefs = [...latest.evidence_refs, ...evidence_refs];
    return this.updateClaim(
      claim_id,
      {},
      'link_evidence',
      latest.scope,
    );
    // note: we need to actually attach evidence_refs; the above updateClaim won't include them because we didn't pass them.
    // We'll modify the method to accept extra fields.
  }

  // Revised linkEvidence with proper handling
  linkEvidenceFixed(
    claim_id: string,
    evidence_refs: { type: string; id: string; description?: string }[]
  ): ClaimVersion {
    const stored = this.getClaim(claim_id);
    if (!stored) throw new Error('Claim not found');
    const latest = stored.versions[stored.versions.length - 1];
    const now = new Date().toISOString();
    const newVersion: ClaimVersion = {
      ...latest,
      version: latest.version + 1,
      evidence_refs: [...latest.evidence_refs, ...evidence_refs],
      mutation_log: [
        ...latest.mutation_log,
        {
          timestamp: now,
          reason: 'link_evidence',
          scope: latest.scope,
          changes: { evidence_refs: evidence_refs },
        },
      ],
      updated_at: now,
    };
    stored.versions.push(newVersion);
    return newVersion;
  }

  exportClaims(
    claim_ids?: string[],
    policy?: z.infer<typeof ExportPolicySchema>
  ): { redacted_export: Record<string, unknown>[] } {
    const ids = claim_ids || Array.from(this.claims.keys());
    const exported: Record<string, unknown>[] = [];
    for (const id of ids) {
      const stored = this.claims.get(id);
      if (!stored || stored.deleted) continue;
      const latest = stored.versions[stored.versions.length - 1];
      let statement = latest.statement;
      if (policy?.redact_secrets !== false) {
        const redacted = redactSecrets(statement);
        // if redaction makes statement empty or only placeholders, skip
        if (!redacted || redacted.trim().length === 0 || /^\[REDACTED\]$/.test(redacted.trim())) {
          continue;
        }
        statement = redacted;
      }
      exported.push({
        claim_id: id,
        statement,
        confidence: latest.confidence,
        freshness: latest.freshness,
        tags: latest.tags,
        tainted: latest.tainted,
        version: latest.version,
        created_at: latest.created_at,
      });
    }
    return { redacted_export: exported };
  }

  private buildProvenance(claim_id: string, version: ClaimVersion) {
    return {
      claim_id,
      version: version.version,
      created_at: version.created_at,
      updated_at: version.updated_at,
      scope: version.scope,
      evidence_refs: version.evidence_refs,
      mutation_log: version.mutation_log,
      taint_sources: version.taint_sources,
    };
  }
}

// Singleton store for the module
const store = new ClaimStore();

// ── Main capability function ─────────────────────────────────────────────────

export async function claimLedger(input: unknown) {
  const parsed = ActionInputSchema.parse(input);

  // Budget simulation: if input contains budget, we could decrement, but we'll just check a flag.
  // For now, we'll implement a simple budget check if passed.

  try {
    switch (parsed.action) {
      case 'add_claim': {
        // Redact secrets in statement
        const redactedStatement = redactSecrets(parsed.claim.statement);
        if (!redactedStatement || redactedStatement.trim().length === 0 || /^\[REDACTED\]$/.test(redactedStatement.trim())) {
          return {
            status: 'policy_blocked' as const,
            error: { code: 'REDACTED_AMBIGUOUS', message: 'Claim statement became ambiguous after redaction', retryable: false },
          };
        }
        const claimInput: ClaimInput & { tainted?: boolean; taint_sources?: string[] } = {
          ...parsed.claim,
          statement: redactedStatement,
          tainted: parsed.claim.source_refs.some((s) => s.tainted),
          taint_sources: parsed.claim.source_refs.filter((s) => s.tainted).map((s) => s.id),
        };
        const result = store.addClaim(claimInput);
        return {
          status: 'ok' as const,
          claim: result.claim,
          provenance: result.provenance,
          tainted: result.claim.tainted,
        };
      }
      case 'update_claim': {
        const stored = store.getClaim(parsed.claim_id);
        if (!stored) {
          return { status: 'not_found' as const, error: { code: 'NOT_FOUND', message: 'Claim not found', retryable: false } };
        }
        // redact if statement updated
        let updates: Partial<ClaimInput> & { tainted?: boolean; taint_sources?: string[] } = { ...parsed.claim };
        if (updates.statement) {
          const redacted = redactSecrets(updates.statement);
          if (!redacted || redacted.trim().length === 0 || /^\[REDACTED\]$/.test(redacted.trim())) {
            return { status: 'policy_blocked' as const, error: { code: 'REDACTED_AMBIGUOUS', message: 'Updated statement became ambiguous after redaction', retryable: false } };
          }
          updates.statement = redacted;
        }
        try {
          const newVersion = store.updateClaim(
            parsed.claim_id,
            updates,
            parsed.purpose_justification || 'update',
            updates.scope || stored.versions[stored.versions.length - 1].scope
          );
          return {
            status: 'ok' as const,
            claim: newVersion,
            provenance: store['buildProvenance'](parsed.claim_id, newVersion),
            tainted: newVersion.tainted,
          };
        } catch (e: any) {
          if (e.message === 'Scope mismatch') {
            return { status: 'policy_blocked' as const, error: { code: 'SCOPE_MISMATCH', message: e.message, retryable: false } };
          }
          throw e;
        }
      }
      case 'retrieve_claims': {
        const results = store.retrieveClaims(parsed.query, parsed.scope || {});
        return {
          status: 'ok' as const,
          candidates: results.map((c) => ({
            claim: c,
            tainted: c.tainted,
          })),
        };
      }
      case 'resolve_contradictions': {
        try {
          const report = store.resolveContradictions(parsed.contradiction_pair[0], parsed.contradiction_pair[1]);
          return {
            status: 'ok' as const,
            contradiction_report: report,
          };
        } catch (e: any) {
          return { status: 'not_found' as const, error: { code: 'NOT_FOUND', message: e.message, retryable: false } };
        }
      }
      case 'evaluate_confidence': {
        try {
          const newVersion = store.evaluateConfidence(parsed.claim_id);
          return {
            status: 'ok' as const,
            claim: newVersion,
            tainted: newVersion.tainted,
          };
        } catch (e: any) {
          return { status: 'not_found' as const, error: { code: 'NOT_FOUND', message: e.message, retryable: false } };
        }
      }
      case 'link_evidence': {
        try {
          const newVersion = store.linkEvidenceFixed(parsed.claim_id, parsed.evidence_refs);
          return {
            status: 'ok' as const,
            claim: newVersion,
            provenance: store['buildProvenance'](parsed.claim_id, newVersion),
            tainted: newVersion.tainted,
          };
        } catch (e: any) {
          return { status: 'not_found' as const, error: { code: 'NOT_FOUND', message: e.message, retryable: false } };
        }
      }
      case 'export_claims': {
        const result = store.exportClaims(parsed.claim_ids, parsed.export_policy);
        return {
          status: 'ok' as const,
          redacted_export: result.redacted_export,
        };
      }
      case 'inspect_claim': {
        const stored = store.getClaim(parsed.claim_id);
        if (!stored) {
          return { status: 'not_found' as const, error: { code: 'NOT_FOUND', message: 'Claim not found', retryable: false } };
        }
        const latest = stored.versions[stored.versions.length - 1];
        return {
          status: 'ok' as const,
          claim: latest,
          provenance: store['buildProvenance'](parsed.claim_id, latest),
          tainted: latest.tainted,
        };
      }
      default:
        return { status: 'policy_blocked' as const, error: { code: 'INVALID_ACTION', message: 'Unknown action', retryable: false } };
    }
  } catch (e: any) {
    return { status: 'policy_blocked' as const, error: { code: 'INTERNAL', message: e.message, retryable: false } };
  }
}
