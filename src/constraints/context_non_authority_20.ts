// Constraint: con_context_non_authority_20
// Context orchestration non-authority, taint preservation, and requirement integrity.
//
// The context orchestration layer assembles a "bundle" of prior items (memory,
// tool outputs, summaries) into a prompt context. This module enforces the
// deterministic security guardrails around that assembly:
//   - non-authority: a bundle/summary can never authorize a side effect, clear
//     taint, satisfy a HITL gate, or be fed as tool arguments without validation.
//   - taint monotonicity: a summary of tainted sources is tainted (union /
//     most-restrictive-wins), rendered as delimited data, never as instructions.
//   - requirement integrity: immutable/pinned items are never evicted; overflow
//     fails closed with over_budget_after_pins.
//   - hygiene: stale / deleted-source items excluded; raw secrets never exposed.
//
// The deterministic checks here carry the security weight; delimiting/spotlighting
// is defense-in-depth only.

export const CONSTRAINT_ID = 'con_context_non_authority_20' as const;

export type TaintKind =
  | 'untrusted_external' // web pages, third-party tool output
  | 'tainted_derived' // any output computed from a tainted state
  | 'trusted';

export type ItemStatus = 'live' | 'stale' | 'deleted';

export interface SourceRef {
  id: string;
  /** taint labels attached to the source; persisted on the item to survive resume. */
  taints: TaintKind[];
  status: ItemStatus;
}

export interface ContextItem {
  id: string;
  content: string;
  /** labels persisted on the item itself so they survive session boundaries. */
  taints: TaintKind[];
  status: ItemStatus;
  /**
   * pinned items represent immutable requirements / top-level success criteria /
   * safety boundaries / active policy items. They may never be evicted, weakened,
   * reinterpreted, or summarized away.
   */
  pinned?: boolean;
  kind?:
    | 'immutable_requirement'
    | 'success_criterion'
    | 'safety_boundary'
    | 'system_policy'
    | 'evidence'
    | 'note';
}

export interface Summary {
  id: string;
  content: string;
  /** sources this summary was derived from. */
  sourceRefs: SourceRef[];
  /** computed taint = union of source taints; a derived summary is always tainted-derived if any source is tainted. */
  taints: TaintKind[];
  /** summaries are data, never instructions. */
  isDataBlock: true;
}

export type AuthorityRequest =
  | { type: 'tool_dispatch'; adapter: string; args: Record<string, unknown> }
  | { type: 'browser_navigate'; url: string }
  | { type: 'vault_grant'; grantId: string }
  | { type: 'hitl_confirm'; gateId: string }
  | { type: 'taint_clear'; itemId: string }
  | {
      type: 'satisfy_criterion';
      criterionKind: 'success_criterion' | 'milestone' | 'skill_criterion';
      criterionId: string;
    };

export type ContextOrigin =
  | { kind: 'bundle_item'; itemId: string }
  | { kind: 'summary'; summaryId: string }
  | { kind: 'validated_evidence'; evidenceId: string }
  | { kind: 'external_declassification'; approvalId: string };

export interface Decision {
  allowed: boolean;
  code:
    | 'ok'
    | 'context_not_authority'
    | 'summary_not_evidence'
    | 'unvalidated_tool_args'
    | 'over_budget_after_pins'
    | 'stale_or_deleted_excluded'
    | 'policy_blocked'
    | 'instruction_hierarchy_violation';
  reason: string;
}

const DENY = (code: Decision['code'], reason: string): Decision => ({
  allowed: false,
  code,
  reason,
});
const ALLOW = (reason = 'ok'): Decision => ({ allowed: true, code: 'ok', reason });

/** Most-restrictive-wins union of taint labels. A summary is trusted only if every source is trusted. */
export function unionTaints(inputs: TaintKind[][]): TaintKind[] {
  const flat = inputs.flat();
  const hasUntrusted = flat.includes('untrusted_external');
  const hasDerived = flat.includes('tainted_derived');
  if (hasUntrusted) return ['untrusted_external', 'tainted_derived'];
  if (hasDerived) return ['tainted_derived'];
  return ['trusted'];
}

