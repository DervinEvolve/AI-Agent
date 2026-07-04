export type TraceReviewStatus = "passed" | "failed" | "uncertain";

export type TraceTaint = string | {
  source: string;
  reason?: string;
};

export interface TraceEvent {
  id: string;
  type: string;
  summary?: string;
  claims?: string[];
  criterionRefs?: string[];
  evidence_for?: string[];
  policyRefs?: string[];
  status?: string;
  trusted?: boolean;
  taint?: TraceTaint[];
  metadata?: Record<string, unknown>;
}

export interface SuccessCriterion {
  id: string;
  description: string;
  required?: boolean;
  evidenceRefs?: string[];
  requiredEventTypes?: string[];
  allowTaintedEvidence?: boolean;
}

export interface PolicyConstraint {
  id: string;
  description?: string;
  required?: boolean;
  requiresTrustedEvent?: boolean;
  trustedEventTypes?: string[];
  disallowedTaintSources?: string[];
  failOnViolation?: boolean;
}

export interface TraceEvaluationInput {
  criteria: SuccessCriterion[];
  trace: TraceEvent[];
  policyConstraints?: PolicyConstraint[];
}

export interface CriterionTraceReview {
  criterion_id: string;
  status: TraceReviewStatus;
  event_refs: string[];
  unsupported?: string;
  taint: NormalizedTaint[];
  taint_dependent: boolean;
}

export interface NormalizedTaint {
  event_ref: string;
  source: string;
  reason?: string;
}

export interface PolicyTraceReview {
  policy_id: string;
  status: TraceReviewStatus;
  event_refs: string[];
  unsupported?: string;
  taint: NormalizedTaint[];
}

export interface TraceEvaluationResult {
  behavior_id: typeof beh_trace_grounded_self_evaluation_18.id;
  status: TraceReviewStatus;
  event_refs: Record<string, string[]>;
  criteria: CriterionTraceReview[];
  policy: PolicyTraceReview[];
  unsupported: string[];
  taint: NormalizedTaint[];
}

const EVALUATOR_EVENT_TYPE = /(evaluator|evaluation|self[_-]?evaluation|reflection|score|review)/i;
const FAILURE_STATUS = new Set(["failed", "failure", "error", "denied", "violation", "unsafe"]);
const DEFAULT_TRUSTED_POLICY_EVENT_TYPES = ["policy_authorization", "guardrail_pass", "policy_gate_pass"];

export const beh_trace_grounded_self_evaluation_18 = {
  id: "beh_trace_grounded_self_evaluation_18",
  name: "Trace-grounded trajectory review before success or learning",
  status: "active",
  description:
    "For nontrivial tasks, before declaring success, storing a lesson, promoting a skill, resuming a mission, or reporting completion of a long-horizon milestone, the agent should review the structured trajectory trace against the task's explicit success criteria and relevant policy constraints. The review must cite trace evidence for each satisfied criterion, flag unsupported or taint-dependent claims, and return passed, failed, or uncertain. If failed or uncertain and budget remains, the controller should perform a targeted correction loop; if correction is impossible, it must return structured failure rather than a confident answer. Trace-derived lessons and skill updates are advisory until separately approved and verified through the existing memory and skill-library pathways.",
  implementation: {
    tests: [
      "controller finalization for a nontrivial task calls evaluate_trace before returning success",
      "a final answer with no trace evidence for a required criterion is downgraded to uncertain or failed",
      "trace review cites event_refs for every passed criterion",
      "trace review preserves taint on tainted evidence and does not treat an evaluator score as trusted authorization",
      "skill distillation requires a passed trace evaluation in addition to beh_criteria_reflection_2 success reflection",
      "mission milestone completion can reference trace evaluation but still uses mission_control's criteria path and taint validation",
      "if trace evaluation fails and budget remains, controller performs a targeted correction loop",
      "if trace evaluation fails and budget is exhausted, controller returns beh_structured_failure_2",
    ],
  },
} as const;

