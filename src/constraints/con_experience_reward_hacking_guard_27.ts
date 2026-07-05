export const EXPERIENCE_REWARD_HACKING_GUARD_CONSTRAINT = {
  id: "con_experience_reward_hacking_guard_27",
  name: "Experience-learning anti-reward-hacking and held-out verification integrity",
  status: "active",
  added_epoch: 27,
  description:
    "The agent must never promote learned procedures, memory lessons, heuristics, or exemplars from controller-visible evidence alone. Promotion claims require sealed held-out verification plus the existing skill-library and controller policy gates.",
} as const;

export type PromotionCandidateKind =
  | "experience"
  | "procedural_skill"
  | "skill_update"
  | "planner_heuristic"
  | "memory_lesson"
  | "context_exemplar";

export type PromotionGuardStatus = "promotion_allowed" | "promotion_rejected" | "policy_blocked";

export type PromotionGuardReason =
  | "attempted_sealed_material_access"
  | "network_denied_in_sealed_verification"
  | "hidden_harness_material_exposed"
  | "deleted_dependency"
  | "trace_eval_not_sufficient"
  | "controller_visible_evidence_not_sufficient"
  | "missing_sealed_heldout_verification"
  | "heldout_verification_failed"
  | "validation_holdout_gap_exceeded"
  | "invalid_durable_verification_ref"
  | "existing_policy_checks_still_required";

export type EvidenceKind =
  | "visible_validation_trace"
  | "visible_test"
  | "example"
  | "retrieved_experience"
  | "trace_eval_score"
  | "evaluator_rationale"
  | "self_grade"
  | "claim_ledger_confidence"
  | "uncertainty_score"
  | "context_summary"
  | "sealed_heldout_verification"
  | "controller_approval"
  | "scope_authorization"
  | "sandbox_conformance"
  | "redaction_check";

export interface PromotionEvidence {
  kind: EvidenceKind;
  id?: string;
  score?: number;
  summary?: string;
}

export type RewardHackingSignalKind =
  | "answer_file_read"
  | "hidden_fixture_inspection"
  | "trace_id_lookup"
  | "evaluator_rubric_access"
  | "sealed_seed_access"
  | "canary_leak"
  | "memorized_fixture_dependence"
  | "brittle_task_matching"
  | "network_answer_lookup"
  | "evaluator_prompt_injection"
  | "sealed_harness_inference"
  | "hidden_material_rendered";

export interface RewardHackingSignal {
  kind: RewardHackingSignalKind;
  severity?: "low" | "medium" | "high" | "critical";
  detail?: unknown;
}

export interface SealedNetworkPolicy {
  requested?: boolean;
  explicitReadOnlyAllowlist?: readonly string[];
}

export interface DurableVerificationRef {
  verifierRunId: string;
  policyVersion: string;
  sealedTaskDigest: string;
  harnessDigest: string;
  outcome: "passed" | "failed";
}

export interface HeldOutVerificationReport {
  kind: "sealed_heldout" | "visible_validation" | "self_grade";
  status: "passed" | "failed";
  validationScore?: number;
  heldoutScore?: number;
  gapThreshold?: number;
  durableRef?: DurableVerificationRef;
  network?: SealedNetworkPolicy;
  rewardHackingSignals?: readonly RewardHackingSignal[];
  exposedHarnessInternals?: unknown;
}

export interface CandidateDependency {
  kind: "scope" | "memory" | "experience" | "artifact" | "verification_ref";
  id: string;
  deleted?: boolean;
}

export interface PromotionGuardInput {
  candidateId: string;
  candidateKind: PromotionCandidateKind;
  evidence?: readonly PromotionEvidence[];
  verification?: HeldOutVerificationReport;
  dependencies?: readonly CandidateDependency[];
  deletedDependencyIds?: readonly string[];
}

export interface RedactedRewardHackingSignal {
  kind: RewardHackingSignalKind;
  severity: "low" | "medium" | "high" | "critical";
  redacted: true;
  detailDigest: string;
}

