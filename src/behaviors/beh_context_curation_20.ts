/**
 * beh_context_curation_20 — Governed context curation before each reasoning step.
 *
 * For nontrivial or long-horizon tasks, the agent assembles its working context
 * through a context manager rather than dumping full history: it pins the
 * immutable goal, requirements, and active policy; selects the most
 * task-relevant, fresh, reliable evidence within a token budget; compresses or
 * evicts low-signal / stale / duplicated material while preserving provenance;
 * and keeps untrusted/tainted observations clearly separated as data.
 *
 * This module is self-contained: it defines the context-manager surface it
 * needs so it does not depend on interfaces that may not yet exist elsewhere in
 * the repo. Other capabilities (e.g. cap_long_term_memory_3) can adapt to this
 * surface without coupling.
 */

export const BEHAVIOR_ID = 'beh_context_curation_20' as const;

/** How a candidate item may be compressed/evicted. */
export type CompressionStrategy = 'mask' | 'summarize' | 'none';

/** Trust classification of an item's origin. */
export type Trust = 'trusted' | 'tainted';

/** A pinned, immutable element that must survive every assembly. */
export interface PinnedItem {
  kind: 'goal' | 'requirement' | 'policy';
  id: string;
  text: string;
  tokens: number;
}

/** A candidate evidence item competing for room in the budget. */
export interface EvidenceItem {
  id: string;
  /** Stable reference preferred over re-embedding raw text. */
  claim_id?: string;
  event_ref?: string;
  text: string;
  tokens: number;
  /** Higher = more task-relevant. */
  relevance: number;
  /** Recency score, higher = fresher. */
  freshness: number;
  /** Reliability score in [0,1]. */
  reliability: number;
  trust: Trust;
  /** Provenance chain (never dropped even if the item is evicted/compressed). */
  provenance: string[];
  strategy?: CompressionStrategy;
}

export interface CurationInput {
  taskId: string;
  /** Whether the task is nontrivial / long-horizon (curation applies). */
  nontrivial: boolean;
  budgetTokens: number;
  pins: PinnedItem[];
  evidence: EvidenceItem[];
}

export type TraceEvent =
  | { type: 'pin'; taskId: string; id: string; kind: PinnedItem['kind'] }
  | {
      type: 'include';
      taskId: string;
      id: string;
      cite?: string;
      strategy: CompressionStrategy;
    }
  | { type: 'evict'; taskId: string; id: string; relevant: boolean; reason: string }
  | { type: 'taint'; taskId: string; id: string; treatedAsData: true }
  | {
      type: 'over_budget_after_pins';
      taskId: string;
      resolution: 'narrow_scope' | 'clarify' | 'structured_failure';
    };

/** A single item as it appears in the assembled context. */
export interface AssembledItem {
  id: string;
  /** Present when we cite instead of re-embedding raw text. */
  cite?: string;
  /** Content actually placed in context (may be compressed). */
  content: string;
  tokens: number;
  trust: Trust;
  strategy: CompressionStrategy;
  provenance: string[];
  /** Tainted items are usable only after validation, never as instructions. */
  usableAsInstruction: boolean;
  requiresIndependentValidation: boolean;
}

export type Resolution = 'ok' | 'narrow_scope' | 'clarify' | 'structured_failure';

export interface StructuredFailure {
  behavior: typeof BEHAVIOR_ID;
  code: 'over_budget_after_pins';
  taskId: string;
  message: string;
  /** Pins that could not fit — surfaced, never silently dropped. */
  unmetPinIds: string[];
}

export interface AssembledContext {
  taskId: string;
  pinned: AssembledItem[];
  evidence: AssembledItem[];
  /** True when task-relevant evidence had to be evicted for budget. */
  evidenceEvictedForBudget: boolean;
  evictedRelevantIds: string[];
  resolution: Resolution;
  structuredFailure?: StructuredFailure;
  trace: TraceEvent[];
  totalTokens: number;
}

const RELEVANCE_KEEP_THRESHOLD = 0.5;

function score(e: EvidenceItem): number {
  // Weighted composite; relevance dominates, freshness & reliability temper.
  return e.relevance * 2 + e.freshness + e.reliability;
}

/**
 * Determine what a tainted item is allowed to do. Tainted content is data:
 * never instructions, always requires independent validation before use.
 */
function classifyTaint(trust: Trust): {
  usableAsInstruction: boolean;
  requiresIndependentValidation: boolean;
} {
  if (trust === 'tainted') {
    return { usableAsInstruction: false, requiresIndependentValidation: true };
  }
  return { usableAsInstruction: true, requiresIndependentValidation: false };
}

function placeInContext(e: EvidenceItem): AssembledItem {
  const strategy: CompressionStrategy = e.strategy ?? 'none';
  const taint = classifyTaint(e.trust);
  // Prefer citing a stable ref over re-embedding raw text.
  const cite = e.claim_id ?? e.event_ref;

  let content: string;
  let tokens: number;
  if (cite) {
    content = `[cite:${cite}]`;
    tokens = 1;
  } else if (strategy === 'summarize') {
    content = e.text.slice(0, Math.ceil(e.text.length / 2));
    tokens = Math.max(1, Math.ceil(e.tokens / 2));
  } else if (strategy === 'mask') {
    content = `[masked:${e.id}]`;
    tokens = 1;
  } else {
    content = e.text;
    tokens = e.tokens;
  }

  return {
    id: e.id,
    cite,
    content,
    tokens,
    trust: e.trust,
    strategy,
    provenance: e.provenance,
    usableAsInstruction: taint.usableAsInstruction,
    requiresIndependentValidation: taint.requiresIndependentValidation,
  };
}

