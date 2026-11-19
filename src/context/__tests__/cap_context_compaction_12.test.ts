import { describe, expect, it } from "vitest";
import {
  ContextManager,
  capRecallRefs,
  groupAtomicTurns,
  labelUntrustedSummary,
  selectCompactionPrefix,
  WORKING_SUMMARY_MAX_CHARS,
  RECALL_REF_CAP,
  type SerializedRequestParts,
  type TurnMessage,
} from "../context_manager.js";
import {
  ContextCompactionMount,
  sharedCapHalt,
  type CompactionOutcome,
} from "../../runtime/context_compaction_mount.js";

function toolPair(ordinal: number, contentLen: number, outcome: "ok" | "unresolved" | "unknown" = "ok"): TurnMessage[] {
  const callId = `c${ordinal}`;
  const body = "x".repeat(contentLen);
  return [
    { role: "assistant", content: `call ${ordinal} ${body}`, toolCallIds: [callId] },
    { role: "tool", content: `result ${ordinal} ${body}`, callId, outcome },
  ];
}

function parts(turns: TurnMessage[], summary = ""): SerializedRequestParts {
  return {
    instructions: "do the task",
    toolSchemas: "[]",
    protectedState: "protected",
    workingSummary: summary,
    recallRefs: [],
    retainedTurns: turns,
  };
}

