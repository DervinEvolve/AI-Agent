/**
 * Context manager: serialization measurement and atomic-group prefix selection.
 *
 * Prefix selection is the shortest oldest contiguous run of eligible atomic
 * groups (an assistant tool-call message plus every ToolResult that answers
 * it — never a single call_id) whose removal, after substituting a bounded
 * untrusted summary and re-rendering the previous summary inside the measured
 * request, makes the next serialized request fit including response and
 * compaction headroom.
 *
 * The walk stops at the first ineligible or unresolved/unknown-outcome group
 * and never skips it or the newest group. Successive successful prefixes cover
 * disjoint, strictly increasing ordinals.
 */

export const WORKING_SUMMARY_MAX_CHARS = 4000;
export const RECALL_REF_CAP = 16;
export const DEFAULT_RESPONSE_HEADROOM_CHARS = 2048;
export const DEFAULT_COMPACTION_HEADROOM_CHARS = 512;

export type TurnRole = "user" | "assistant" | "tool" | "system";

export interface TurnMessage {
  role: TurnRole;
  content: string;
  /** Present on an assistant message that issued tool calls. */
  toolCallIds?: string[];
  /** Present on a tool result that answers one call. */
  callId?: string;
  /** Outcome of a tool result. Absent or "unknown" blocks compaction of the group. */
  outcome?: "ok" | "error" | "unresolved" | "unknown";
}

export interface AtomicGroup {
  /** 1-based ordinal, stable across compactions of earlier groups. */
  ordinal: number;
  messages: TurnMessage[];
  /** True when every tool call in the group has a resolved ok|error result. */
  eligible: boolean;
  /** Why the group cannot be compacted, if ineligible. */
  ineligibleReason?: "unresolved_or_unknown" | "newest" | "no_tool_pair";
}

export interface RecallRef {
  call_id: string;
  status: string;
  truncated: boolean;
}

export interface SerializedRequestParts {
  instructions: string;
  toolSchemas: string;
  protectedState: string;
  workingSummary: string;
  recallRefs: RecallRef[];
  retainedTurns: TurnMessage[];
}

export type UnfitReason =
  | "tail_alone_cannot_fit"
  | "eligible_prefix_empty"
  | "eligible_prefix_insufficient"
  | "summarizer_absent";

export type ContextFit =
  | { outcome: "already_fits"; serializedChars: number; budgetChars: number }
  | {
      outcome: "fits_after_compaction";
      prefixOrdinals: number[];
      serializedChars: number;
      budgetChars: number;
    }
  | {
      outcome: "unfit";
      reason: UnfitReason;
      serializedChars: number;
      budgetChars: number;
    };

export interface MeasureBudget {
  /** Hard character budget for the full serialized request plus headroom. */
  maxChars: number;
  responseHeadroomChars?: number;
  compactionHeadroomChars?: number;
}

const UNTRUSTED_LABEL = "[untrusted working summary]";

export function labelUntrustedSummary(text: string): string {
  const body = text.length > WORKING_SUMMARY_MAX_CHARS
    ? text.slice(0, WORKING_SUMMARY_MAX_CHARS)
    : text;
  const labelled = body.startsWith(UNTRUSTED_LABEL) ? body : `${UNTRUSTED_LABEL}\n${body}`;
  return labelled.length > WORKING_SUMMARY_MAX_CHARS
    ? labelled.slice(0, WORKING_SUMMARY_MAX_CHARS)
    : labelled;
}

export function capRecallRefs(refs: RecallRef[]): RecallRef[] {
  const metadata = refs.map((r) => ({
    call_id: r.call_id,
    status: r.status,
    truncated: Boolean(r.truncated),
  }));
  if (metadata.length <= RECALL_REF_CAP) return metadata;
  return metadata.slice(metadata.length - RECALL_REF_CAP);
}

/** Group an assistant tool-call message with all of its ToolResults. Never split a call_id. */
export function groupAtomicTurns(turns: TurnMessage[]): AtomicGroup[] {
  const groups: AtomicGroup[] = [];
  let i = 0;
  let ordinal = 1;
  while (i < turns.length) {
    const msg = turns[i];
    if (msg.role === "assistant" && msg.toolCallIds && msg.toolCallIds.length > 0) {
      const ids = new Set(msg.toolCallIds);
      const messages: TurnMessage[] = [msg];
      let j = i + 1;
      const seen = new Set<string>();
      while (j < turns.length && turns[j].role === "tool" && turns[j].callId && ids.has(turns[j].callId!)) {
        messages.push(turns[j]);
        seen.add(turns[j].callId!);
        j++;
      }
      const unresolved = messages.some(
        (m) => m.role === "tool" && (m.outcome === "unresolved" || m.outcome === "unknown" || m.outcome === undefined),
      );
      const missing = [...ids].some((id) => !seen.has(id));
      const eligible = !unresolved && !missing && seen.size === ids.size;
      groups.push({
        ordinal,
        messages,
        eligible,
        ineligibleReason: eligible ? undefined : "unresolved_or_unknown",
      });
      ordinal += 1;
      i = j;
      continue;
    }
    groups.push({
      ordinal,
      messages: [msg],
      eligible: false,
      ineligibleReason: "no_tool_pair",
    });
    ordinal += 1;
    i += 1;
  }
  if (groups.length > 0) {
    const last = groups[groups.length - 1];
    last.eligible = false;
    last.ineligibleReason = "newest";
  }
  return groups;
}

