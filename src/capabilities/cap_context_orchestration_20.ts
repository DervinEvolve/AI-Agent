// cap_context_orchestration_20: Policy-aware working-memory and context orchestration.
//
// This is a PURE ADVISORY assembly layer. It selects, orders, scores, compresses,
// and redacts candidate context for the model prompt. It has ZERO access to tools,
// sandbox, browser, api_client, vault, or HITL issuance. It never executes actions,
// never clears taint, never validates evidence.
//
// Taint is monotonic: any summary/bundle derived from tainted items is tainted.
// Immutable requirements / success_criteria / safety boundaries / system_policy are
// auto-pinned and can never be evicted, summarized away, or weakened.

import { redactSecrets, containsRealVaultSecret } from './context_secret_adapter';

export type CandidateKind =
  | 'requirement'
  | 'goal'
  | 'milestone'
  | 'plan'
  | 'claim'
  | 'trace_ref'
  | 'memory'
  | 'skill'
  | 'observation'
  | 'system_policy'
  | 'success_criteria'
  | 'safety_boundary';

export type Action =
  | 'assemble_context'
  | 'score_candidates'
  | 'compress_item'
  | 'refresh_stale'
  | 'inspect_bundle'
  | 'export_redacted_bundle';

export type Status =
  | 'ok'
  | 'policy_blocked'
  | 'budget_exhausted'
  | 'not_found'
  | 'over_budget_after_pins'
  | 'stale'
  | 'requires_review';

export interface Candidate {
  item_id: string;
  kind: CandidateKind;
  content_ref: string;
  content?: string;
  provenance: string;
  tainted: boolean;
  freshness: string; // ISO datetime
  source_reliability: number; // 0..1
  evidence_refs?: string[];
  deleted?: boolean; // set true if source memory/claim was deleted
}

export interface CompressionPolicy {
  strategy: 'extractive' | 'abstractive' | 'keyvalue';
  max_ratio: number; // 0..1 target output/input ratio
  preserve_provenance: boolean;
}

export interface BundleItem {
  item_id: string;
  kind: CandidateKind;
  rendered_content: string;
  is_summary: boolean;
  trust_tier: number;
  tainted: boolean;
  freshness: string;
  source_reliability: number;
  inclusion_reason: string;
  provenance: string;
  evidence_refs: string[];
  authorizes: false; // structurally: a bundle item can NEVER authorize
}

export interface EvictedItem {
  item_id: string;
  eviction_reason: string;
}

export interface Bundle {
  items: BundleItem[];
  total_tokens: number;
  evicted: EvictedItem[];
  taint_summary: { tainted: boolean; tainted_item_ids: string[] };
}

export interface CandidateScore {
  item_id: string;
  relevance: number;
  recency: number;
  reliability: number;
  composite: number;
  tainted: boolean;
  trust_tier: number;
}

export interface Provenance {
  task_id: string;
  bundle_version: number;
  timestamp: string;
  policy_id: string;
  budget_reserved: number;
}

export interface TraceEvent {
  type: string;
  task_id: string;
  payload: Record<string, unknown>;
}

export interface ContextRequest {
  action: Action;
  task_id: string;
  candidates?: Candidate[];
  token_budget?: number;
  relevance_query?: string;
  must_include_ids?: string[];
  compression_policy?: CompressionPolicy;
  export_policy?: { audience?: string; redact_provenance?: boolean };
  now?: string; // injected clock for determinism
  freshness_threshold_ms?: number;
  from_checkpoint?: boolean;
}

export interface ContextResult {
  status: Status;
  tainted: boolean;
  bundle?: Bundle;
  candidate_scores?: CandidateScore[];
  redacted_bundle?: Bundle;
  provenance: Provenance;
  trace_events: TraceEvent[];
  error?: { code: string; message: string; retryable: boolean };
}

// ---- Trust tiers (lower number == higher trust / higher priority) ----
const TRUST_TIER: Record<CandidateKind, number> = {
  system_policy: 0,
  safety_boundary: 0,
  requirement: 1,
  success_criteria: 1,
  goal: 2,
  milestone: 2,
  plan: 3,
  claim: 3,
  skill: 3,
  trace_ref: 4,
  memory: 4,
  observation: 5,
};

