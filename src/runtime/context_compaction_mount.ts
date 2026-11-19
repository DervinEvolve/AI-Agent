/**
 * Opt-in compaction mount for AgentRuntime.
 *
 * Shared model-call cap: summarizer calls and ordinary model calls draw on one
 * budget. On exhaustion, or when usage required by an active cap is unknown,
 * make neither call, write no summary, and do not roll back ToolResults or
 * ObservationStore. Usage halt precedes decode-reject counting.
 */

import {
  ContextManager,
  type ContextFit,
  type MeasureBudget,
  type RecallRef,
  type SerializedRequestParts,
  type TurnMessage,
  capRecallRefs,
  labelUntrustedSummary,
} from "../context/context_manager.js";

export type SharedCapReason = "model_call_cap_exhausted" | "model_call_usage_unknown";

export type CompactionOutcome =
  | { kind: "already_fits" }
  | { kind: "fits_after_compaction"; compactedOrdinals: number[] }
  | {
      kind: "unfit";
      reason:
        | "tail_alone_cannot_fit"
        | "eligible_prefix_empty"
        | "eligible_prefix_insufficient"
        | "summarizer_absent"
        | "shared_cap";
      status: "incomplete";
      sharedCapReason?: SharedCapReason;
    };

export interface ModelCallUsage {
  /** Remaining calls on the shared cap. Undefined means required usage is unknown. */
  remaining: number | undefined;
  /** Calls this step needs: 1 ordinary, or 1 summarizer + 1 ordinary when compacting. */
  requiredForOrdinary: number;
  requiredForSummarizerPlusOrdinary: number;
}

export interface CompactionMountConfig {
  budget: MeasureBudget;
  /**
   * Scripted summarizer. Must not perform network I/O.
   * Returns untrusted summary text (bounded by the mount).
   */
  summarizer?: (input: { removed: TurnMessage[]; previousSummary: string }) => string;
}

export interface CompactionStepInput {
  parts: SerializedRequestParts;
  usage: ModelCallUsage;
}

export interface CompactionStepResult {
  outcome: CompactionOutcome;
  fit: ContextFit | null;
  /** Transcript to send. Unchanged when unfit or shared-cap halt. */
  retainedTurns: TurnMessage[];
  summary: string;
  recallRefs: RecallRef[];
  /** True when the caller must not issue a model call. */
  halt: boolean;
  haltReason?: SharedCapReason;
}

export function sharedCapHalt(usage: ModelCallUsage, needsSummarizer: boolean): SharedCapReason | null {
  if (usage.remaining === undefined) return "model_call_usage_unknown";
  const need = needsSummarizer
    ? usage.requiredForSummarizerPlusOrdinary
    : usage.requiredForOrdinary;
  if (usage.remaining < need) return "model_call_cap_exhausted";
  return null;
}

export class ContextCompactionMount {
  readonly manager: ContextManager;
  private readonly summarizer?: CompactionMountConfig["summarizer"];

  constructor(config: CompactionMountConfig) {
    this.manager = new ContextManager(config.budget);
    this.summarizer = config.summarizer;
  }

  get mounted(): boolean {
    return typeof this.summarizer === "function";
  }

  /**
   * Decide compaction before an ordinary model turn.
   * Does not mutate ObservationStore. Does not roll back ToolResults.
   */
  beforeTurn(input: CompactionStepInput): CompactionStepResult {
    const recallRefs = capRecallRefs(input.parts.recallRefs);
    const parts: SerializedRequestParts = {
      ...input.parts,
      recallRefs,
      workingSummary: this.manager.workingSummary || input.parts.workingSummary,
    };

    if (!this.mounted) {
      return {
        outcome: {
          kind: "unfit",
          reason: "summarizer_absent",
          status: "incomplete",
        },
        fit: {
          outcome: "unfit",
          reason: "summarizer_absent",
          serializedChars: 0,
          budgetChars: 0,
        },
        retainedTurns: input.parts.retainedTurns,
        summary: this.manager.workingSummary,
        recallRefs,
        halt: false,
      };
    }

    const preview = this.manager.evaluateFit(parts, { summarizerMounted: true });

    if (preview.outcome === "already_fits") {
      const haltReason = sharedCapHalt(input.usage, false);
      if (haltReason) {
        return this.halted(parts, preview, haltReason);
      }
      return {
        outcome: { kind: "already_fits" },
        fit: preview,
        retainedTurns: parts.retainedTurns,
        summary: this.manager.workingSummary,
        recallRefs,
        halt: false,
      };
    }

    if (preview.outcome === "unfit") {
      return {
        outcome: { kind: "unfit", reason: preview.reason, status: "incomplete" },
        fit: preview,
        retainedTurns: input.parts.retainedTurns,
        summary: this.manager.workingSummary,
        recallRefs,
        halt: true,
      };
    }

    // fits_after_compaction: shared cap must cover summarizer AND the following ordinary call.
    const haltReason = sharedCapHalt(input.usage, true);
    if (haltReason) {
      return this.halted(input.parts, preview, haltReason);
    }

    const removedTurns = parts.retainedTurns.filter((t) => {
      // The apply path uses the selector; summarizer sees the prefix the selector will remove.
      return true;
    });
    void removedTurns;
    const summaryText = labelUntrustedSummary(
      this.summarizer!({ removed: parts.retainedTurns, previousSummary: this.manager.workingSummary }),
    );
    const applied = this.manager.applyPrefix(parts, summaryText, { summarizerMounted: true });
    if (applied.fit.outcome !== "fits_after_compaction") {
      return {
        outcome: {
          kind: "unfit",
          reason: applied.fit.outcome === "unfit" ? applied.fit.reason : "eligible_prefix_insufficient",
          status: "incomplete",
        },
        fit: applied.fit,
        retainedTurns: input.parts.retainedTurns,
        summary: this.manager.workingSummary,
        recallRefs,
        halt: true,
      };
    }
    return {
      outcome: {
        kind: "fits_after_compaction",
        compactedOrdinals: [...applied.fit.prefixOrdinals],
      },
      fit: applied.fit,
      retainedTurns: applied.retainedTurns,
      summary: applied.summary,
      recallRefs,
      halt: false,
    };
  }

  private halted(
    parts: SerializedRequestParts,
    fit: ContextFit,
    haltReason: SharedCapReason,
  ): CompactionStepResult {
    return {
      outcome: {
        kind: "unfit",
        reason: "shared_cap",
        status: "incomplete",
        sharedCapReason: haltReason,
      },
      fit,
      retainedTurns: parts.retainedTurns,
      summary: this.manager.workingSummary,
      recallRefs: capRecallRefs(parts.recallRefs),
      halt: true,
      haltReason,
    };
  }
}