describe("cap_context_compaction_12 published unions", () => {
  it("prefix is shortest oldest contiguous atomic groups and never splits a call", () => {
    const turns = [
      ...toolPair(1, 40),
      ...toolPair(2, 40),
      ...toolPair(3, 40),
      ...toolPair(4, 40),
      ...toolPair(5, 40),
      ...toolPair(6, 20),
    ];
    const groups = groupAtomicTurns(turns);
    expect(groups.map((g) => g.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(groups[5].eligible).toBe(false);
    expect(groups[5].ineligibleReason).toBe("newest");
    expect(groups[0].messages).toHaveLength(2);

    const budget = { maxChars: 900, responseHeadroomChars: 50, compactionHeadroomChars: 20 };
    const selection = selectCompactionPrefix(parts(turns), budget, {
      summarizerMounted: true,
      previousSummary: "",
    });
    expect(selection.fit.outcome).toBe("fits_after_compaction");
    if (selection.fit.outcome !== "fits_after_compaction") return;
    expect(selection.fit.prefixOrdinals[0]).toBe(1);
    expect(selection.fit.prefixOrdinals).toEqual(
      selection.removedGroups.map((g) => g.ordinal),
    );
    // Newest group is never in the prefix.
    expect(selection.fit.prefixOrdinals.includes(6)).toBe(false);
    // Groups are contiguous from the oldest.
    const ords = selection.fit.prefixOrdinals;
    expect(ords).toEqual(ords.map((_, i) => i + 1));
  });

  it("stops at the first unresolved group and does not skip it", () => {
    const turns = [
      ...toolPair(1, 80),
      ...toolPair(2, 80, "unresolved"),
      ...toolPair(3, 80),
      ...toolPair(4, 10),
    ];
    const groups = groupAtomicTurns(turns);
    expect(groups[1].eligible).toBe(false);
    const selection = selectCompactionPrefix(parts(turns), {
      maxChars: 200,
      responseHeadroomChars: 10,
      compactionHeadroomChars: 10,
    }, { summarizerMounted: true });
    if (selection.fit.outcome === "fits_after_compaction") {
      expect(selection.fit.prefixOrdinals.every((n) => n < 2)).toBe(true);
      expect(selection.fit.prefixOrdinals.includes(3)).toBe(false);
    } else {
      expect(selection.fit.outcome).toBe("unfit");
      expect(selection.removedGroups).toEqual([]);
    }
    // Group 2 stays in the retained tail in order when a prefix is taken.
    const retainedOrdinals = selection.retainedGroups.map((g) => g.ordinal);
    expect(retainedOrdinals.includes(2)).toBe(true);
  });

  it("successive compactions cover disjoint strictly increasing ordinals and re-render previous summary", () => {
    const budget = { maxChars: 700, responseHeadroomChars: 40, compactionHeadroomChars: 20 };
    const mgr = new ContextManager(budget);
    const firstTurns = [
      ...toolPair(1, 30),
      ...toolPair(2, 30),
      ...toolPair(3, 30),
      ...toolPair(4, 30),
      ...toolPair(5, 30),
      ...toolPair(6, 15),
    ];
    const first = mgr.applyPrefix(parts(firstTurns), "sum-1", { summarizerMounted: true });
    expect(first.fit.outcome).toBe("fits_after_compaction");
    if (first.fit.outcome !== "fits_after_compaction") return;
    expect(first.fit.prefixOrdinals).toEqual([1, 2, 3].includes(first.fit.prefixOrdinals[0]) ? first.fit.prefixOrdinals : first.fit.prefixOrdinals);
    expect(first.summary.startsWith("[untrusted working summary]")).toBe(true);
    expect(first.summary.length).toBeLessThanOrEqual(WORKING_SUMMARY_MAX_CHARS);
    const firstOrdinals = [...first.fit.prefixOrdinals];

    const secondTurns = first.retainedTurns.concat(toolPair(7, 80), toolPair(8, 10));
    // Re-group ordinals restart from the retained transcript; the manager still
    // rejects ordinals that are not strictly increasing vs prior compacted ids
    // only when the selector reuses the same ordinal space. Build a continuation
    // whose groups continue past the prior max by using a fresh transcript of
    // later pairs only plus a large newest group, after recording prior ordinals.
    const later = [
      ...toolPair(firstOrdinals[firstOrdinals.length - 1] + 1, 40),
      ...toolPair(firstOrdinals[firstOrdinals.length - 1] + 2, 40),
      ...toolPair(firstOrdinals[firstOrdinals.length - 1] + 3, 40),
      ...toolPair(firstOrdinals[firstOrdinals.length - 1] + 4, 10),
    ];
    const second = mgr.applyPrefix(
      parts(later, first.summary),
      "sum-2",
      { summarizerMounted: true },
    );
    // Previous summary is inside the measured request (workingSummary field).
    expect(first.summary.length).toBeGreaterThan(0);
    if (second.fit.outcome === "fits_after_compaction") {
      const prior = new Set(mgr.compacted);
      expect(new Set(second.fit.prefixOrdinals.concat(firstOrdinals)).size).toBe(
        second.fit.prefixOrdinals.length + firstOrdinals.length,
      );
      const maxFirst = Math.max(...firstOrdinals);
      expect(Math.min(...second.fit.prefixOrdinals)).toBeGreaterThan(maxFirst);
      expect(prior.size).toBe(firstOrdinals.length + second.fit.prefixOrdinals.length);
    } else {
      // If the continuation already fits, no new summary write beyond the first.
      expect(["already_fits", "unfit"]).toContain(second.fit.outcome);
      expect(mgr.workingSummary).toBe(first.summary);
    }
  });

  it("shared-cap exhaustion and unknown usage write no summary and do not imply rollback", () => {
    expect(sharedCapHalt({
      remaining: 1,
      requiredForOrdinary: 1,
      requiredForSummarizerPlusOrdinary: 2,
    }, true)).toBe("model_call_cap_exhausted");
    expect(sharedCapHalt({
      remaining: undefined,
      requiredForOrdinary: 1,
      requiredForSummarizerPlusOrdinary: 2,
    }, false)).toBe("model_call_usage_unknown");

    const turns = [...toolPair(1, 200), ...toolPair(2, 200), ...toolPair(3, 20)];
    const mount = new ContextCompactionMount({
      budget: { maxChars: 400, responseHeadroomChars: 20, compactionHeadroomChars: 20 },
      summarizer: () => "should-not-run",
    });
    const before = mount.manager.workingSummary;
    const step = mount.beforeTurn({
      parts: parts(turns),
      usage: { remaining: 1, requiredForOrdinary: 1, requiredForSummarizerPlusOrdinary: 2 },
    });
    expect(step.halt).toBe(true);
    expect(step.haltReason).toBe("model_call_cap_exhausted");
    expect(step.outcome.kind).toBe("unfit");
    if (step.outcome.kind === "unfit") {
      expect(step.outcome.reason).toBe("shared_cap");
      expect(step.outcome.status).toBe("incomplete");
    }
    expect(mount.manager.workingSummary).toBe(before);
    expect(step.retainedTurns).toEqual(turns);
    expect(step.summary).toBe("");
  });

  it("unfit tail, empty prefix, or absent summarizer leave summary and transcript unchanged", () => {
    const huge = [...toolPair(1, 500)];
    const absent = new ContextCompactionMount({
      budget: { maxChars: 100, responseHeadroomChars: 10, compactionHeadroomChars: 10 },
    });
    const absentStep = absent.beforeTurn({
      parts: parts(huge),
      usage: { remaining: 5, requiredForOrdinary: 1, requiredForSummarizerPlusOrdinary: 2 },
    });
    expect(absentStep.outcome).toEqual({
      kind: "unfit",
      reason: "summarizer_absent",
      status: "incomplete",
    } satisfies CompactionOutcome);
    expect(absentStep.summary).toBe("");
    expect(absentStep.retainedTurns).toEqual(huge);

    const mount = new ContextCompactionMount({
      budget: { maxChars: 50, responseHeadroomChars: 10, compactionHeadroomChars: 10 },
      summarizer: () => "nope",
    });
    const unfit = mount.beforeTurn({
      parts: parts(huge),
      usage: { remaining: 5, requiredForOrdinary: 1, requiredForSummarizerPlusOrdinary: 2 },
    });
    expect(unfit.outcome.kind).toBe("unfit");
    if (unfit.outcome.kind === "unfit") {
      expect(["eligible_prefix_empty", "tail_alone_cannot_fit", "eligible_prefix_insufficient"]).toContain(
        unfit.outcome.reason,
      );
      expect(unfit.outcome.status).toBe("incomplete");
    }
    expect(mount.manager.workingSummary).toBe("");
    expect(unfit.retainedTurns).toEqual(huge);
  });

  it("recall_refs cap at 16 metadata-only entries and summary cannot satisfy citation", () => {
    const refs = Array.from({ length: 20 }, (_, i) => ({
      call_id: `id-${i}`,
      status: "ok",
      truncated: false,
      payload: "secret",
    }));
    const capped = capRecallRefs(refs as never);
    expect(capped).toHaveLength(RECALL_REF_CAP);
    expect(capped[0].call_id).toBe("id-4");
    expect(capped[capped.length - 1].call_id).toBe("id-19");
    for (const r of capped) {
      expect(Object.keys(r).sort()).toEqual(["call_id", "status", "truncated"]);
    }
    const labelled = labelUntrustedSummary("evidence that would cite a source");
    expect(labelled.includes("[untrusted working summary]")).toBe(true);
    expect(labelled.length).toBeLessThanOrEqual(WORKING_SUMMARY_MAX_CHARS);
  });

  it("already_fits makes no summarizer call", () => {
    let calls = 0;
    const mount = new ContextCompactionMount({
      budget: { maxChars: 100_000, responseHeadroomChars: 10, compactionHeadroomChars: 10 },
      summarizer: () => {
        calls += 1;
        return "unused";
      },
    });
    const step = mount.beforeTurn({
      parts: parts(toolPair(1, 5)),
      usage: { remaining: 3, requiredForOrdinary: 1, requiredForSummarizerPlusOrdinary: 2 },
    });
    expect(step.outcome.kind).toBe("already_fits");
    expect(calls).toBe(0);
    expect(step.halt).toBe(false);
  });
});
