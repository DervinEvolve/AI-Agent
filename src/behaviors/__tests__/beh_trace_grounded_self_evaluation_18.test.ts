import { describe, expect, it } from "vitest";
import { behaviors } from "../behaviors";
import {
  beh_trace_grounded_self_evaluation_18,
  evaluateTrace,
  finalizeWithTraceReview,
  reviewMissionMilestone,
  reviewSkillDistillation,
  type TraceEvent,
} from "../beh_trace_grounded_self_evaluation_18";

describe("beh_trace_grounded_self_evaluation_18", () => {
  it("is registered as an active behavior", () => {
    expect(behaviors.some((behavior) => behavior.id === beh_trace_grounded_self_evaluation_18.id)).toBe(true);
    expect(beh_trace_grounded_self_evaluation_18.status).toBe("active");
  });

  it("controller finalization for a nontrivial task calls evaluate_trace before returning success", () => {
    const result = finalizeWithTraceReview({
      nontrivial: true,
      finalAnswer: "done",
      criteria: [{ id: "criterion.answer_checked", description: "answer was checked" }],
      trace: [
        {
          id: "evt.check.1",
          type: "tool_call",
          criterionRefs: ["criterion.answer_checked"],
          trusted: true,
        },
      ],
      budgetRemaining: 0,
    });

    expect(result.status).toBe("success");
    expect(result.traceEvaluation.behavior_id).toBe(beh_trace_grounded_self_evaluation_18.id);
    expect(result.traceEvaluation.status).toBe("passed");
    expect(result.traceEvaluation.event_refs["criterion.answer_checked"]).toEqual(["evt.check.1"]);
  });

  it("downgrades a final answer with no trace evidence for a required criterion", () => {
    const result = finalizeWithTraceReview({
      nontrivial: true,
      finalAnswer: "claim without evidence",
      criteria: [{ id: "criterion.required_fact", description: "required fact is established" }],
      trace: [],
      budgetRemaining: 0,
    });

    expect(result.status).toBe("structured_failure");
    expect(result.failure_behavior_id).toBe("beh_structured_failure_2");
    expect(result.traceEvaluation.status).toBe("uncertain");
    expect(result.traceEvaluation.unsupported[0]).toContain("no supporting trace evidence");
  });

  it("cites event_refs for every passed criterion", () => {
    const evaluation = evaluateTrace({
      criteria: [
        { id: "criterion.plan", description: "plan was made" },
        { id: "criterion.verify", description: "verification was run" },
      ],
      trace: [
        { id: "evt.plan", type: "planning", criterionRefs: ["criterion.plan"] },
        { id: "evt.verify", type: "tool_call", criterionRefs: ["criterion.verify"] },
      ],
    });

    expect(evaluation.status).toBe("passed");
    for (const criterion of evaluation.criteria) {
      expect(criterion.status).toBe("passed");
      expect(criterion.event_refs.length).toBeGreaterThan(0);
      expect(evaluation.event_refs[criterion.criterion_id]).toEqual(criterion.event_refs);
    }
  });

  it("preserves taint on tainted evidence and does not treat an evaluator score as trusted authorization", () => {
    const evaluation = evaluateTrace({
      criteria: [{ id: "criterion.web_fact", description: "web fact was retrieved" }],
      trace: [
        {
          id: "evt.search.1",
          type: "browser_observation",
          criterionRefs: ["criterion.web_fact"],
          taint: [{ source: "external_web", reason: "untrusted page content" }],
        },
        {
          id: "evt.eval.1",
          type: "evaluator_score",
          policyRefs: ["policy.authorization"],
          trusted: true,
          status: "passed",
        },
      ],
      policyConstraints: [
        {
          id: "policy.authorization",
          requiresTrustedEvent: true,
          trustedEventTypes: ["policy_authorization"],
        },
      ],
    });

    expect(evaluation.status).toBe("failed");
    expect(evaluation.taint).toContainEqual({
      event_ref: "evt.search.1",
      source: "external_web",
      reason: "untrusted page content",
    });
    expect(evaluation.criteria[0].taint_dependent).toBe(true);
    expect(evaluation.policy[0].unsupported).toContain("evaluator scores are not authorization");
  });

  it("skill distillation requires a passed trace evaluation in addition to beh_criteria_reflection_2 success reflection", () => {
    const passedTrace = evaluateTrace({
      criteria: [{ id: "criterion.demo", description: "skill demonstration succeeded" }],
      trace: [{ id: "evt.demo", type: "tool_call", criterionRefs: ["criterion.demo"] }],
    });
    const uncertainTrace = evaluateTrace({
      criteria: [{ id: "criterion.demo", description: "skill demonstration succeeded" }],
      trace: [],
    });

    expect(reviewSkillDistillation({ traceEvaluation: passedTrace, reflection: { status: "passed" } })).toMatchObject({
      status: "approved",
      advisory: false,
      existingSkillPathwaysRequired: true,
    });
    expect(reviewSkillDistillation({ traceEvaluation: uncertainTrace, reflection: { status: "passed" } })).toMatchObject({
      status: "advisory",
      advisory: true,
      existingSkillPathwaysRequired: true,
    });
  });

  it("mission milestone completion can reference trace evaluation but still uses mission_control criteria and taint validation", () => {
    const traceEvaluation = evaluateTrace({
      criteria: [{ id: "criterion.milestone", description: "milestone artifact created" }],
      trace: [{ id: "evt.artifact", type: "artifact_write", criterionRefs: ["criterion.milestone"] }],
    });

    expect(
      reviewMissionMilestone({ traceEvaluation, missionCriteriaPassed: false, taintValid: true }),
    ).toMatchObject({ canComplete: false, usesMissionControlCriteria: true, taintValidated: true });
    expect(
      reviewMissionMilestone({ traceEvaluation, missionCriteriaPassed: true, taintValid: false }),
    ).toMatchObject({ canComplete: false, usesMissionControlCriteria: true, taintValidated: false });
    expect(
      reviewMissionMilestone({ traceEvaluation, missionCriteriaPassed: true, taintValid: true }),
    ).toMatchObject({ canComplete: true, usesMissionControlCriteria: true, taintValidated: true });
  });

  it("performs a targeted correction loop when trace evaluation fails and budget remains", () => {
    const correctionEvent: TraceEvent = {
      id: "evt.correction.verify",
      type: "tool_call",
      criterionRefs: ["criterion.verify"],
      trusted: true,
    };
    let correctionCalled = false;

    const result = finalizeWithTraceReview({
      nontrivial: true,
      finalAnswer: "verified after correction",
      criteria: [{ id: "criterion.verify", description: "verification was run" }],
      trace: [],
      budgetRemaining: 1,
      correction: (evaluation) => {
        correctionCalled = true;
        expect(evaluation.status).toBe("uncertain");
        return [correctionEvent];
      },
    });

    expect(correctionCalled).toBe(true);
    expect(result.status).toBe("success");
    expect(result.correctionAttempted).toBe(true);
    expect(result.traceEvaluation.status).toBe("passed");
    expect(result.traceEvaluation.event_refs["criterion.verify"]).toEqual(["evt.correction.verify"]);
  });

  it("returns beh_structured_failure_2 when trace evaluation fails and budget is exhausted", () => {
    const result = finalizeWithTraceReview({
      nontrivial: true,
      finalAnswer: "premature completion",
      criteria: [{ id: "criterion.required", description: "required work was completed" }],
      trace: [{ id: "evt.failed", type: "tool_call", criterionRefs: ["criterion.required"], status: "failed" }],
      budgetRemaining: 0,
    });

    expect(result.status).toBe("structured_failure");
    expect(result.failure_behavior_id).toBe("beh_structured_failure_2");
    expect(result.traceEvaluation.status).toBe("failed");
    expect(result.correctionAttempted).toBe(false);
  });
});