export function serializeRequest(parts: SerializedRequestParts): string {
  const recalls = capRecallRefs(parts.recallRefs)
    .map((r) => `${r.call_id}|${r.status}|${r.truncated ? "1" : "0"}`)
    .join(";");
  const turns = parts.retainedTurns
    .map((t) => {
      const id = t.callId ? ` call=${t.callId}` : "";
      const tools = t.toolCallIds ? ` tools=${t.toolCallIds.join(",")}` : "";
      return `${t.role}${id}${tools}: ${t.content}`;
    })
    .join("\n");
  return [
    `instructions:${parts.instructions}`,
    `tools:${parts.toolSchemas}`,
    `protected:${parts.protectedState}`,
    `summary:${parts.workingSummary}`,
    `recalls:${recalls}`,
    `turns:${turns}`,
  ].join("\n");
}

export function measureSerialized(parts: SerializedRequestParts, budget: MeasureBudget): {
  serializedChars: number;
  budgetChars: number;
  fits: boolean;
} {
  const response = budget.responseHeadroomChars ?? DEFAULT_RESPONSE_HEADROOM_CHARS;
  const compaction = budget.compactionHeadroomChars ?? DEFAULT_COMPACTION_HEADROOM_CHARS;
  const budgetChars = budget.maxChars;
  const serializedChars = serializeRequest(parts).length + response + compaction;
  return { serializedChars, budgetChars, fits: serializedChars <= budgetChars };
}

export interface PrefixSelection {
  fit: ContextFit;
  /** Groups retained after applying the selected prefix (not yet summarized). */
  retainedGroups: AtomicGroup[];
  removedGroups: AtomicGroup[];
}

/**
 * Pure prefix selector. `renderSummary` is a stand-in length for the untrusted
 * summary that would replace the removed prefix; the previous summary is
 * re-rendered inside the measured request (passed in `parts.workingSummary`
 * as the current summary, and combined by the caller into the candidate).
 */