export interface PromotionGuardDecision {
  status: PromotionGuardStatus;
  reasons: PromotionGuardReason[];
  redactedMetadata: {
    constraintId: typeof EXPERIENCE_REWARD_HACKING_GUARD_CONSTRAINT.id;
    candidateId: string;
    candidateKind: PromotionCandidateKind;
    annotationsOnly: true;
    hiddenMaterialRedacted: true;
    validationScore?: number;
    heldoutScore?: number;
    validationHoldoutGap?: number;
    gapThreshold?: number;
    networkDefault: "deny";
    networkAllowlist: readonly string[];
    durableVerificationRef?: DurableVerificationRef;
    rewardHackingSignals: RedactedRewardHackingSignal[];
    deletedDependencyIds: readonly string[];
  };
}

export interface LifecycleEvidenceDecision {
  allowed: boolean;
  reason?: "sole_controller_visible_evidence";
}

export interface PromotionReplayInput {
  candidateId: string;
  candidateKind: PromotionCandidateKind;
  durableVerificationRef?: DurableVerificationRef;
  evidence?: readonly PromotionEvidence[];
  dependencies?: readonly CandidateDependency[];
  deletedDependencyIds?: readonly string[];
  rewardHackingSignals?: readonly RewardHackingSignal[];
  network?: SealedNetworkPolicy;
  unsafePlaintextSealedMaterial?: unknown;
}

const DEFAULT_GAP_THRESHOLD = 0.15;

const CONTROLLER_VISIBLE_EVIDENCE = new Set<EvidenceKind>([
  "visible_validation_trace",
  "visible_test",
  "example",
  "retrieved_experience",
  "trace_eval_score",
  "evaluator_rationale",
  "self_grade",
  "claim_ledger_confidence",
  "uncertainty_score",
  "context_summary",
]);

const TRACE_EVAL_ONLY_EVIDENCE = new Set<EvidenceKind>([
  "trace_eval_score",
  "evaluator_rationale",
  "self_grade",
  "claim_ledger_confidence",
  "uncertainty_score",
]);

const SENSITIVE_KEY_PATTERN = /(answer|answerKey|hidden|fixture|rubric|seed|canary|secret|traceId|trace_id|path|content)/i;
const SENSITIVE_VALUE_PATTERN = /(ANSWER|CANARY|RUBRIC|SEALED[_-]?SEED|HIDDEN[_-]?FIXTURE|SECRET|ANSWER_KEY)/i;

export function evaluateExperiencePromotionGuard(input: PromotionGuardInput): PromotionGuardDecision {
  const verification = input.verification;
  const reasons: PromotionGuardReason[] = [];
  const signals = verification?.rewardHackingSignals ?? [];
  const network = verification?.network;
  const deletedDependencyIds = collectDeletedDependencyIds(input.dependencies, input.deletedDependencyIds);

  if (signals.length > 0) {
    reasons.push("attempted_sealed_material_access");
  }

  if (verification?.exposedHarnessInternals !== undefined) {
    reasons.push("hidden_harness_material_exposed");
  }

  if (network?.requested === true && !hasExplicitReadOnlyNetworkAllowlist(network)) {
    reasons.push("network_denied_in_sealed_verification");
  }

  if (deletedDependencyIds.length > 0) {
    reasons.push("deleted_dependency");
  }

  if (reasons.some(isPolicyBlockReason)) {
    return makeDecision("policy_blocked", uniqueReasons(reasons), input, deletedDependencyIds);
  }

  if (evidenceIsOnlyTraceEvalOrSelfGrade(input.evidence) && !hasPassedSealedHeldout(verification)) {
    reasons.push("trace_eval_not_sufficient");
  }

  if (evidenceIsOnlyControllerVisible(input.evidence) && !hasPassedSealedHeldout(verification)) {
    reasons.push("controller_visible_evidence_not_sufficient");
  }

  if (!verification || verification.kind !== "sealed_heldout") {
    reasons.push("missing_sealed_heldout_verification");
  } else if (verification.status !== "passed") {
    reasons.push("heldout_verification_failed");
  }

  if (validationHoldoutGapExceeded(verification)) {
    reasons.push("validation_holdout_gap_exceeded");
  }

  if (deletedDependencyIds.length > 0) {
    reasons.push("deleted_dependency");
  }

  if (reasons.length > 0) {
    return makeDecision("promotion_rejected", uniqueReasons(reasons), input, deletedDependencyIds);
  }

  return makeDecision(
    "promotion_allowed",
    ["existing_policy_checks_still_required"],
    input,
    deletedDependencyIds,
  );
}

