/**
 * context_manager — deterministic governed context curation.
 *
 * Implements the assembleContext() invariant enforced by the controller for
 * behavior beh_context_curation_20. This is NOT model prompting: it is a pure,
 * auditable function that pins immutable goal/requirements/policy, then
 * priority-evicts low-signal / stale / duplicate / tainted material to fit a
 * token budget, while preserving provenance via claim_id / trace event_ref
 * references and emitting a structured decision log.
 *
 * Design principles (see beh_context_curation_20):
 *  - Pins are immutable and MUST NOT be evicted. If pins alone exceed budget,
 *    over_budget_after_pins is set and the controller must narrow scope /
 *    clarify / return beh_structured_failure_2 — never silently drop a
 *    requirement.
 *  - Provenance survives compression: an evicted-but-relevant segment is
 *    replaced by a reference (claim_id / event_ref), never simply deleted.
 *  - Taint is non-strippable: a tainted segment stays tainted in the bundle and
 *    is marked as data-only (never an instruction) and requires validation
 *    before consequential use.
 *  - Every include / evict / reference / taint decision emits a trace event.
 */

export type Provenance = {
  /** stable identifier for a validated claim */
  claim_id?: string;
  /** reference into the trajectory trace where this observation originated */
  event_ref?: string;
  /** free-form source label */
  source?: string;
};

export type SegmentKind =
  | 'goal'
  | 'requirement'
  | 'policy'
  | 'evidence'
  | 'reasoning_trace'
  | 'tool_output'
  | 'summary';

export type ContextSegment = {
  id: string;
  kind: SegmentKind;
  content: string;
  /** cost in tokens; if omitted, estimated from content length */
  tokens?: number;
  /** true if this segment is an immutable pin (goal/requirement/policy) */
  pinned?: boolean;
  /** untrusted / possibly-poisoned observation; must be treated as data only */
  tainted?: boolean;
  /** whether a tainted segment has been independently validated */
  validated?: boolean;
  /** monotonic recency indicator; higher = fresher */
  freshness?: number;
  /** reliability / relevance signal in [0,1] */
  signal?: number;
  provenance?: Provenance;
};

export type EvictionReason =
  | 'over_budget'
  | 'stale'
  | 'duplicate'
  | 'low_signal';

export type IncludeMode = 'full' | 'reference';

export type TraceEvent =
  | {
      type: 'context.include';
      segment_id: string;
      kind: SegmentKind;
      pinned: boolean;
      tainted: boolean;
      mode: IncludeMode;
    }
  | {
      type: 'context.evict';
      segment_id: string;
      kind: SegmentKind;
      reason: EvictionReason;
      /** reference kept in place of the evicted content, if any */
      reference?: string;
      /** true when the evicted material was task-relevant (flagged for audit) */
      task_relevant: boolean;
    }
  | {
      type: 'context.taint';
      segment_id: string;
      validated: boolean;
      /** always true: tainted content is admitted as data, never as instruction */
      data_only: true;
    }
  | {
      type: 'context.over_budget_after_pins';
      pin_tokens: number;
      budget: number;
    };

export type BundleSegment = {
  id: string;
  kind: SegmentKind;
  pinned: boolean;
  tainted: boolean;
  /** for tainted segments: must be validated before consequential use */
  requires_validation: boolean;
  /** tainted content is admitted as data, never parsed as an instruction */
  data_only: boolean;
  mode: IncludeMode;
  content: string;
  provenance?: Provenance;
};

export type AssembleContextInput = {
  pins: ContextSegment[];
  candidates: ContextSegment[];
  tokenBudget: number;
};

export type AssembleContextResult = {
  bundle: BundleSegment[];
  evictionLog: TraceEvent[];
  traceEvents: TraceEvent[];
  over_budget_after_pins: boolean;
  /** true when at least one task-relevant segment was evicted for budget */
  evicted_relevant: boolean;
  usedTokens: number;
};

export function estimateTokens(seg: Pick<ContextSegment, 'tokens' | 'content'>): number {
  if (typeof seg.tokens === 'number') return Math.max(0, Math.ceil(seg.tokens));
  // crude but deterministic estimate: ~4 chars/token
  return Math.max(1, Math.ceil((seg.content?.length ?? 0) / 4));
}

function referenceFor(seg: ContextSegment): string | undefined {
  const p = seg.provenance;
  if (!p) return undefined;
  if (p.claim_id) return `claim:${p.claim_id}`;
  if (p.event_ref) return `event:${p.event_ref}`;
  return undefined;
}

// Higher score = kept first. Fresh, high-signal, non-tainted evidence wins.
// Reasoning traces and bulk tool outputs are shed before requirement-bearing
// evidence.
function candidateScore(seg: ContextSegment): number {
  const signal = typeof seg.signal === 'number' ? seg.signal : 0.5;
  const fresh = typeof seg.freshness === 'number' ? seg.freshness : 0;
  const kindWeight =
    seg.kind === 'evidence'
      ? 3
      : seg.kind === 'summary'
      ? 2
      : seg.kind === 'tool_output'
      ? 1
      : 0.5; // reasoning_trace shed first
  const taintPenalty = seg.tainted && !seg.validated ? 0.5 : 1;
  return (signal * 2 + fresh * 0.001 + kindWeight) * taintPenalty;
}