/**
 * The context manager: assemble a governed working context for a reasoning step.
 *
 * Contract:
 *  - Pins (goal/requirements/policy) are ALWAYS included, in every bundle.
 *  - If pins alone exceed the budget: over_budget_after_pins -> structured
 *    failure / narrow / clarify. Requirements are NEVER silently dropped.
 *  - Evidence competes by score; low-scoring/duplicate items are evicted or
 *    compressed, but provenance is preserved and evictions are traced.
 *  - Tainted items enter only as data, flagged for validation, never as
 *    instructions.
 */
export function assembleContext(input: CurationInput): AssembledContext {
  const trace: TraceEvent[] = [];
  const { taskId, budgetTokens } = input;

  // 1. Pins are mandatory.
  const pinnedTokens = input.pins.reduce((s, p) => s + p.tokens, 0);
  const pinned: AssembledItem[] = input.pins.map((p) => {
    trace.push({ type: 'pin', taskId, id: p.id, kind: p.kind });
    return {
      id: p.id,
      content: p.text,
      tokens: p.tokens,
      trust: 'trusted',
      strategy: 'none',
      provenance: [`pin:${p.kind}:${p.id}`],
      usableAsInstruction: true,
      requiresIndependentValidation: false,
    };
  });

  // 2. Hard gate: if pins alone exceed budget, do NOT silently drop them.
  if (pinnedTokens > budgetTokens) {
    const failure: StructuredFailure = {
      behavior: BEHAVIOR_ID,
      code: 'over_budget_after_pins',
      taskId,
      message:
        'Immutable pins exceed token budget; narrowing scope / requesting clarification instead of dropping a requirement.',
      unmetPinIds: input.pins.map((p) => p.id),
    };
    // A task with real requirements escalates rather than fabricating success.
    const hasRequirements = input.pins.some((p) => p.kind === 'requirement');
    const resolution: Resolution = hasRequirements
      ? 'structured_failure'
      : 'clarify';
    trace.push({
      type: 'over_budget_after_pins',
      taskId,
      resolution:
        resolution === 'structured_failure' ? 'structured_failure' : 'clarify',
    });
    return {
      taskId,
      pinned,
      evidence: [],
      evidenceEvictedForBudget: false,
      evictedRelevantIds: [],
      resolution,
      structuredFailure: resolution === 'structured_failure' ? failure : undefined,
      trace,
      totalTokens: pinnedTokens,
    };
  }

  // 3. Select evidence within remaining budget by descending composite score.
  const remaining = budgetTokens - pinnedTokens;
  const ranked = [...input.evidence].sort((a, b) => score(b) - score(a));

  const included: AssembledItem[] = [];
  const evictedRelevantIds: string[] = [];
  const seenCites = new Set<string>();
  let used = 0;

  for (const e of ranked) {
    const relevant = e.relevance >= RELEVANCE_KEEP_THRESHOLD;
    const cite = e.claim_id ?? e.event_ref;

    // Duplicate suppression: same cite already present.
    if (cite && seenCites.has(cite)) {
      trace.push({ type: 'evict', taskId, id: e.id, relevant, reason: 'duplicate' });
      if (relevant) evictedRelevantIds.push(e.id);
      continue;
    }

    const placed = placeInContext(e);
    if (used + placed.tokens > remaining) {
      trace.push({ type: 'evict', taskId, id: e.id, relevant, reason: 'budget' });
      if (relevant) evictedRelevantIds.push(e.id);
      continue;
    }

    if (e.trust === 'tainted') {
      trace.push({ type: 'taint', taskId, id: e.id, treatedAsData: true });
    }
    trace.push({
      type: 'include',
      taskId,
      id: e.id,
      cite: placed.cite,
      strategy: placed.strategy,
    });
    if (cite) seenCites.add(cite);
    used += placed.tokens;
    included.push(placed);
  }

  const evidenceEvictedForBudget = evictedRelevantIds.length > 0;

  return {
    taskId,
    pinned,
    evidence: included,
    evidenceEvictedForBudget,
    evictedRelevantIds,
    // Losing relevant evidence to budget is a signal to narrow scope, but the
    // step can still proceed with flagged degradation.
    resolution: evidenceEvictedForBudget ? 'narrow_scope' : 'ok',
    trace,
    totalTokens: pinnedTokens + used,
  };
}

/**
 * Controller decision: for nontrivial tasks, curate; for trivial ones the
 * controller may pass raw history. Returns whether curation was applied.
 */
export function prepareReasoningContext(
  input: CurationInput
): { curated: boolean; context: AssembledContext | null } {
  if (!input.nontrivial) {
    return { curated: false, context: null };
  }
  return { curated: true, context: assembleContext(input) };
}

/**
 * Guard used before consuming an assembled item as an instruction.
 * Tainted/data items must be validated first and may never drive control flow.
 */
export function canUseAsInstruction(item: AssembledItem): boolean {
  return item.trust === 'trusted' && item.usableAsInstruction;
}

export const behavior = {
  id: BEHAVIOR_ID,
  name: 'Governed context curation before each reasoning step',
  status: 'active' as const,
  added_epoch: 20,
  assembleContext,
  prepareReasoningContext,
  canUseAsInstruction,
};

export default behavior;
