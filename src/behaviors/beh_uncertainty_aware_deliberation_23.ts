export const ALLOWED_UNCERTAINTY_REDUCTION_ACTIONS = [
  "bounded_read_only_evidence_gathering",
  "HITL_clarification_request",
  "targeted_correction_attempt",
] as const;

export const FORBIDDEN_LOW_CONFIDENCE_FORWARD_ACTIONS = [
  "state_changing_dispatch",
  "authenticated_mutation",
  "irreversible_action",
  "final_success_claim",
] as const;

export type AllowedUncertaintyReductionAction =
  (typeof ALLOWED_UNCERTAINTY_REDUCTION_ACTIONS)[number];
export type ForbiddenLowConfidenceForwardAction =
  (typeof FORBIDDEN_LOW_CONFIDENCE_FORWARD_ACTIONS)[number];
export type ControllerStatus = "success" | "failed";
export type DecisionStatus =
  | "halted_for_uncertainty"
  | "structured_failure"
  | "proceeded";

export interface DeliberationAction {
  id?: string;
  name?: string;
  kind?: string;
  type?: string;
  stateChanging?: boolean;
  state_changing?: boolean;
  authenticated?: boolean;
  irreversible?: boolean;
  finalSuccessClaim?: boolean;
  final_success_claim?: boolean;
}

export interface TraceEvalEvent {
  type: "low_confidence_control_flow";
  controller_status: ControllerStatus;
  decision_status: DecisionStatus;
  blocked_action: DeliberationAction | null;
  blocked_forbidden_action: ForbiddenLowConfidenceForwardAction | null;
  selected_uncertainty_reduction_action:
    | AllowedUncertaintyReductionAction
    | "structured_failure_user_explanation";
  calibrated_confidence: number;
  confidence_threshold: number;
  remaining_uncertainty_budget: number;
  failed_correction_attempts: number;
  reason: string;
}

export interface TraceEval {
  events: TraceEvalEvent[];
}

export interface EvaluateUncertaintyAwareDeliberationInput {
  calibratedConfidence?: number;
  calibrated_confidence?: number;
  confidenceThreshold?: number;
  confidence_threshold?: number;
  threshold?: number;
  remainingUncertaintyBudget?: number;
  remaining_uncertainty_budget?: number;
  remainingBudget?: number;
  budget_remaining?: number;
  failedCorrectionAttempts?: number;
  failed_correction_attempts?: number;
  proposedAction?: DeliberationAction;
  proposed_action?: DeliberationAction;
  preferredUncertaintyReductionAction?: AllowedUncertaintyReductionAction | string;
  preferred_uncertainty_reduction_action?: AllowedUncertaintyReductionAction | string;
  traceEval?: TraceEval;
  trace_eval?: TraceEval;
}

export interface UncertaintyControlDecision {
  controller_status: ControllerStatus;
  decision_status: DecisionStatus;
  may_execute_proposed_action: boolean;
  proposed_action_blocked: boolean;
  blocked_action: DeliberationAction | null;
  blocked_forbidden_action: ForbiddenLowConfidenceForwardAction | null;
  next_action: { kind: AllowedUncertaintyReductionAction } | null;
  allowed_next_actions: readonly AllowedUncertaintyReductionAction[];
  forbidden_next_actions: readonly ForbiddenLowConfidenceForwardAction[];
  final_success_claim_allowed: boolean;
  failed_correction_attempts: number;
  required_user_message?: string;
  trace_eval: TraceEval;
}

export const UNCERTAINTY_AWARE_DELIBERATION_CONTROL_FLOW_CONTRACT = {
  below_threshold_with_budget: {
    controller_status: "success",
    decision_status: "halted_for_uncertainty",
    allowed_next_actions: ALLOWED_UNCERTAINTY_REDUCTION_ACTIONS,
    forbidden_next_actions: FORBIDDEN_LOW_CONFIDENCE_FORWARD_ACTIONS,
  },
  below_threshold_without_budget_or_after_two_attempts: {
    controller_status: "failed",
    decision_status: "structured_failure",
    required_user_message:
      "plain-language uncertainty explanation and unmet criteria",
  },
} as const;

