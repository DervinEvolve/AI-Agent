import {
  ALLOWED_UNCERTAINTY_REDUCTION_ACTIONS,
  evaluateUncertaintyAwareDeliberation,
  updateCorrectionAttemptCounter,
} from "../beh_uncertainty_aware_deliberation_23";

describe("beh_uncertainty_aware_deliberation_23 safety halt semantics", () => {
  it("returns success with halted_for_uncertainty and schedules a permitted uncertainty-reduction action when confidence is low and budget remains", () => {
    const decision = evaluateUncertaintyAwareDeliberation({
      calibratedConfidence: 0.42,
      threshold: 0.8,
      remainingUncertaintyBudget: 1,
      failedCorrectionAttempts: 0,
      proposedAction: { id: "answer", kind: "final_success_claim" },
      preferredUncertaintyReductionAction: "HITL_clarification_request",
    });

    expect(decision.controller_status).toBe("success");
    expect(decision.decision_status).toBe("halted_for_uncertainty");
    expect(decision.may_execute_proposed_action).toBe(false);
    expect(decision.final_success_claim_allowed).toBe(false);
    expect(decision.next_action).toEqual({
      kind: "HITL_clarification_request",
    });
    expect(ALLOWED_UNCERTAINTY_REDUCTION_ACTIONS).toContain(
      decision.next_action?.kind,
    );
  });

  it("blocks forward state-changing, authenticated, irreversible, and final-success execution on the successful safety halt path", () => {
    for (const proposedAction of [
      { id: "write", kind: "state_changing_dispatch" },
      { id: "auth", kind: "authenticated_mutation" },
      { id: "delete", kind: "irreversible_action" },
      { id: "claim", kind: "final_success_claim" },
    ]) {
      const decision = evaluateUncertaintyAwareDeliberation({
        calibrated_confidence: 0.1,
        confidence_threshold: 0.75,
        budget_remaining: 2,
        failed_correction_attempts: 0,
        proposed_action: proposedAction,
      });

      expect(decision.controller_status).toBe("success");
      expect(decision.decision_status).toBe("halted_for_uncertainty");
      expect(decision.proposed_action_blocked).toBe(true);
      expect(decision.may_execute_proposed_action).toBe(false);
      expect(decision.forbidden_next_actions).toContain(proposedAction.kind);
      expect(decision.blocked_forbidden_action).toBe(proposedAction.kind);
      expect(decision.final_success_claim_allowed).toBe(false);
    }
  });

  it("returns structured failure after two failed correction attempts or budget exhaustion, with exhaustion overriding a pending correction action", () => {
    const afterTwoAttempts = evaluateUncertaintyAwareDeliberation({
      calibratedConfidence: 0.2,
      threshold: 0.9,
      remainingUncertaintyBudget: 3,
      failedCorrectionAttempts: 2,
      proposedAction: { id: "commit", kind: "state_changing_dispatch" },
      preferredUncertaintyReductionAction: "targeted_correction_attempt",
    });

    expect(afterTwoAttempts.controller_status).toBe("failed");
    expect(afterTwoAttempts.decision_status).toBe("structured_failure");
    expect(afterTwoAttempts.next_action).toBeNull();
    expect(afterTwoAttempts.required_user_message).toContain(
      "confidence is below the required threshold",
    );

    const exhaustedBudget = evaluateUncertaintyAwareDeliberation({
      calibratedConfidence: 0.2,
      threshold: 0.9,
      remainingUncertaintyBudget: 0,
      failedCorrectionAttempts: 0,
      proposedAction: { id: "fix", kind: "state_changing_dispatch" },
      preferredUncertaintyReductionAction: "targeted_correction_attempt",
    });

    expect(exhaustedBudget.controller_status).toBe("failed");
    expect(exhaustedBudget.decision_status).toBe("structured_failure");
    expect(exhaustedBudget.next_action).toBeNull();
  });

  it("keeps correction attempt counters monotonic across correction retries", () => {
    const firstFailure = updateCorrectionAttemptCounter(0, "failed");
    const secondFailure = updateCorrectionAttemptCounter(firstFailure, "failed");
    const successAfterFailures = updateCorrectionAttemptCounter(
      secondFailure,
      "succeeded",
    );

    expect(firstFailure).toBe(1);
    expect(secondFailure).toBe(2);
    expect(successAfterFailures).toBe(2);
  });

  it("records low-confidence halt and structured-failure events in trace_eval with blocked and selected actions", () => {
    const trace_eval = { events: [] };

    const halted = evaluateUncertaintyAwareDeliberation({
      calibratedConfidence: 0.3,
      threshold: 0.85,
      remainingUncertaintyBudget: 1,
      failedCorrectionAttempts: 0,
      proposedAction: { id: "ship", kind: "authenticated_mutation" },
      preferredUncertaintyReductionAction: "bounded_read_only_evidence_gathering",
      traceEval: trace_eval,
    });

    expect(halted.trace_eval.events).toContainEqual(
      expect.objectContaining({
        controller_status: "success",
        decision_status: "halted_for_uncertainty",
        blocked_forbidden_action: "authenticated_mutation",
        selected_uncertainty_reduction_action:
          "bounded_read_only_evidence_gathering",
      }),
    );

    const failed = evaluateUncertaintyAwareDeliberation({
      calibratedConfidence: 0.3,
      threshold: 0.85,
      remainingUncertaintyBudget: 0,
      failedCorrectionAttempts: 0,
      proposedAction: { id: "claim", kind: "final_success_claim" },
      traceEval: trace_eval,
    });

    expect(failed.trace_eval.events).toContainEqual(
      expect.objectContaining({
        controller_status: "failed",
        decision_status: "structured_failure",
        blocked_forbidden_action: "final_success_claim",
        selected_uncertainty_reduction_action:
          "structured_failure_user_explanation",
      }),
    );
    expect(failed.trace_eval.events).toHaveLength(2);
  });
});