function isEvaluatorEvent(event: TraceEvent): boolean {
  return EVALUATOR_EVENT_TYPE.test(event.type);
}

function hasFailureStatus(event: TraceEvent): boolean {
  return typeof event.status === "string" && FAILURE_STATUS.has(event.status.toLowerCase());
}

function normalizeEventTaint(event: TraceEvent): NormalizedTaint[] {
  const explicit = event.taint ?? [];
  const normalized = explicit.map((entry) => {
    if (typeof entry === "string") {
      return { event_ref: event.id, source: entry };
    }
    return { event_ref: event.id, source: entry.source, reason: entry.reason };
  });

  if (event.trusted === false) {
    normalized.push({
      event_ref: event.id,
      source: "untrusted_trace_event",
      reason: "Trace event was explicitly marked untrusted.",
    });
  }

  return normalized;
}

function criterionReferences(event: TraceEvent, criterion: SuccessCriterion): boolean {
  const refs = new Set([...(event.criterionRefs ?? []), ...(event.evidence_for ?? [])]);
  if (refs.has(criterion.id)) return true;
  if (criterion.evidenceRefs?.includes(event.id)) return true;
  if (event.claims?.includes(criterion.id)) return true;
  return false;
}

function policyReferences(event: TraceEvent, policy: PolicyConstraint): boolean {
  return Boolean(event.policyRefs?.includes(policy.id));
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function mergeTaint(values: NormalizedTaint[]): NormalizedTaint[] {
  const seen = new Set<string>();
  const out: NormalizedTaint[] = [];
  for (const taint of values) {
    const key = `${taint.event_ref}\u0000${taint.source}\u0000${taint.reason ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(taint);
    }
  }
  return out;
}

export function evaluateTrace(input: TraceEvaluationInput): TraceEvaluationResult {
  const criteria = input.criteria ?? [];
  const trace = input.trace ?? [];
  const policies = input.policyConstraints ?? [];
  const eventRefs: Record<string, string[]> = {};
  const unsupported: string[] = [];
  let hasHardFailure = false;
  let hasUncertainty = false;

  const criterionReviews: CriterionTraceReview[] = criteria.map((criterion) => {
    const required = criterion.required !== false;
    const explicitCandidates = trace.filter((event) => criterionReferences(event, criterion));
    const primaryCandidates = explicitCandidates.filter((event) => !isEvaluatorEvent(event));
    const failingCandidates = primaryCandidates.filter(hasFailureStatus);
    const missingRequiredTypes = (criterion.requiredEventTypes ?? []).filter(
      (requiredType) => !primaryCandidates.some((event) => event.type === requiredType),
    );
    const taint = mergeTaint(primaryCandidates.flatMap(normalizeEventTaint));
    const refs = unique(primaryCandidates.map((event) => event.id));
    eventRefs[criterion.id] = refs;

    if (!required && explicitCandidates.length === 0) {
      return {
        criterion_id: criterion.id,
        status: "passed",
        event_refs: [],
        taint: [],
        taint_dependent: false,
      };
    }

    if (failingCandidates.length > 0) {
      hasHardFailure = true;
      const message = `Criterion ${criterion.id} has failing trace evidence: ${failingCandidates.map((event) => event.id).join(", ")}.`;
      unsupported.push(message);
      return {
        criterion_id: criterion.id,
        status: "failed",
        event_refs: refs,
        unsupported: message,
        taint,
        taint_dependent: taint.length > 0,
      };
    }

    if (primaryCandidates.length === 0) {
      hasUncertainty = true;
      const evaluatorOnly = explicitCandidates.length > 0;
      const message = evaluatorOnly
        ? `Criterion ${criterion.id} is supported only by evaluator/reflection events, which are not primary trace evidence.`
        : `Criterion ${criterion.id} has no supporting trace evidence.`;
      unsupported.push(message);
      return {
        criterion_id: criterion.id,
        status: "uncertain",
        event_refs: [],
        unsupported: message,
        taint: [],
        taint_dependent: false,
      };
    }

    if (missingRequiredTypes.length > 0) {
      hasUncertainty = true;
      const message = `Criterion ${criterion.id} is missing required trace event type(s): ${missingRequiredTypes.join(", ")}.`;
      unsupported.push(message);
      return {
        criterion_id: criterion.id,
        status: "uncertain",
        event_refs: refs,
        unsupported: message,
        taint,
        taint_dependent: taint.length > 0,
      };
    }

    if (!criterion.allowTaintedEvidence && taint.length > 0) {
      hasUncertainty = true;
      const message = `Criterion ${criterion.id} depends on tainted or untrusted trace evidence.`;
      unsupported.push(message);
      return {
        criterion_id: criterion.id,
        status: "uncertain",
        event_refs: refs,
        unsupported: message,
        taint,
        taint_dependent: true,
      };
    }

    return {
      criterion_id: criterion.id,
      status: "passed",
      event_refs: refs,
      taint,
      taint_dependent: taint.length > 0,
    };
  });

  const policyReviews: PolicyTraceReview[] = policies.map((policy) => {
    const required = policy.required !== false;
    const trustedTypes = policy.trustedEventTypes ?? DEFAULT_TRUSTED_POLICY_EVENT_TYPES;
    const referencedEvents = trace.filter((event) => policyReferences(event, policy));
    const trustedEvents = trace.filter(
      (event) =>
        !isEvaluatorEvent(event) &&
        event.trusted === true &&
        (trustedTypes.includes(event.type) || policyReferences(event, policy)),
    );
    const failingEvents = referencedEvents.filter(hasFailureStatus);
    const usedEvents = trustedEvents.length > 0 ? trustedEvents : referencedEvents.filter((event) => !isEvaluatorEvent(event));
    const taint = mergeTaint(usedEvents.flatMap(normalizeEventTaint));
    const disallowedSources = new Set(policy.disallowedTaintSources ?? []);
    const hasDisallowedTaint = taint.some((entry) => disallowedSources.has(entry.source));
    const refs = unique(usedEvents.map((event) => event.id));
    eventRefs[`policy:${policy.id}`] = refs;

    if (failingEvents.length > 0) {
      hasHardFailure = policy.failOnViolation !== false;
      const message = `Policy ${policy.id} has failing or denied trace event(s): ${failingEvents.map((event) => event.id).join(", ")}.`;
      unsupported.push(message);
      return { policy_id: policy.id, status: "failed", event_refs: refs, unsupported: message, taint };
    }

    if (policy.requiresTrustedEvent && trustedEvents.length === 0 && required) {
      hasHardFailure = policy.failOnViolation !== false;
      const message = `Policy ${policy.id} requires a trusted non-evaluator trace event; evaluator scores are not authorization.`;
      unsupported.push(message);
      return { policy_id: policy.id, status: "failed", event_refs: refs, unsupported: message, taint };
    }

    if (hasDisallowedTaint) {
      hasHardFailure = policy.failOnViolation !== false;
      const message = `Policy ${policy.id} has disallowed taint source(s): ${taint
        .filter((entry) => disallowedSources.has(entry.source))
        .map((entry) => entry.source)
        .join(", ")}.`;
      unsupported.push(message);
      return { policy_id: policy.id, status: "failed", event_refs: refs, unsupported: message, taint };
    }

    return { policy_id: policy.id, status: "passed", event_refs: refs, taint };
  });

  const allTaint = mergeTaint([
    ...criterionReviews.flatMap((review) => review.taint),
    ...policyReviews.flatMap((review) => review.taint),
  ]);

  const status: TraceReviewStatus = hasHardFailure ? "failed" : hasUncertainty ? "uncertain" : "passed";

  return {
    behavior_id: beh_trace_grounded_self_evaluation_18.id,
    status,
    event_refs: eventRefs,
    criteria: criterionReviews,
    policy: policyReviews,
    unsupported: unique(unsupported),
    taint: allTaint,
  };
}

export interface FinalizationReviewInput {
  nontrivial: boolean;
  finalAnswer: unknown;
  criteria: SuccessCriterion[];
  trace: TraceEvent[];
  policyConstraints?: PolicyConstraint[];
  budgetRemaining?: number;
  correction?: (evaluation: TraceEvaluationResult) => TraceEvent[];
}

export interface FinalizationReviewResult {
  status: "success" | "structured_failure";
  finalAnswer?: unknown;
  failure_behavior_id?: "beh_structured_failure_2";
  reason?: string;
  traceEvaluation: TraceEvaluationResult;
  trace: TraceEvent[];
  correctionAttempted: boolean;
}

export function finalizeWithTraceReview(input: FinalizationReviewInput): FinalizationReviewResult {
  let trace = [...input.trace];
  let evaluation = evaluateTrace({
    criteria: input.criteria,
    trace,
    policyConstraints: input.policyConstraints,
  });

  if (!input.nontrivial || evaluation.status === "passed") {
    return {
      status: "success",
      finalAnswer: input.finalAnswer,
      traceEvaluation: evaluation,
      trace,
      correctionAttempted: false,
    };
  }

  if ((input.budgetRemaining ?? 0) > 0 && input.correction) {
    const correctionEvents = input.correction(evaluation);
    trace = [...trace, ...correctionEvents];
    evaluation = evaluateTrace({
      criteria: input.criteria,
      trace,
      policyConstraints: input.policyConstraints,
    });

    if (evaluation.status === "passed") {
      return {
        status: "success",
        finalAnswer: input.finalAnswer,
        traceEvaluation: evaluation,
        trace,
        correctionAttempted: true,
      };
    }

    return {
      status: "structured_failure",
      failure_behavior_id: "beh_structured_failure_2",
      reason: "Trace evaluation remained failed or uncertain after targeted correction.",
      traceEvaluation: evaluation,
      trace,
      correctionAttempted: true,
    };
  }

  return {
    status: "structured_failure",
    failure_behavior_id: "beh_structured_failure_2",
    reason: "Trace evaluation failed or was uncertain and correction budget is exhausted.",
    traceEvaluation: evaluation,
    trace,
    correctionAttempted: false,
  };
}

export interface SkillDistillationReviewInput {
  traceEvaluation: TraceEvaluationResult;
  reflection: { status?: string; success?: boolean };
}

export function reviewSkillDistillation(input: SkillDistillationReviewInput): {
  status: "approved" | "advisory";
  advisory: boolean;
  existingSkillPathwaysRequired: true;
  reasons: string[];
} {
  const reflectionPassed = input.reflection.success === true || input.reflection.status === "passed";
  const reasons: string[] = [];

  if (!reflectionPassed) {
    reasons.push("beh_criteria_reflection_2 did not report success.");
  }
  if (input.traceEvaluation.status !== "passed") {
    reasons.push("trace evaluation did not pass.");
  }

  return {
    status: reasons.length === 0 ? "approved" : "advisory",
    advisory: reasons.length > 0,
    existingSkillPathwaysRequired: true,
    reasons,
  };
}

export interface MissionMilestoneReviewInput {
  traceEvaluation: TraceEvaluationResult;
  missionCriteriaPassed: boolean;
  taintValid: boolean;
}

export function reviewMissionMilestone(input: MissionMilestoneReviewInput): {
  canComplete: boolean;
  usesMissionControlCriteria: true;
  taintValidated: boolean;
  traceEvaluationStatus: TraceReviewStatus;
} {
  return {
    canComplete: input.missionCriteriaPassed && input.taintValid && input.traceEvaluation.status === "passed",
    usesMissionControlCriteria: true,
    taintValidated: input.taintValid,
    traceEvaluationStatus: input.traceEvaluation.status,
  };
}

export default beh_trace_grounded_self_evaluation_18;