export const beh_uncertainty_aware_deliberation_23 = {
  id: "beh_uncertainty_aware_deliberation_23",
  implementation: {
    id: "beh_uncertainty_halt_success_semantics_24",
    modifies: "beh_uncertainty_aware_deliberation_23",
    description:
      "Clarify low-confidence control-flow semantics: successfully halting unsafe forward execution and launching a bounded uncertainty-reduction path is a successful safety behavior, not a failed task outcome.",
    implementation_patch: {
      control_flow_contract:
        UNCERTAINTY_AWARE_DELIBERATION_CONTROL_FLOW_CONTRACT,
    },
  },
} as const;

const allowedActionSet: ReadonlySet<string> = new Set(
  ALLOWED_UNCERTAINTY_REDUCTION_ACTIONS,
);

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegativeInteger(value: number | undefined): number {
  return Math.max(0, Math.floor(finiteNumber(value, 0)));
}

function confidenceFrom(input: EvaluateUncertaintyAwareDeliberationInput): number {
  return finiteNumber(
    input.calibratedConfidence ?? input.calibrated_confidence,
    0,
  );
}

function thresholdFrom(input: EvaluateUncertaintyAwareDeliberationInput): number {
  return finiteNumber(
    input.confidenceThreshold ?? input.confidence_threshold ?? input.threshold,
    1,
  );
}

function remainingBudgetFrom(
  input: EvaluateUncertaintyAwareDeliberationInput,
): number {
  return finiteNumber(
    input.remainingUncertaintyBudget ??
      input.remaining_uncertainty_budget ??
      input.remainingBudget ??
      input.budget_remaining,
    0,
  );
}

function failedAttemptsFrom(
  input: EvaluateUncertaintyAwareDeliberationInput,
): number {
  return nonNegativeInteger(
    input.failedCorrectionAttempts ?? input.failed_correction_attempts,
  );
}

function actionKind(action: DeliberationAction | undefined): string | undefined {
  return action?.kind ?? action?.type;
}

export function forbiddenLowConfidenceActionFor(
  action: DeliberationAction | undefined,
): ForbiddenLowConfidenceForwardAction | null {
  const kind = actionKind(action);

  if (
    action?.finalSuccessClaim === true ||
    action?.final_success_claim === true ||
    kind === "final_success_claim"
  ) {
    return "final_success_claim";
  }

  if (action?.irreversible === true || kind === "irreversible_action") {
    return "irreversible_action";
  }

  if (action?.authenticated === true || kind === "authenticated_mutation") {
    return "authenticated_mutation";
  }

  if (
    action?.stateChanging === true ||
    action?.state_changing === true ||
    kind === "state_changing_dispatch"
  ) {
    return "state_changing_dispatch";
  }

  return null;
}

function selectUncertaintyReductionAction(
  preferred: AllowedUncertaintyReductionAction | string | undefined,
): AllowedUncertaintyReductionAction {
  if (preferred && allowedActionSet.has(preferred)) {
    return preferred as AllowedUncertaintyReductionAction;
  }

  return "bounded_read_only_evidence_gathering";
}

function traceContainerFrom(
  input: EvaluateUncertaintyAwareDeliberationInput,
): TraceEval {
  return input.traceEval ?? input.trace_eval ?? { events: [] };
}

function appendTraceEvent(
  trace_eval: TraceEval,
  event: TraceEvalEvent,
): void {
  trace_eval.events.push(event);
}

export function updateCorrectionAttemptCounter(
  previousFailedAttempts: number,
  correctionOutcome: "failed" | "succeeded" | "not_attempted",
): number {
  const previous = nonNegativeInteger(previousFailedAttempts);
  return correctionOutcome === "failed" ? previous + 1 : previous;
}