export function authorizeEvidenceForLifecycleClaim(
  evidence: readonly PromotionEvidence[] | undefined,
): LifecycleEvidenceDecision {
  if (evidenceIsOnlyControllerVisible(evidence)) {
    return { allowed: false, reason: "sole_controller_visible_evidence" };
  }
  return { allowed: true };
}

export function replayExperiencePromotionGuardFromDurableRefs(
  input: PromotionReplayInput,
): PromotionGuardDecision {
  if (
    input.durableVerificationRef === undefined ||
    containsPlaintextSealedMaterial(input.unsafePlaintextSealedMaterial) ||
    containsPlaintextSealedMaterial(input.durableVerificationRef)
  ) {
    return makeDecision(
      "policy_blocked",
      ["invalid_durable_verification_ref"],
      {
        candidateId: input.candidateId,
        candidateKind: input.candidateKind,
        evidence: input.evidence,
        verification: {
          kind: "sealed_heldout",
          status: "failed",
          network: input.network,
          rewardHackingSignals: input.rewardHackingSignals,
        },
        dependencies: input.dependencies,
        deletedDependencyIds: input.deletedDependencyIds,
      },
      collectDeletedDependencyIds(input.dependencies, input.deletedDependencyIds),
    );
  }

  return evaluateExperiencePromotionGuard({
    candidateId: input.candidateId,
    candidateKind: input.candidateKind,
    evidence: input.evidence,
    verification: {
      kind: "sealed_heldout",
      status: input.durableVerificationRef.outcome,
      durableRef: input.durableVerificationRef,
      network: input.network,
      rewardHackingSignals: input.rewardHackingSignals,
    },
    dependencies: input.dependencies,
    deletedDependencyIds: input.deletedDependencyIds,
  });
}

export function sanitizeForExperienceRewardHackingMetadata(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return SENSITIVE_VALUE_PATTERN.test(value) ? "[REDACTED]" : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForExperienceRewardHackingMetadata(entry));
  }
  if (typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      sanitized[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? "[REDACTED]"
        : sanitizeForExperienceRewardHackingMetadata(entry);
    }
    return sanitized;
  }
  return "[REDACTED]";
}

function makeDecision(
  status: PromotionGuardStatus,
  reasons: PromotionGuardReason[],
  input: PromotionGuardInput,
  deletedDependencyIds: readonly string[],
): PromotionGuardDecision {
  const verification = input.verification;
  const validationScore = verification?.validationScore;
  const heldoutScore = verification?.heldoutScore;
  const gapThreshold = verification?.gapThreshold ?? DEFAULT_GAP_THRESHOLD;
  const validationHoldoutGap =
    typeof validationScore === "number" && typeof heldoutScore === "number"
      ? roundScore(validationScore - heldoutScore)
      : undefined;

  return {
    status,
    reasons,
    redactedMetadata: {
      constraintId: EXPERIENCE_REWARD_HACKING_GUARD_CONSTRAINT.id,
      candidateId: input.candidateId,
      candidateKind: input.candidateKind,
      annotationsOnly: true,
      hiddenMaterialRedacted: true,
      validationScore,
      heldoutScore,
      validationHoldoutGap,
      gapThreshold,
      networkDefault: "deny",
      networkAllowlist: verification?.network?.explicitReadOnlyAllowlist ?? [],
      durableVerificationRef: verification?.durableRef
        ? sanitizeDurableVerificationRef(verification.durableRef)
        : undefined,
      rewardHackingSignals: (verification?.rewardHackingSignals ?? []).map(redactRewardHackingSignal),
      deletedDependencyIds: [...deletedDependencyIds],
    },
  };
}