const IMMUTABLE_KINDS: ReadonlySet<CandidateKind> = new Set<CandidateKind>([
  'system_policy',
  'safety_boundary',
  'requirement',
  'success_criteria',
]);

export function isImmutable(kind: CandidateKind): boolean {
  return IMMUTABLE_KINDS.has(kind);
}

export function trustTier(kind: CandidateKind): number {
  return TRUST_TIER[kind] ?? 5;
}

// ---- Unified budget tracker (no shared tracker exists in repo; own it here) ----
export class BudgetTracker {
  private remaining: number;
  private readonly initial: number;
  constructor(initial: number) {
    this.initial = Math.max(0, initial | 0);
    this.remaining = this.initial;
  }
  reserve(cost: number): boolean {
    const c = Math.max(0, cost | 0);
    if (c > this.remaining) return false;
    this.remaining -= c;
    return true;
  }
  release(cost: number): void {
    this.remaining = Math.min(this.initial, this.remaining + Math.max(0, cost | 0));
  }
  get reservedSoFar(): number {
    return this.initial - this.remaining;
  }
  get available(): number {
    return this.remaining;
  }
}

// Deterministic token estimate: ~4 chars per token, min 1 for non-empty.
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

// Deterministic fake resolver of content_ref -> content when no inline content.
function resolveContent(c: Candidate): string {
  if (typeof c.content === 'string') return c.content;
  return `[[${c.content_ref}]]`;
}

// ---- Scoring (deterministic) ----
function relevanceScore(text: string, query?: string): number {
  if (!query) return 0.5;
  const q = query.toLowerCase().split(/\W+/).filter(Boolean);
  if (q.length === 0) return 0.5;
  const t = text.toLowerCase();
  let hits = 0;
  for (const term of q) if (t.includes(term)) hits++;
  return Math.min(1, hits / q.length);
}