export function selectCompactionPrefix(
  parts: SerializedRequestParts,
  budget: MeasureBudget,
  options: { summarizerMounted: boolean; previousSummary?: string },
): PrefixSelection {
  const groups = groupAtomicTurns(parts.retainedTurns);
  const baseMeasure = measureSerialized(parts, budget);

  if (!options.summarizerMounted) {
    return {
      fit: {
        outcome: "unfit",
        reason: "summarizer_absent",
        serializedChars: baseMeasure.serializedChars,
        budgetChars: baseMeasure.budgetChars,
      },
      retainedGroups: groups,
      removedGroups: [],
    };
  }

  if (baseMeasure.fits) {
    return {
      fit: {
        outcome: "already_fits",
        serializedChars: baseMeasure.serializedChars,
        budgetChars: baseMeasure.budgetChars,
      },
      retainedGroups: groups,
      removedGroups: [],
    };
  }

  // Eligible prefix: oldest contiguous groups that are eligible, stopping at
  // the first ineligible (including newest, which is always ineligible).
  const eligible: AtomicGroup[] = [];
  for (const g of groups) {
    if (!g.eligible) break;
    eligible.push(g);
  }

  if (eligible.length === 0) {
    const tailOnly = measureSerialized(
      { ...parts, retainedTurns: groups.flatMap((g) => g.messages), workingSummary: options.previousSummary ?? parts.workingSummary },
      budget,
    );
    const reason: UnfitReason = groups.length <= 1 || groups.every((g) => !g.eligible)
      ? "eligible_prefix_empty"
      : "tail_alone_cannot_fit";
    // If nothing is eligible, distinguish empty prefix from a tail that cannot fit.
    // Newest-only transcripts have an empty eligible prefix.
    return {
      fit: {
        outcome: "unfit",
        reason: "eligible_prefix_empty",
        serializedChars: tailOnly.serializedChars,
        budgetChars: tailOnly.budgetChars,
      },
      retainedGroups: groups,
      removedGroups: [],
    };
  }

  // Shortest oldest prefix whose removal fits.
  let chosen = 0;
  let chosenMeasure = baseMeasure;
  for (let n = 1; n <= eligible.length; n++) {
    const removed = eligible.slice(0, n);
    const retained = groups.slice(n);
    const summarySeed = [options.previousSummary ?? "", parts.workingSummary, `compacted:${removed.map((g) => g.ordinal).join(",")}`]
      .filter(Boolean)
      .join("\n");
    const summary = labelUntrustedSummary(summarySeed);
    const candidate: SerializedRequestParts = {
      ...parts,
      workingSummary: summary,
      retainedTurns: retained.flatMap((g) => g.messages),
    };
    const measured = measureSerialized(candidate, budget);
    if (measured.fits) {
      chosen = n;
      chosenMeasure = measured;
      break;
    }
    chosenMeasure = measured;
  }

  if (chosen === 0) {
    // Eligible prefix exhausted and still does not fit: tail alone cannot fit
    // if even removing every eligible group fails.
    const retained = groups.slice(eligible.length);
    const tailMeasure = measureSerialized(
      {
        ...parts,
        workingSummary: labelUntrustedSummary(options.previousSummary ?? parts.workingSummary),
        retainedTurns: retained.flatMap((g) => g.messages),
      },
      budget,
    );
    return {
      fit: {
        outcome: "unfit",
        reason: tailMeasure.fits ? "eligible_prefix_insufficient" : "tail_alone_cannot_fit",
        serializedChars: tailMeasure.serializedChars,
        budgetChars: tailMeasure.budgetChars,
      },
      retainedGroups: groups,
      removedGroups: [],
    };
  }

  return {
    fit: {
      outcome: "fits_after_compaction",
      prefixOrdinals: eligible.slice(0, chosen).map((g) => g.ordinal),
      serializedChars: chosenMeasure.serializedChars,
      budgetChars: chosenMeasure.budgetChars,
    },
    retainedGroups: groups.slice(chosen),
    removedGroups: eligible.slice(0, chosen),
  };
}

export class ContextManager {
  private summary = "";
  private readonly compactedOrdinals: number[] = [];

  constructor(private readonly budget: MeasureBudget) {}

  get workingSummary(): string {
    return this.summary;
  }

  get compacted(): readonly number[] {
    return this.compactedOrdinals;
  }

  /** Publish the fit decision without mutating summary or transcript. */
  evaluateFit(
    parts: SerializedRequestParts,
    options: { summarizerMounted: boolean },
  ): ContextFit {
    const selection = selectCompactionPrefix(parts, this.budget, {
      summarizerMounted: options.summarizerMounted,
      previousSummary: this.summary,
    });
    return selection.fit;
  }

  /**
   * Apply a successful prefix only. Unfit and already_fits do not write a summary.
   * Returns the new retained turns. Previous summary is re-rendered, not a new group.
   */
  applyPrefix(
    parts: SerializedRequestParts,
    summaryText: string,
    options: { summarizerMounted: boolean },
  ): { fit: ContextFit; retainedTurns: TurnMessage[]; summary: string } {
    const selection = selectCompactionPrefix(
      { ...parts, workingSummary: this.summary || parts.workingSummary },
      this.budget,
      { summarizerMounted: options.summarizerMounted, previousSummary: this.summary },
    );
    if (selection.fit.outcome !== "fits_after_compaction") {
      return { fit: selection.fit, retainedTurns: parts.retainedTurns, summary: this.summary };
    }
    const next = labelUntrustedSummary(
      [this.summary, summaryText].filter(Boolean).join("\n"),
    );
    // Ordinals must be strictly increasing and disjoint from prior successes.
    const priorMax = this.compactedOrdinals.length
      ? this.compactedOrdinals[this.compactedOrdinals.length - 1]
      : 0;
    for (const ordinal of selection.fit.prefixOrdinals) {
      if (ordinal <= priorMax) {
        return {
          fit: {
            outcome: "unfit",
            reason: "eligible_prefix_insufficient",
            serializedChars: selection.fit.serializedChars,
            budgetChars: selection.fit.budgetChars,
          },
          retainedTurns: parts.retainedTurns,
          summary: this.summary,
        };
      }
    }
    for (const ordinal of selection.fit.prefixOrdinals) {
      this.compactedOrdinals.push(ordinal);
    }
    this.summary = next;
    const retainedTurns = selection.retainedGroups.flatMap((g) => g.messages);
    return { fit: selection.fit, retainedTurns, summary: this.summary };
  }
}