function isTaskRelevant(seg: ContextSegment): boolean {
  const signal = typeof seg.signal === 'number' ? seg.signal : 0.5;
  return seg.kind === 'evidence' && signal >= 0.4;
}

/**
 * Deterministically assemble a governed working-context bundle.
 *
 * Guarantees:
 *  - pins are always included (never evicted); if they exceed budget the result
 *    flags over_budget_after_pins and the controller must escalate.
 *  - duplicate candidates (same content) collapse to a single reference.
 *  - evicted-but-relevant evidence is replaced by a provenance reference when
 *    available, and the eviction is flagged.
 *  - tainted content is admitted as data-only and marked requires_validation.
 *  - every decision emits a trace event.
 */
export function assembleContext(input: AssembleContextInput): AssembleContextResult {
  const { pins, candidates, tokenBudget } = input;
  const traceEvents: TraceEvent[] = [];
  const evictionLog: TraceEvent[] = [];
  const bundle: BundleSegment[] = [];

  const pinTokens = pins.reduce((sum, p) => sum + estimateTokens(p), 0);
  const over_budget_after_pins = pinTokens > tokenBudget;

  const admit = (seg: ContextSegment, mode: IncludeMode): void => {
    const tainted = !!seg.tainted;
    bundle.push({
      id: seg.id,
      kind: seg.kind,
      pinned: !!seg.pinned,
      tainted,
      requires_validation: tainted && !seg.validated,
      data_only: tainted, // tainted => never an instruction
      mode,
      content: mode === 'reference' ? (referenceFor(seg) ?? `ref:${seg.id}`) : seg.content,
      provenance: seg.provenance,
    });
    const include: TraceEvent = {
      type: 'context.include',
      segment_id: seg.id,
      kind: seg.kind,
      pinned: !!seg.pinned,
      tainted,
      mode,
    };
    traceEvents.push(include);
    if (tainted) {
      traceEvents.push({
        type: 'context.taint',
        segment_id: seg.id,
        validated: !!seg.validated,
        data_only: true,
      });
    }
  };

  const evict = (seg: ContextSegment, reason: EvictionReason): void => {
    const relevant = isTaskRelevant(seg);
    const reference = relevant ? referenceFor(seg) : undefined;
    const ev: TraceEvent = {
      type: 'context.evict',
      segment_id: seg.id,
      kind: seg.kind,
      reason,
      reference,
      task_relevant: relevant,
    };
    evictionLog.push(ev);
    traceEvents.push(ev);
    // Preserve provenance: relevant evicted evidence is re-admitted as a
    // reference so the requirement/claim survives compression.
    if (relevant && reference) {
      admit(seg, 'reference');
    }
  };

  // 1) Always include pins first — they are immutable.
  for (const p of pins) {
    admit({ ...p, pinned: true }, 'full');
  }

  if (over_budget_after_pins) {
    traceEvents.push({
      type: 'context.over_budget_after_pins',
      pin_tokens: pinTokens,
      budget: tokenBudget,
    });
    // Do NOT drop pins; caller must escalate. Return with no candidates fitted.
    const usedTokens = pinTokens;
    return {
      bundle,
      evictionLog,
      traceEvents,
      over_budget_after_pins,
      evicted_relevant: false,
      usedTokens,
    };
  }

  // 2) De-duplicate candidates (keep highest score per content).
  const seen = new Map<string, ContextSegment>();
  const duplicates: ContextSegment[] = [];
  for (const c of candidates) {
    const key = `${c.kind}::${c.content}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, c);
    } else if (candidateScore(c) > candidateScore(existing)) {
      duplicates.push(existing);
      seen.set(key, c);
    } else {
      duplicates.push(c);
    }
  }
  for (const d of duplicates) evict(d, 'duplicate');

  // 3) Priority-fit remaining candidates within the residual budget.
  const ranked = [...seen.values()].sort((a, b) => candidateScore(b) - candidateScore(a));

  let used = pinTokens;
  for (const c of ranked) {
    const cost = estimateTokens(c);
    if (used + cost <= tokenBudget) {
      admit(c, 'full');
      used += cost;
    } else {
      const reason: EvictionReason =
        (typeof c.signal === 'number' && c.signal < 0.3) ? 'low_signal' : 'over_budget';
      evict(c, reason);
    }
  }

  const evicted_relevant = evictionLog.some(
    (e) => e.type === 'context.evict' && e.task_relevant,
  );

  return {
    bundle,
    evictionLog,
    traceEvents,
    over_budget_after_pins,
    evicted_relevant,
    usedTokens: used,
  };
}

/**
 * Controller escalation guidance when pins alone blow the budget.
 * Consistent with beh_structured_failure_2: never silently drop a requirement.
 */
export type OverBudgetAction = 'narrow_scope' | 'request_clarification' | 'structured_failure';

export function overBudgetAfterPinsAction(result: AssembleContextResult): OverBudgetAction | null {
  if (!result.over_budget_after_pins) return null;
  // Deterministic default escalation; the controller may choose any of the
  // three, but it must be one of them — never a silent requirement drop.
  return 'structured_failure';
}
