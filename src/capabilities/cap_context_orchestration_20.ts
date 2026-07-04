/**
 * cap_context_orchestration_20
 *
 * Context orchestration non-authority, taint preservation, and requirement integrity.
 *
 * Implements con_context_non_authority_20. The context layer assembles a bundle of
 * items (retrieved memory, tool outputs, summaries) into a prompt-ready structure.
 *
 * Core principle: a synthesized/assembled artifact is NEVER an authority. Compression
 * is lossy assembly, not fact establishment. Taint is preserved monotonically as the
 * UNION of source taints. Tainted content is rendered as delimited DATA, never as
 * instructions. Immutable/pinned items are never evicted; a pinned-set overflow fails
 * closed with `over_budget_after_pins`.
 *
 * This is a pure assembly/validation layer: it decides what MAY enter a prompt and how
 * it is rendered; it never performs a side effect itself.
 */

import { redactSecrets, containsSecret } from './secret_redactor';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Taint = string;

/** Roles an item may play in a bundle. */
export type ItemRole =
  | 'requirement' // immutable requirement
  | 'success_criterion' // top-level success criterion
  | 'safety_boundary'
  | 'system_policy'
  | 'evidence' // ordinary validated evidence
  | 'summary' // lossy compression of other items
  | 'context'; // ordinary retrieved/observed context

export const IMMUTABLE_ROLES: ReadonlySet<ItemRole> = new Set<ItemRole>([
  'requirement',
  'success_criterion',
  'safety_boundary',
  'system_policy',
]);

export interface ContextItem {
  /** Content-address / stable id of the source (see cap_artifact_grounding_9). */
  readonly id: string;
  readonly role: ItemRole;
  /** Raw content text. */
  readonly content: string;
  /** Taints carried by this item's source(s). */
  readonly taints?: readonly Taint[];
  /** True if this item was produced by summarizing other (possibly tainted) items. */
  readonly isSummary?: boolean;
  /** For summaries: the ids of items that were compressed. */
  readonly derivedFrom?: readonly string[];
  /** Marked stale (superseded / expired). */
  readonly stale?: boolean;
  /** Source has been deleted from its store. */
  readonly sourceDeleted?: boolean;
  /** Estimated token/character budget cost. */
  readonly cost?: number;
}

/** How an item is rendered into the final prompt. */
export type RenderPosition = 'instruction' | 'data';

export interface RenderedItem {
  readonly id: string;
  readonly role: ItemRole;
  readonly position: RenderPosition;
  /** Rendered text (delimited when position === 'data'). */
  readonly text: string;
  readonly taints: readonly Taint[];
  readonly tainted: boolean;
}

export interface AssembledBundle {
  readonly items: readonly RenderedItem[];
  /** Monotonic union of every taint from every included item. */
  readonly taints: readonly Taint[];
  readonly tainted: boolean;
  readonly totalCost: number;
}

export type AssembleResult =
  | { ok: true; bundle: AssembledBundle }
  | { ok: false; reason: AssembleFailure; message: string };

export type AssembleFailure =
  | 'over_budget_after_pins'
  | 'policy_blocked';

/** Signalled when a bundle contains actual secret bytes: hard-terminate the session. */
export class VaultSecretExposureError extends Error {
  readonly policyBlocked = true;
  readonly terminateSession = true;
  constructor(message: string) {
    super(message);
    this.name = 'VaultSecretExposureError';
  }
}

// ---------------------------------------------------------------------------
// Taint helpers (monotonic union)
// ---------------------------------------------------------------------------

export function unionTaints(...groups: (readonly Taint[] | undefined)[]): Taint[] {
  const set = new Set<Taint>();
  for (const g of groups) {
    if (!g) continue;
    for (const t of g) if (t) set.add(t);
  }
  return [...set].sort();
}

/**
 * Effective taints for a single item. For a summary this is the UNION of the
 * summary's own declared taints and the taints of every item it derived from.
 * A summary of a tainted source is ALWAYS tainted (never max/first-source).
 */