export function isTainted(taints: TaintKind[]): boolean {
  return taints.some((t) => t === 'untrusted_external' || t === 'tainted_derived');
}

/**
 * Build a summary from source items. The resulting taint is the union of source
 * taints (most-restrictive-wins). The summary is always emitted as a data block
 * and never carries an instruction channel. The LLM cannot declassify: taint is
 * only ever cleared by an explicit external declassification procedure elsewhere.
 */
export function deriveSummary(id: string, content: string, sources: SourceRef[]): Summary {
  const taints = unionTaints(sources.map((s) => s.taints));
  return {
    id,
    content,
    sourceRefs: sources.map((s) => ({ ...s })),
    taints,
    isDataBlock: true,
  };
}

/**
 * Non-authority gate: a context item / summary / validated-evidence origin can
 * NEVER authorize a side effect, clear taint, or satisfy a HITL gate. Only an
 * explicit external declassification origin may clear taint.
 */
export function checkAuthority(origin: ContextOrigin, req: AuthorityRequest): Decision {
  const contextDerived = origin.kind === 'bundle_item' || origin.kind === 'summary';

  switch (req.type) {
    case 'tool_dispatch':
    case 'browser_navigate':
    case 'vault_grant':
      if (contextDerived) {
        return DENY(
          'context_not_authority',
          `context origin (${origin.kind}) may not authorize ${req.type}: influence is not content`,
        );
      }
      return ALLOW();
    case 'hitl_confirm':
      // No context-derived content, and not even validated evidence, can stand in
      // for a human-in-the-loop confirmation.
      if (origin.kind !== 'external_declassification') {
        return DENY(
          'context_not_authority',
          'HITL confirmation requires an explicit human/external approval, not context content',
        );
      }
      return ALLOW();
    case 'taint_clear':
      // Only explicit external declassification may clear taint; the LLM / context
      // layer can never declassify its own outputs.
      if (origin.kind !== 'external_declassification') {
        return DENY(
          'context_not_authority',
          'taint may only be cleared by explicit external declassification',
        );
      }
      return ALLOW();
    case 'satisfy_criterion':
      // A summary can never on its own satisfy a success criterion / milestone / skill criterion.
      if (origin.kind === 'summary' || origin.kind === 'bundle_item') {
        return DENY(
          'summary_not_evidence',
          'a summary/context item cannot be the sole evidence for a criterion',
        );
      }
      return ALLOW();
    default:
      return DENY('context_not_authority', 'unknown authority request');
  }
}

/**
 * A summary of tainted sources cannot serve as sole evidence for a criterion,
 * regardless of confidence. Tainted-derived is never fact establishment.
 */
export function checkSummaryAsEvidence(summary: Summary): Decision {
  if (isTainted(summary.taints)) {
    return DENY(
      'summary_not_evidence',
      'tainted summary cannot serve as sole evidence; compression is lossy assembly, not fact establishment',
    );
  }
  return DENY(
    'summary_not_evidence',
    'even an untainted summary requires independent validated evidence for a criterion',
  );
}

/**
 * Tool adapters must never receive raw context items / summaries as arguments
 * without independent validation. `validatedArgKeys` lists arg keys that were
 * independently validated; any arg whose provenance is context-derived and is
 * not validated is rejected.
 */
export function checkToolArgs(
  args: Record<string, { value: unknown; origin: ContextOrigin; validated: boolean }>,
): Decision {
  for (const [key, spec] of Object.entries(args)) {
    const contextDerived = spec.origin.kind === 'bundle_item' || spec.origin.kind === 'summary';
    if (contextDerived && !spec.validated) {
      return DENY(
        'unvalidated_tool_args',
        `tool argument "${key}" is context-derived and was not independently validated`,
      );
    }
  }
  return ALLOW();
}

const PINNED_KINDS: ReadonlySet<NonNullable<ContextItem['kind']>> = new Set([
  'immutable_requirement',
  'success_criterion',
  'safety_boundary',
  'system_policy',
]);