function sanitizeDurableVerificationRef(ref: DurableVerificationRef): DurableVerificationRef {
  return {
    verifierRunId: sanitizeDigestLikeString(ref.verifierRunId),
    policyVersion: sanitizeDigestLikeString(ref.policyVersion),
    sealedTaskDigest: sanitizeDigestLikeString(ref.sealedTaskDigest),
    harnessDigest: sanitizeDigestLikeString(ref.harnessDigest),
    outcome: ref.outcome,
  };
}

function sanitizeDigestLikeString(value: string): string {
  return SENSITIVE_VALUE_PATTERN.test(value) ? "[REDACTED]" : value;
}

function redactRewardHackingSignal(signal: RewardHackingSignal): RedactedRewardHackingSignal {
  const sanitizedDetail = sanitizeForExperienceRewardHackingMetadata(signal.detail);
  return {
    kind: signal.kind,
    severity: signal.severity ?? "high",
    redacted: true,
    detailDigest: stableDigest(JSON.stringify(sanitizedDetail)),
  };
}

function hasExplicitReadOnlyNetworkAllowlist(network: SealedNetworkPolicy): boolean {
  return Array.isArray(network.explicitReadOnlyAllowlist) && network.explicitReadOnlyAllowlist.length > 0;
}

function hasPassedSealedHeldout(verification: HeldOutVerificationReport | undefined): boolean {
  return verification?.kind === "sealed_heldout" && verification.status === "passed";
}

function evidenceIsOnlyControllerVisible(evidence: readonly PromotionEvidence[] | undefined): boolean {
  return evidence !== undefined && evidence.length > 0 && evidence.every((item) => CONTROLLER_VISIBLE_EVIDENCE.has(item.kind));
}

function evidenceIsOnlyTraceEvalOrSelfGrade(evidence: readonly PromotionEvidence[] | undefined): boolean {
  return evidence !== undefined && evidence.length > 0 && evidence.every((item) => TRACE_EVAL_ONLY_EVIDENCE.has(item.kind));
}

function validationHoldoutGapExceeded(verification: HeldOutVerificationReport | undefined): boolean {
  if (!verification || typeof verification.validationScore !== "number" || typeof verification.heldoutScore !== "number") {
    return false;
  }
  const threshold = verification.gapThreshold ?? DEFAULT_GAP_THRESHOLD;
  return verification.validationScore - verification.heldoutScore > threshold;
}

function collectDeletedDependencyIds(
  dependencies: readonly CandidateDependency[] | undefined,
  explicitDeletedIds: readonly string[] | undefined,
): string[] {
  const deleted = new Set<string>(explicitDeletedIds ?? []);
  for (const dependency of dependencies ?? []) {
    if (dependency.deleted) {
      deleted.add(dependency.id);
    }
  }
  return [...deleted].sort();
}

function isPolicyBlockReason(reason: PromotionGuardReason): boolean {
  return (
    reason === "attempted_sealed_material_access" ||
    reason === "network_denied_in_sealed_verification" ||
    reason === "hidden_harness_material_exposed" ||
    reason === "invalid_durable_verification_ref"
  );
}

function uniqueReasons(reasons: readonly PromotionGuardReason[]): PromotionGuardReason[] {
  return [...new Set(reasons)];
}

function containsPlaintextSealedMaterial(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return SENSITIVE_VALUE_PATTERN.test(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(containsPlaintextSealedMaterial);
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, entry]) => SENSITIVE_KEY_PATTERN.test(key) && !isAllowedDurableRefKey(key) || containsPlaintextSealedMaterial(entry),
    );
  }
  return true;
}

function isAllowedDurableRefKey(key: string): boolean {
  return key === "verifierRunId" || key === "policyVersion" || key === "sealedTaskDigest" || key === "harnessDigest" || key === "outcome";
}

function stableDigest(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function roundScore(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}