export function evaluateUncertaintyAwareDeliberation(
  input: EvaluateUncertaintyAwareDeliberationInput,
): UncertaintyControlDecision {
  const calibratedConfidence = confidenceFrom(input);
  const confidenceThreshold = thresholdFrom(input);
  const remainingBudget = remainingBudgetFrom(input);
  const failedCorrectionAttempts = failedAttemptsFrom(input);
  const proposedAction = input.proposedAction ?? input.proposed_action ?? null;
  const trace_eval = traceContainerFrom(input);

  if (calibratedConfidence >= confidenceThreshold) {
    return {
      controller_status: "success",
      decision_status: "proceeded",
      may_execute_proposed_action: true,
      proposed_action_blocked: false,
      blocked_action: null,
      blocked_forbidden_action: null,
      next_action: null,
      allowed_next_actions: ALLOWED_UNCERTAINTY_REDUCTION_ACTIONS,
      forbidden_next_actions: FORBIDDEN_LOW_CONFIDENCE_FORWARD_ACTIONS,
      final_success_claim_allowed: true,
      failed_correction_attempts: failedCorrectionAttempts,
      trace_eval,
    };
  }

  const blockedForbiddenAction = forbiddenLowConfidenceActionFor(
    proposedAction ?? undefined,
  );
  const attemptsExhausted = failedCorrectionAttempts >= 2;
  const budgetExhausted = remainingBudget <= 0;
  const blockedAction = proposedAction ? { ...proposedAction } : null;

  if (budgetExhausted || attemptsExhausted) {
    const decision: UncertaintyControlDecision = {
      controller_status: "failed",
      decision_status: "structured_failure",
      may_execute_proposed_action: false,
      proposed_action_blocked: true,
      blocked_action: blockedAction,
      blocked_forbidden_action: blockedForbiddenAction,
      next_action: null,
      allowed_next_actions: ALLOWED_UNCERTAINTY_REDUCTION_ACTIONS,
      forbidden_next_actions: FORBIDDEN_LOW_CONFIDENCE_FORWARD_ACTIONS,
      final_success_claim_allowed: false,
      failed_correction_attempts: failedCorrectionAttempts,
      required_user_message:
        "I cannot safely continue because confidence is below the required threshold and the bounded uncertainty-reduction path is exhausted; the unmet criteria should be explained in plain language.",
      trace_eval,
    };

    appendTraceEvent(trace_eval, {
      type: "low_confidence_control_flow",
      controller_status: decision.controller_status,
      decision_status: decision.decision_status,
      blocked_action: blockedAction,
      blocked_forbidden_action: blockedForbiddenAction,
      selected_uncertainty_reduction_action:
        "structured_failure_user_explanation",
      calibrated_confidence: calibratedConfidence,
      confidence_threshold: confidenceThreshold,
      remaining_uncertainty_budget: remainingBudget,
      failed_correction_attempts: failedCorrectionAttempts,
      reason: budgetExhausted
        ? "uncertainty_budget_exhausted"
        : "correction_attempt_limit_reached",
    });

    return decision;
  }

  const selectedAction = selectUncertaintyReductionAction(
    input.preferredUncertaintyReductionAction ??
      input.preferred_uncertainty_reduction_action,
  );

  const decision: UncertaintyControlDecision = {
    controller_status: "success",
    decision_status: "halted_for_uncertainty",
    may_execute_proposed_action: false,
    proposed_action_blocked: true,
    blocked_action: blockedAction,
    blocked_forbidden_action: blockedForbiddenAction,
    next_action: { kind: selectedAction },
    allowed_next_actions: ALLOWED_UNCERTAINTY_REDUCTION_ACTIONS,
    forbidden_next_actions: FORBIDDEN_LOW_CONFIDENCE_FORWARD_ACTIONS,
    final_success_claim_allowed: false,
    failed_correction_attempts: failedCorrectionAttempts,
    trace_eval,
  };

  appendTraceEvent(trace_eval, {
    type: "low_confidence_control_flow",
    controller_status: decision.controller_status,
    decision_status: decision.decision_status,
    blocked_action: blockedAction,
    blocked_forbidden_action: blockedForbiddenAction,
    selected_uncertainty_reduction_action: selectedAction,
    calibrated_confidence: calibratedConfidence,
    confidence_threshold: confidenceThreshold,
    remaining_uncertainty_budget: remainingBudget,
    failed_correction_attempts: failedCorrectionAttempts,
    reason: "below_confidence_threshold_with_budget_remaining",
  });

  return decision;
}

export const decideUncertaintyControlFlow =
  evaluateUncertaintyAwareDeliberation;
export const runUncertaintyAwareDeliberationController =
  evaluateUncertaintyAwareDeliberation;
