import { evaluateUncertaintyAwareDeliberation } from "../beh_uncertainty_aware_deliberation_23";

const lowConfidenceEvent = (decision: unknown): Record<string, unknown> => {
  const traceEval = (
    decision as {
      trace_eval?: { events?: Array<Record<string, unknown>> };
    }
  ).trace_eval;

  expect(traceEval).toBeDefined();
  expect(Array.isArray(traceEval?.events)).toBe(true);

  const event = traceEval!.events!.find(
    (candidate) => candidate.type === "low_confidence_control_flow",
  );
  expect(event).toBeDefined();
  return event!;
};

describe("beh_uncertainty_aware_deliberation_23 trace-eval control-flow contract", () => {
  it("records the blocked state-changing action and selected uncertainty-reduction action for a successful low-confidence halt", () => {
    const proposedAction = {
      id: "persist-answer",
      name: "saveFinalAnswer",
      stateChanging: true,
    };

    const decision = evaluateUncertaintyAwareDeliberation({
      calibratedConfidence: 0.49,
      confidenceThreshold: 0.5,
      remainingUncertaintyBudget: 3,
      failedCorrectionAttempts: 1,
      proposedAction,
      preferredUncertaintyReductionAction: "bounded_read_only_evidence_gathering",
    });

    expect(decision.controller_status).toBe("success");
    expect(decision.decision_status).toBe("halted_for_uncertainty");
    expect(decision.may_execute_proposed_action).toBe(false);

    expect(lowConfidenceEvent(decision)).toMatchObject({
      controller_status: "success",
      decision_status: "halted_for_uncertainty",
      blocked_action: proposedAction,
      blocked_forbidden_action: "state_changing_dispatch",
      selected_uncertainty_reduction_action:
        "bounded_read_only_evidence_gathering",
      calibrated_confidence: 0.49,
      confidence_threshold: 0.5,
      remaining_uncertainty_budget: 3,
      failed_correction_attempts: 1,
    });
  });

  it("records structured failure instead of scheduling another correction after two failed correction attempts", () => {
    const proposedAction = {
      id: "publish-without-confidence",
      kind: "final_success_claim",
    };

    const decision = evaluateUncertaintyAwareDeliberation({
      calibratedConfidence: 0.2,
      confidenceThreshold: 0.8,
      remainingUncertaintyBudget: 4,
      failedCorrectionAttempts: 2,
      proposedAction,
      preferredUncertaintyReductionAction: "targeted_correction_attempt",
    });

    expect(decision.controller_status).toBe("failed");
    expect(decision.decision_status).toBe("structured_failure");
    expect(decision.may_execute_proposed_action).toBe(false);
    expect(decision.final_success_claim_allowed).toBe(false);

    expect(lowConfidenceEvent(decision)).toMatchObject({
      controller_status: "failed",
      decision_status: "structured_failure",
      blocked_action: proposedAction,
      blocked_forbidden_action: "final_success_claim",
      selected_uncertainty_reduction_action:
        "structured_failure_user_explanation",
      calibrated_confidence: 0.2,
      confidence_threshold: 0.8,
      remaining_uncertainty_budget: 4,
      failed_correction_attempts: 2,
    });
  });
});