export function effectiveTaints(
  item: ContextItem,
  byId: ReadonlyMap<string, ContextItem>,
): Taint[] {
  const parts: (readonly Taint[] | undefined)[] = [item.taints];
  if (item.isSummary && item.derivedFrom) {
    for (const srcId of item.derivedFrom) {
      const src = byId.get(srcId);
      if (src) parts.push(effectiveTaints(src, byId));
      else parts.push([`missing-source:${srcId}`]);
    }
  }
  return unionTaints(...parts);
}

// ---------------------------------------------------------------------------
// Rendering (instruction hierarchy)
// ---------------------------------------------------------------------------

export const DATA_OPEN = '<<<UNTRUSTED_DATA';
export const DATA_CLOSE = 'UNTRUSTED_DATA>>>';

/**
 * Render position is PROVENANCE-based, not surface-form. Any tainted item — and any
 * summary derived from tainted sources — is placed in a delimited DATA position and
 * never in an instruction position. Only untainted immutable/system items may occupy
 * an instruction position.
 */
export function renderPositionFor(item: ContextItem, tainted: boolean): RenderPosition {
  if (tainted) return 'data';
  if (item.isSummary) return 'data'; // summaries are lossy, never instructions
  if (IMMUTABLE_ROLES.has(item.role)) return 'instruction';
  return 'data';
}