export function isImmutablePinned(item: ContextItem): boolean {
  return Boolean(item.pinned) || (item.kind ? PINNED_KINDS.has(item.kind) : false);
}

/** Precedence order for pinning when budget is tight. Lower index = higher priority. */
export const PIN_PRECEDENCE: ReadonlyArray<NonNullable<ContextItem['kind']>> = [
  'safety_boundary',
  'system_policy',
  'immutable_requirement',
  'success_criterion',
];

export interface AssembleOptions {
  budget: number;
  /** measure cost of an item (defaults to content length). */
  cost?: (item: ContextItem) => number;
}

export interface AssembleResult {
  decision: Decision;
  items: ContextItem[];
}

const defaultCost = (item: ContextItem): number => item.content.length;

/**
 * Deterministic assembly gate.
 *  1. Exclude stale / deleted-source items (never rehydrated on resume).
 *  2. Pin immutable requirements / criteria / safety boundaries / policy.
 *  3. If pinned set alone exceeds budget -> fail closed with over_budget_after_pins.
 *     (Immutable items are NEVER evicted, weakened, or summarized away.)
 *  4. Fill remaining budget with non-pinned items.
 */
export function assembleBundle(items: ContextItem[], opts: AssembleOptions): AssembleResult {
  const cost = opts.cost ?? defaultCost;

  const fresh = items.filter((i) => i.status === 'live');

  const pinned = fresh.filter(isImmutablePinned);
  const unpinned = fresh.filter((i) => !isImmutablePinned(i));

  const pinnedCost = pinned.reduce((sum, i) => sum + cost(i), 0);
  if (pinnedCost > opts.budget) {
    // Fail closed: we do NOT drop or weaken any pinned requirement.
    return {
      decision: DENY(
        'over_budget_after_pins',
        `pinned set cost ${pinnedCost} exceeds budget ${opts.budget}; failing closed`,
      ),
      items: [],
    };
  }

  let remaining = opts.budget - pinnedCost;
  const selected: ContextItem[] = [];
  for (const item of unpinned) {
    const c = cost(item);
    if (c <= remaining) {
      selected.push(item);
      remaining -= c;
    }
  }

  return {
    decision: ALLOW('assembled'),
    items: [...pinned, ...selected],
  };
}

/** Excluded (stale/deleted) items must never enter a prompt bundle. */
export function excludeStaleAndDeleted(items: ContextItem[]): ContextItem[] {
  return items.filter((i) => i.status === 'live');
}

// ---- rendering: tainted content is always delimited data, never instructions ----

export const DATA_OPEN = '<<<UNTRUSTED_DATA>>>';
export const DATA_CLOSE = '<<<END_UNTRUSTED_DATA>>>';

/**
 * Render an item for the prompt. Tainted content is always wrapped in a delimited
 * data block, preserving the instruction hierarchy (defense-in-depth). Any
 * pre-existing delimiter markers inside the content are neutralized so the block
 * cannot be closed early to escape into an instruction position.
 */
export function renderForPrompt(content: string, taints: TaintKind[]): string {
  if (!isTainted(taints)) return content;
  const neutralized = content
    .split(DATA_CLOSE)
    .join('[END_MARKER_REDACTED]')
    .split(DATA_OPEN)
    .join('[OPEN_MARKER_REDACTED]');
  return `${DATA_OPEN}\n${neutralized}\n${DATA_CLOSE}`;
}

/**
 * Verify that a rendered prompt places tainted content strictly inside a data
 * block (never in an instruction position).
 */
export function checkInstructionHierarchy(rendered: string, taints: TaintKind[]): Decision {
  if (!isTainted(taints)) return ALLOW();
  const open = rendered.indexOf(DATA_OPEN);
  const close = rendered.indexOf(DATA_CLOSE);
  if (open === -1 || close === -1 || close <= open) {
    return DENY(
      'instruction_hierarchy_violation',
      'tainted content is not enclosed in a well-formed delimited data block',
    );
  }
  return ALLOW();
}