function recencyScore(freshness: string, now: number): number {
  const f = Date.parse(freshness);
  if (Number.isNaN(f)) return 0;
  const ageMs = Math.max(0, now - f);
  const dayMs = 24 * 60 * 60 * 1000;
  // Exponential-ish decay, deterministic.
  return Math.max(0, 1 - Math.min(1, ageMs / (30 * dayMs)));
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// Re-derive freshness/reliability values that arrive from checkpoints; never trust as-is.
function sanitizeCheckpointValues(c: Candidate, now: number): Candidate {
  const rel = clamp01(c.source_reliability);
  // Re-derive freshness: if malformed, treat as "now" oldest-safe? -> treat as stale by using epoch.
  let freshness = c.freshness;
  if (Number.isNaN(Date.parse(freshness))) {
    freshness = new Date(0).toISOString();
  } else {
    const f = Date.parse(freshness);
    // A checkpoint cannot claim to be fresher than "now".
    if (f > now) freshness = new Date(now).toISOString();
  }
  return { ...c, source_reliability: rel, freshness };
}

export function scoreCandidate(
  c: Candidate,
  query: string | undefined,
  now: number,
): CandidateScore {
  const text = resolveContent(c);
  const relevance = relevanceScore(text, query);
  const recency = recencyScore(c.freshness, now);
  const reliability = clamp01(c.source_reliability);
  // Tainted candidates are penalized so they can never out-rank a validated (untainted)
  // candidate of equal relevance into an instruction tier.
  const taintPenalty = c.tainted ? 0.5 : 1;
  const composite = clamp01((0.5 * relevance + 0.3 * recency + 0.2 * reliability) * taintPenalty);
  return {
    item_id: c.item_id,
    relevance,
    recency,
    reliability,
    composite,
    tainted: c.tainted,
    trust_tier: trustTier(c.kind),
  };
}

// ---- Compression (deterministic, provenance-preserving) ----
export function compressCandidate(
  c: Candidate,
  policy: CompressionPolicy,
): { rendered: string; is_summary: boolean; tainted: boolean; evidence_refs: string[] } {
  const text = resolveContent(c);
  const maxRatio = clamp01(policy.max_ratio) || 0.5;
  const targetLen = Math.max(1, Math.floor(text.length * maxRatio));
  let summary: string;
  switch (policy.strategy) {
    case 'keyvalue':
      summary = `provenance=${c.provenance}; kind=${c.kind}; excerpt=${text.slice(0, targetLen)}`;
      break;
    case 'abstractive':
      summary = `[summary] ${text.slice(0, targetLen)}`;
      break;
    case 'extractive':
    default:
      summary = text.slice(0, targetLen);
      break;
  }
  // taint is the UNION of source taints; a summary of a tainted source is tainted.
  return {
    rendered: summary,
    is_summary: true,
    tainted: c.tainted,
    evidence_refs: [...(c.evidence_refs ?? []), c.content_ref],
  };
}

// ---- Dedup: collapse near-duplicate observations, keep unique provenance chains ----
function dedupeKey(c: Candidate): string {
  const text = resolveContent(c).trim().toLowerCase().replace(/\s+/g, ' ');
  return `${c.kind}::${text}`;
}

// ---- Freshness ----
function isStale(c: Candidate, now: number, thresholdMs: number): boolean {
  const f = Date.parse(c.freshness);
  if (Number.isNaN(f)) return true;
  return now - f > thresholdMs;
}

// ---- Redaction gate ----
function gateContent(text: string): { ok: boolean; redacted: string; vaultLeak: boolean } {
  if (containsRealVaultSecret(text)) {
    return { ok: false, redacted: '[REDACTED]', vaultLeak: true };
  }
  return { ok: true, redacted: redactSecrets(text), vaultLeak: false };
}

const DEFAULT_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

function makeProvenance(req: ContextRequest, budgetReserved: number, version = 1): Provenance {
  return {
    task_id: req.task_id,
    bundle_version: version,
    timestamp: req.now ?? new Date(0).toISOString(),
    policy_id: 'con_context_orchestration_20',
    budget_reserved: budgetReserved,
  };
}

export function orchestrateContext(req: ContextRequest): ContextResult {
  const nowMs = Date.parse(req.now ?? new Date(0).toISOString());
  const now = Number.isNaN(nowMs) ? 0 : nowMs;
  const trace_events: TraceEvent[] = [];
  const budget = new BudgetTracker(
    Math.max(0, (req.token_budget ?? 0) | 0),
  );

  const emit = (type: string, payload: Record<string, unknown>) =>
    trace_events.push({ type, task_id: req.task_id, payload });

  const fail = (
    status: Status,
    code: string,
    message: string,
    retryable = false,
  ): ContextResult => ({
    status,
    tainted: false,
    provenance: makeProvenance(req, budget.reservedSoFar),
    trace_events,
    error: { code, message, retryable },
  });

  const rawCandidates = req.candidates ?? [];

  // Re-derive checkpoint values; never trust freshness/reliability as-is.
  const candidates = rawCandidates.map((c) =>
    req.from_checkpoint ? sanitizeCheckpointValues(c, now) : c,
  );

  if (req.action === 'score_candidates') {
    if (!budget.reserve(candidates.length)) {
      return fail('budget_exhausted', 'BUDGET', 'scoring reservation failed', true);
    }
    const scores = candidates.map((c) => scoreCandidate(c, req.relevance_query, now));
    emit('context.score_candidates', { count: scores.length });
    return {
      status: 'ok',
      tainted: candidates.some((c) => c.tainted),
      candidate_scores: scores,
      provenance: makeProvenance(req, budget.reservedSoFar),
      trace_events,
    };
  }

  if (req.action === 'compress_item') {
    const target = candidates[0];
    if (!target) return fail('not_found', 'NOT_FOUND', 'no candidate to compress');
    if (!budget.reserve(estimateTokens(resolveContent(target)))) {
      return fail('budget_exhausted', 'BUDGET', 'compression reservation failed', true);
    }
    const gate = gateContent(resolveContent(target));
    if (gate.vaultLeak) {
      emit('context.policy_blocked', { item_id: target.item_id, reason: 'vault_secret' });
      return {
        status: 'policy_blocked',
        tainted: target.tainted,
        provenance: makeProvenance(req, budget.reservedSoFar),
        trace_events,
        error: { code: 'SECRET_LEAK', message: 'vault secret detected; session must terminate', retryable: false },
      };
    }
    const policy = req.compression_policy ?? {
      strategy: 'extractive',
      max_ratio: 0.5,
      preserve_provenance: true,
    };
    const summary = compressCandidate({ ...target, content: gate.redacted }, policy);
    const item: BundleItem = {
      item_id: target.item_id,
      kind: target.kind,
      rendered_content: summary.rendered,
      is_summary: true,
      trust_tier: trustTier(target.kind),
      tainted: summary.tainted,
      freshness: target.freshness,
      source_reliability: clamp01(target.source_reliability),
      inclusion_reason: 'compressed_summary',
      provenance: target.provenance,
      evidence_refs: summary.evidence_refs,
      authorizes: false,
    };
    emit('context.compress_item', { item_id: target.item_id, tainted: summary.tainted });
    return {
      status: 'ok',
      tainted: summary.tainted,
      bundle: {
        items: [item],
        total_tokens: estimateTokens(item.rendered_content),
        evicted: [],
        taint_summary: {
          tainted: summary.tainted,
          tainted_item_ids: summary.tainted ? [target.item_id] : [],
        },
      },
      provenance: makeProvenance(req, budget.reservedSoFar),
      trace_events,
    };
  }

  if (req.action === 'refresh_stale') {
    const thresholdMs = req.freshness_threshold_ms ?? DEFAULT_FRESHNESS_MS;
    const evicted: EvictedItem[] = [];
    const kept: Candidate[] = [];
    for (const c of candidates) {
      if (c.deleted) {
        evicted.push({ item_id: c.item_id, eviction_reason: 'deleted_source' });
      } else if (isStale(c, now, thresholdMs)) {
        evicted.push({ item_id: c.item_id, eviction_reason: 'stale_freshness' });
      } else {
        kept.push(c);
      }
    }
    emit('context.refresh_stale', { kept: kept.length, evicted: evicted.length });
    return {
      status: evicted.length > 0 ? 'stale' : 'ok',
      tainted: kept.some((c) => c.tainted),
      bundle: {
        items: kept.map((c) => renderItem(c, gateContent(resolveContent(c)).redacted, 'fresh')),
        total_tokens: kept.reduce((s, c) => s + estimateTokens(resolveContent(c)), 0),
        evicted,
        taint_summary: taintSummary(kept),
      },
      provenance: makeProvenance(req, budget.reservedSoFar),
      trace_events,
    };
  }

  // assemble_context / inspect_bundle / export_redacted_bundle
  const assembled = assemble(req, candidates, now, budget, emit);
  if (assembled.status !== 'ok' || !assembled.bundle) {
    return {
      status: assembled.status,
      tainted: assembled.bundle?.taint_summary.tainted ?? false,
      bundle: assembled.bundle,
      provenance: makeProvenance(req, budget.reservedSoFar),
      trace_events,
      error: assembled.error,
    };
  }

  if (req.action === 'export_redacted_bundle') {
    // Reserve export budget and re-run redaction on delivery.
    if (!budget.reserve(assembled.bundle.total_tokens)) {
      return fail('budget_exhausted', 'BUDGET', 'export reservation failed', true);
    }
    const redacted: Bundle = {
      ...assembled.bundle,
      items: assembled.bundle.items.map((it) => {
        const g = gateContent(it.rendered_content);
        return {
          ...it,
          rendered_content: g.redacted,
          provenance: req.export_policy?.redact_provenance ? '[REDACTED]' : it.provenance,
        };
      }),
    };
    emit('context.export_redacted_bundle', { items: redacted.items.length });
    return {
      status: 'ok',
      tainted: redacted.taint_summary.tainted,
      bundle: assembled.bundle,
      redacted_bundle: redacted,
      provenance: makeProvenance(req, budget.reservedSoFar),
      trace_events,
    };
  }

  return {
    status: 'ok',
    tainted: assembled.bundle.taint_summary.tainted,
    bundle: assembled.bundle,
    provenance: makeProvenance(req, budget.reservedSoFar),
    trace_events,
  };
}

function taintSummary(cands: Candidate[]): { tainted: boolean; tainted_item_ids: string[] } {
  const ids = cands.filter((c) => c.tainted).map((c) => c.item_id);
  return { tainted: ids.length > 0, tainted_item_ids: ids };
}

function renderItem(c: Candidate, rendered: string, reason: string, isSummary = false): BundleItem {
  const tier = trustTier(c.kind);
  // Tainted items are always rendered inside delimited data blocks, never as instructions.
  const wrapped = c.tainted
    ? `<<UNTRUSTED_DATA taint=1>>${rendered}<<END_UNTRUSTED_DATA>>`
    : rendered;
  return {
    item_id: c.item_id,
    kind: c.kind,
    rendered_content: wrapped,
    is_summary: isSummary,
    trust_tier: tier,
    tainted: c.tainted,
    freshness: c.freshness,
    source_reliability: clamp01(c.source_reliability),
    inclusion_reason: reason,
    provenance: c.provenance,
    evidence_refs: [...(c.evidence_refs ?? []), c.content_ref].filter(Boolean),
    authorizes: false,
  };
}

interface AssembleResult {
  status: Status;
  bundle?: Bundle;
  error?: { code: string; message: string; retryable: boolean };
}

function assemble(
  req: ContextRequest,
  candidates: Candidate[],
  now: number,
  budget: BudgetTracker,
  emit: (type: string, payload: Record<string, unknown>) => void,
): AssembleResult {
  const thresholdMs = req.freshness_threshold_ms ?? DEFAULT_FRESHNESS_MS;
  const evicted: EvictedItem[] = [];

  // 1. Redaction + policy gate on EVERY item first.
  const gated: { c: Candidate; content: string }[] = [];
  for (const c of candidates) {
    const g = gateContent(resolveContent(c));
    if (g.vaultLeak) {
      emit('context.policy_blocked', { item_id: c.item_id, reason: 'vault_secret' });
      return {
        status: 'policy_blocked',
        error: {
          code: 'SECRET_LEAK',
          message: 'vault secret detected; session must terminate',
          retryable: false,
        },
      };
    }
    gated.push({ c, content: g.redacted });
  }

  // 2. Freshness / deletion filter (immutable items are exempt from eviction).
  const live: { c: Candidate; content: string }[] = [];
  for (const g of gated) {
    if (isImmutable(g.c.kind)) {
      live.push(g);
      continue;
    }
    if (g.c.deleted) {
      evicted.push({ item_id: g.c.item_id, eviction_reason: 'deleted_source' });
    } else if (isStale(g.c, now, thresholdMs)) {
      evicted.push({ item_id: g.c.item_id, eviction_reason: 'stale_freshness' });
    } else {
      live.push(g);
    }
  }

  // 3. Dedup non-immutable observations, keep unique provenance chains.
  const seen = new Map<string, string>(); // dedupeKey -> item_id kept
  const deduped: { c: Candidate; content: string }[] = [];
  for (const g of live) {
    if (isImmutable(g.c.kind)) {
      deduped.push(g);
      continue;
    }
    const key = dedupeKey(g.c);
    const existing = seen.get(key);
    if (existing && existing !== g.c.provenance) {
      // different provenance chain -> keep it (unique provenance preserved)
      deduped.push(g);
    } else if (existing) {
      evicted.push({ item_id: g.c.item_id, eviction_reason: 'duplicate' });
    } else {
      seen.set(key, g.c.provenance);
      deduped.push(g);
    }
  }

  // 4. Reserve scoring budget.
  if (!budget.reserve(deduped.length)) {
    return {
      status: 'budget_exhausted',
      error: { code: 'BUDGET', message: 'scoring reservation failed', retryable: true },
    };
  }

  // 5. Determine pins: explicit must_include + all immutable.
  const mustInclude = new Set(req.must_include_ids ?? []);
  const pinned: { c: Candidate; content: string }[] = [];
  const optional: { c: Candidate; content: string }[] = [];
  for (const g of deduped) {
    if (isImmutable(g.c.kind) || mustInclude.has(g.c.item_id)) {
      pinned.push(g);
    } else {
      optional.push(g);
    }
  }

  // 6. Account pins FIRST (before compression) — never silently drop a requirement.
  const tokenBudget = Math.max(0, (req.token_budget ?? 0) | 0);
  const pinnedItems = pinned.map((g) => renderItem(g.c, g.content, 'auto_pinned_immutable'));
  const pinnedTokens = pinnedItems.reduce((s, it) => s + estimateTokens(it.rendered_content), 0);

  if (pinnedTokens > tokenBudget) {
    emit('context.over_budget_after_pins', {
      pinned_tokens: pinnedTokens,
      token_budget: tokenBudget,
    });
    return {
      status: 'over_budget_after_pins',
      bundle: {
        items: pinnedItems,
        total_tokens: pinnedTokens,
        evicted,
        taint_summary: taintSummary(pinned.map((g) => g.c)),
      },
      error: {
        code: 'OVER_BUDGET_AFTER_PINS',
        message: 'pinned immutable items exceed token_budget; reduce scope',
        retryable: false,
      },
    };
  }

  // 7. Score + sort optional items. Immutable items never compressed/evicted.
  const scored = optional
    .map((g) => ({ g, score: scoreCandidate(g.c, req.relevance_query, now) }))
    .sort((a, b) => {
      if (a.g.c.tainted !== b.g.c.tainted) return a.g.c.tainted ? 1 : -1;
      if (a.score.trust_tier !== b.score.trust_tier) return a.score.trust_tier - b.score.trust_tier;
      return b.score.composite - a.score.composite;
    });

  const items: BundleItem[] = [...pinnedItems];
  let total = pinnedTokens;
  const policy: CompressionPolicy = req.compression_policy ?? {
    strategy: 'extractive',
    max_ratio: 0.5,
    preserve_provenance: true,
  };

  for (const { g } of scored) {
    const full = renderItem(g.c, g.content, 'relevance_selected');
    const fullTokens = estimateTokens(full.rendered_content);
    if (total + fullTokens <= tokenBudget) {
      items.push(full);
      total += fullTokens;
      continue;
    }
    // Try compression to fit (reserve compression budget).
    if (budget.reserve(1)) {
      const summary = compressCandidate({ ...g.c, content: g.content }, policy);
      const summaryItem = renderItem(
        { ...g.c },
        summary.rendered,
        'compressed_to_fit',
        true,
      );
      summaryItem.tainted = summary.tainted;
      summaryItem.evidence_refs = summary.evidence_refs;
      const summaryTokens = estimateTokens(summaryItem.rendered_content);
      if (total + summaryTokens <= tokenBudget) {
        items.push(summaryItem);
        total += summaryTokens;
        continue;
      }
    }
    evicted.push({ item_id: g.c.item_id, eviction_reason: 'budget_evicted' });
  }

  // Order final render by trust tier for layout.
  items.sort((a, b) => {
    if (a.trust_tier !== b.trust_tier) return a.trust_tier - b.trust_tier;
    if (a.tainted !== b.tainted) return a.tainted ? 1 : -1;
    return 0;
  });

  const ts = { tainted: items.some((i) => i.tainted), tainted_item_ids: items.filter((i) => i.tainted).map((i) => i.item_id) };
  emit('context.assemble_context', {
    included: items.length,
    evicted: evicted.length,
    total_tokens: total,
    taint_summary: ts,
  });

  return {
    status: 'ok',
    bundle: { items, total_tokens: total, evicted, taint_summary: ts },
  };
}