function wrapAsData(id: string, content: string): string {
  // Neutralize any attempt to close the delimiter from inside the content.
  const safe = content.split(DATA_CLOSE).join('UNTRUSTED_DATA> >>');
  return `${DATA_OPEN} id="${id}">\n${safe}\n${DATA_CLOSE}`;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface AssembleOptions {
  /** Maximum total cost of the assembled bundle. */
  readonly budget: number;
}

/**
 * Assemble a bundle. Fails closed on budget/policy violations.
 *
 *  - Stale / deleted-source items are excluded before anything else.
 *  - Immutable items (requirement/success_criterion/safety_boundary/system_policy)
 *    are pinned and never evicted; if they alone exceed budget -> over_budget_after_pins.
 *  - Any item whose content contains actual secret bytes triggers a hard terminate.
 *  - All included content is passed through secret redaction.
 *  - Taint is unioned monotonically across the whole bundle.
 */
export function assembleBundle(
  items: readonly ContextItem[],
  opts: AssembleOptions,
): AssembleResult {
  const byId = new Map<string, ContextItem>();
  for (const it of items) byId.set(it.id, it);

  // Fail hard if any item carries real secret bytes.
  for (const it of items) {
    if (containsSecret(it.content)) {
      throw new VaultSecretExposureError(
        `policy_blocked: bundle item ${it.id} contains vault-held secret bytes; terminating session`,
      );
    }
  }

  // Exclude stale / deleted-source items up front.
  const admissible = items.filter((it) => !it.stale && !it.sourceDeleted);

  const pinned = admissible.filter((it) => IMMUTABLE_ROLES.has(it.role));
  const optional = admissible.filter((it) => !IMMUTABLE_ROLES.has(it.role));

  const costOf = (it: ContextItem) => (typeof it.cost === 'number' ? it.cost : it.content.length);

  const pinnedCost = pinned.reduce((n, it) => n + costOf(it), 0);
  if (pinnedCost > opts.budget) {
    // Never evict/weaken/summarize away an immutable item to fit budget.
    return {
      ok: false,
      reason: 'over_budget_after_pins',
      message: `pinned immutable items cost ${pinnedCost} exceed budget ${opts.budget}`,
    };
  }

  let remaining = opts.budget - pinnedCost;
  const chosenOptional: ContextItem[] = [];
  for (const it of optional) {
    const c = costOf(it);
    if (c <= remaining) {
      chosenOptional.push(it);
      remaining -= c;
    }
  }

  const chosen = [...pinned, ...chosenOptional];

  const rendered: RenderedItem[] = chosen.map((it) => {
    const taints = effectiveTaints(it, byId);
    const tainted = taints.length > 0;
    const position = renderPositionFor(it, tainted);
    const redacted = redactSecrets(it.content);
    const text = position === 'data' ? wrapAsData(it.id, redacted) : redacted;
    return { id: it.id, role: it.role, position, text, taints, tainted };
  });

  const allTaints = unionTaints(...rendered.map((r) => r.taints));

  return {
    ok: true,
    bundle: {
      items: rendered,
      taints: allTaints,
      tainted: allTaints.length > 0,
      totalCost: chosen.reduce((n, it) => n + costOf(it), 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Non-authority guards
// ---------------------------------------------------------------------------

export type AuthorityDenial =
  | 'context_cannot_authorize_dispatch'
  | 'context_cannot_satisfy_hitl'
  | 'context_cannot_set_tool_args'
  | 'summary_cannot_be_sole_evidence';

export class ContextAuthorityError extends Error {
  readonly denial: AuthorityDenial;
  constructor(denial: AuthorityDenial, message: string) {
    super(message);
    this.name = 'ContextAuthorityError';
    this.denial = denial;
  }
}

/**
 * The bundle is not an authorization signal. Any attempt to derive a dispatch
 * authorization from the bundle is denied.
 */
export function assertCannotAuthorizeDispatch(_bundle: AssembledBundle): never {
  throw new ContextAuthorityError(
    'context_cannot_authorize_dispatch',
    'an assembled context bundle can never authorize a tool/browser/API/vault dispatch',
  );
}

/** A bundle/summary can never satisfy a human-in-the-loop confirmation gate. */
export function assertCannotSatisfyHitl(_bundle: AssembledBundle): never {
  throw new ContextAuthorityError(
    'context_cannot_satisfy_hitl',
    'an assembled context bundle can never satisfy a HITL confirmation gate',
  );
}

/**
 * Context/summary text can never be passed to a tool adapter as an argument, URL,
 * api identifier, grant id, or sub-agent goal without independent validation. This
 * helper always refuses to hand raw bundle text to an adapter.
 */
export function assertCannotSetToolArgs(_bundle: AssembledBundle): never {
  throw new ContextAuthorityError(
    'context_cannot_set_tool_args',
    'context items/summaries must be independently validated before use as tool arguments',
  );
}

/**
 * A summary derived from tainted sources can never serve as sole evidence for a
 * success criterion, milestone, or skill criterion. Returns whether the given
 * rendered item is admissible as *sole* evidence.
 */
export function canServeAsSoleEvidence(item: RenderedItem): boolean {
  if (item.role === 'summary' || item.position === 'data') return false;
  if (item.tainted) return false;
  return true;
}

export function assertSoleEvidence(item: RenderedItem): void {
  if (!canServeAsSoleEvidence(item)) {
    throw new ContextAuthorityError(
      'summary_cannot_be_sole_evidence',
      `item ${item.id} (${item.role}) cannot satisfy a success criterion / milestone / skill criterion on its own`,
    );
  }
}

// ---------------------------------------------------------------------------
// Export sanitization
// ---------------------------------------------------------------------------

/**
 * Prepare a bundle for external export (e.g. logs, resume snapshots). Never reveal
 * hidden prompts, raw credentials, approval tokens, cookies, or deleted memory
 * content. Any secret bytes are a hard failure, not a redaction.
 */
export function exportBundle(bundle: AssembledBundle): string {
  const joined = bundle.items.map((i) => i.text).join('\n');
  if (containsSecret(joined)) {
    throw new VaultSecretExposureError(
      'policy_blocked: attempted to export a bundle containing secret bytes; terminating session',
    );
  }
  return redactSecrets(joined);
}

// ---------------------------------------------------------------------------
// Resume / rehydration
// ---------------------------------------------------------------------------

/**
 * On resume, re-validate persisted items rather than trusting lineage: re-exclude
 * stale and deleted-source items before reassembly.
 */
export function reassembleOnResume(
  persisted: readonly ContextItem[],
  opts: AssembleOptions,
): AssembleResult {
  const fresh = persisted.filter((it) => !it.stale && !it.sourceDeleted);
  return assembleBundle(fresh, opts);
}
