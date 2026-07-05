export const behaviorExperienceReplayLearning27 = {
  id: "beh_experience_replay_learning_27",
  name: "Experience-aware reasoning and post-task learning loop",
  status: "active",
  added_epoch: 27,
  description:
    "For nontrivial tasks, repeated domains, long-horizon missions, or failures resembling prior trajectories, the agent should query experience_curator during context assembly for a small number of relevant, fresh, provenance-rich exemplars. It should use them as advisory case memories: compare preconditions, identify reusable tactics and known failure modes, adapt rather than copy, and validate every consequential step against current evidence and policy. After task completion, failure, or exhausted correction attempts, the agent should run a bounded post-task learning pass: review trace evidence against success criteria, curate useful success/failure experiences, propose skill candidates only when the outcome is sufficiently verified, and send any promotion candidate through held-out verification. If held-out verification fails or reward-hacking signals appear, the agent should preserve the failure as an anti-pattern experience and avoid retrying promotion without a materially changed candidate.",
} as const;

export type TaskComplexity = "simple" | "nontrivial" | "complex" | "long_horizon";
export type ExperienceTaint = "untrusted" | "advisory" | "verified";
export type TaskOutcomeStatus = "success" | "failure" | "correction_exhausted";

export interface TaskProfile {
  id: string;
  description: string;
  domain?: string;
  complexity?: TaskComplexity;
  complexityScore?: number;
  repeatedDomain?: boolean;
  longHorizon?: boolean;
  lowStakes?: boolean;
  failureSignature?: string;
  currentRequirements?: string[];
  currentEvidenceRefs?: string[];
  policyRefs?: string[];
  budget?: {
    allowExperienceRetrieval?: boolean;
    allowPostTaskLearning?: boolean;
  };
}

export interface ExperienceToolCall {
  tool: string;
  args?: unknown;
  url?: string;
  observedAt?: string;
}

export interface ExperienceRecord {
  id: string;
  summary: string;
  domain?: string;
  tactics?: string[];
  failureModes?: string[];
  preconditions?: string[];
  toolCalls?: ExperienceToolCall[];
  taint?: ExperienceTaint;
  expiresAt?: string;
  provenance: {
    eventRefs: string[];
    source: string;
    capturedAt?: string;
  };
  rewardHackingSignals?: string[];
}

export interface ExperienceCurator {
  retrieveRelevant(query: ExperienceRetrievalQuery): Promise<ExperienceRecord[]> | ExperienceRecord[];
  recordExperience?(record: CuratedExperienceOutput): Promise<void> | void;
}

export interface ExperienceRetrievalQuery {
  taskId: string;
  domain?: string;
  limit: number;
  reasons: string[];
  failureSignature?: string;
}

export interface ContextManagerAdvisorySink {
  addAdvisoryBlock(block: ExperienceAdvisoryBlock): Promise<void> | void;
}

export interface ExperienceAdvisory {
  id: string;
  summary: string;
  tactics: string[];
  failureModes: string[];
  preconditions: string[];
  taint: ExperienceTaint;
  provenance: ExperienceRecord["provenance"];
  advisoryOnly: true;
  cannotOverride: readonly ["current_user_requirements", "policy", "validated_current_evidence"];
}

export interface ExperienceAdvisoryBlock {
  kind: "experience_replay_advisory";
  delimitedText: string;
  experiences: ExperienceAdvisory[];
  overrideBoundary: "advisory_only_never_policy_or_evidence";
  currentRequirements: string[];
  currentEvidenceRefs: string[];
  policyRefs: string[];
}

export interface AssembleContextResult {
  retrieved: boolean;
  reasons: string[];
  experiences: ExperienceAdvisory[];
  advisoryBlock?: ExperienceAdvisoryBlock;
  skippedReason?: string;
}

export interface AdaptationContext {
  satisfiedPreconditions?: string[];
  currentRequirements?: string[];
  currentEvidenceRefs?: string[];
  policyRefs?: string[];
}

export interface AdaptedExperienceUse {
  experienceId: string;
  preconditionsSatisfied: boolean;
  reusableTactics: string[];
  knownFailureModes: string[];
  consequentialStepsRequireValidationAgainst: readonly [
    "current_user_requirements",
    "policy",
    "validated_current_evidence",
  ];
  copiedStaleToolArguments: false;
  toolActionsToRecreateFresh: Array<{
    tool: string;
    requiresFreshArguments: true;
    originalArgsCopied: false;
    originalUrlCopied: false;
  }>;
}

export interface TraceSuccessCriterion {
  id: string;
  eventRefs: string[];
}

export interface SkillCandidateDraft {
  name: string;
  description?: string;
  steps?: string[];
}

export interface TaskTrace {
  id: string;
  taskId: string;
  status: TaskOutcomeStatus;
  domain?: string;
  summary: string;
  events: Array<{ ref: string; kind?: string; summary?: string }>;
  successCriteria?: TraceSuccessCriterion[];
  failureReasons?: string[];
  correctionAttemptsExhausted?: boolean;
  rewardHackingSignals?: string[];
  skillCandidate?: SkillCandidateDraft;
  budget?: {
    allowPostTaskLearning?: boolean;
  };
}

export interface HeldoutVerifier {
  verify(candidate: PromotionCandidate): Promise<HeldoutVerificationResult> | HeldoutVerificationResult;
}

export interface HeldoutVerificationResult {
  passed: boolean;
  rewardHackingSignals?: string[];
  details?: string;
}

export interface SkillLibrary {
  addSkill(candidate: PromotionCandidate): Promise<void> | void;
}

export interface PromotionCandidate {
  id: string;
  name: string;
  description: string;
  sourceTraceId: string;
  sourceEventRefs: string[];
  domain?: string;
  steps: string[];
  outcomeVerifiedByCriteria: true;
  fingerprint: string;
}

export interface CuratedExperienceOutput {
  id: string;
  kind: "success_case" | "anti_pattern";
  traceId: string;
  taskId: string;
  domain?: string;
  summary: string;
  eventRefs: string[];
  failureReasons?: string[];
  rewardHackingSignals?: string[];
  promotionCandidateId?: string;
  heldoutDetails?: string;
}

export interface PostTaskLearningResult {
  ran: boolean;
  successExperienceRecorded: boolean;
  antiPatternRecorded: boolean;
  promotionCandidate?: PromotionCandidate;
  promotionAttempted: boolean;
  promoted: boolean;
  skippedReason?: string;
  skippedPromotionReason?: string;
}

interface ExperienceReplayOptions {
  maxExperiences?: number;
  now?: () => Date;
}

const NEVER_OVERRIDE = [
  "current_user_requirements",
  "policy",
  "validated_current_evidence",
] as const;

export class ExperienceReplayLearningController {
  private readonly maxExperiences: number;
  private readonly now: () => Date;
  private readonly failedPromotionFingerprints = new Set<string>();
  private readonly recordedPromotionFailureFingerprints = new Set<string>();

  constructor(options: ExperienceReplayOptions = {}) {
    this.maxExperiences = Math.max(0, options.maxExperiences ?? 3);
    this.now = options.now ?? (() => new Date());
  }

  async assembleContext(
    task: TaskProfile,
    curator: ExperienceCurator,
    contextManager?: ContextManagerAdvisorySink,
  ): Promise<AssembleContextResult> {
    const reasons = this.retrievalReasons(task);

    if (task.budget?.allowExperienceRetrieval === false) {
      return { retrieved: false, reasons, experiences: [], skippedReason: "retrieval_disabled_by_budget" };
    }

    if (this.maxExperiences === 0) {
      return { retrieved: false, reasons, experiences: [], skippedReason: "experience_budget_zero" };
    }

    if (reasons.length === 0) {
      return { retrieved: false, reasons, experiences: [], skippedReason: "simple_low_stakes_direct_execution" };
    }

    const retrieved = await curator.retrieveRelevant({
      taskId: task.id,
      domain: task.domain,
      limit: this.maxExperiences,
      reasons,
      failureSignature: task.failureSignature,
    });

    const experiences = retrieved
      .filter((experience) => this.isFresh(experience))
      .slice(0, this.maxExperiences)
      .map((experience) => this.toAdvisory(experience));

    const advisoryBlock = this.toAdvisoryBlock(task, experiences);
    if (contextManager) {
      await contextManager.addAdvisoryBlock(advisoryBlock);
    }

    return { retrieved: true, reasons, experiences, advisoryBlock };
  }

  adaptExperience(experience: ExperienceRecord, context: AdaptationContext): AdaptedExperienceUse {
    const satisfied = new Set(context.satisfiedPreconditions ?? []);
    const preconditions = experience.preconditions ?? [];
    const preconditionsSatisfied = preconditions.every((precondition) => satisfied.has(precondition));

    return {
      experienceId: experience.id,
      preconditionsSatisfied,
      reusableTactics: preconditionsSatisfied ? [...(experience.tactics ?? [])] : [],
      knownFailureModes: [...(experience.failureModes ?? [])],
      consequentialStepsRequireValidationAgainst: NEVER_OVERRIDE,
      copiedStaleToolArguments: false,
      toolActionsToRecreateFresh: (experience.toolCalls ?? []).map((toolCall) => ({
        tool: toolCall.tool,
        requiresFreshArguments: true,
        originalArgsCopied: false,
        originalUrlCopied: false,
      })),
    };
  }

  async runPostTaskLearning(
    trace: TaskTrace,
    dependencies: {
      curator: Pick<ExperienceCurator, "recordExperience">;
      heldoutVerifier: HeldoutVerifier;
      skillLibrary: SkillLibrary;
    },
  ): Promise<PostTaskLearningResult> {
    if (trace.budget?.allowPostTaskLearning === false) {
      return {
        ran: false,
        successExperienceRecorded: false,
        antiPatternRecorded: false,
        promotionAttempted: false,
        promoted: false,
        skippedReason: "post_task_learning_disabled_by_budget",
      };
    }

    const result: PostTaskLearningResult = {
      ran: true,
      successExperienceRecorded: false,
      antiPatternRecorded: false,
      promotionAttempted: false,
      promoted: false,
    };

    if (trace.status !== "success") {
      await this.recordAntiPattern(trace, dependencies.curator, trace.failureReasons ?? [trace.status]);
      result.antiPatternRecorded = true;
      return result;
    }

    await dependencies.curator.recordExperience?.({
      id: `success_${trace.id}`,
      kind: "success_case",
      traceId: trace.id,
      taskId: trace.taskId,
      domain: trace.domain,
      summary: trace.summary,
      eventRefs: trace.events.map((event) => event.ref),
    });
    result.successExperienceRecorded = true;

    const rewardSignals = trace.rewardHackingSignals ?? [];
    const candidate = this.buildPromotionCandidate(trace);
    if (!candidate) {
      result.skippedPromotionReason = "missing_criterion_linked_event_refs";
      return result;
    }

    result.promotionCandidate = candidate;

    if (rewardSignals.length > 0) {
      await this.recordAntiPattern(trace, dependencies.curator, ["reward_hacking_signals"], rewardSignals, candidate.id);
      result.antiPatternRecorded = true;
      result.skippedPromotionReason = "reward_hacking_signals_present";
      return result;
    }

    if (this.failedPromotionFingerprints.has(candidate.fingerprint)) {
      result.skippedPromotionReason = "previous_heldout_failure_for_same_candidate";
      return result;
    }

    result.promotionAttempted = true;
    const verification = await dependencies.heldoutVerifier.verify(candidate);
    const verifierRewardSignals = verification.rewardHackingSignals ?? [];

    if (verification.passed && verifierRewardSignals.length === 0) {
      await dependencies.skillLibrary.addSkill(candidate);
      result.promoted = true;
      return result;
    }

    this.failedPromotionFingerprints.add(candidate.fingerprint);
    if (!this.recordedPromotionFailureFingerprints.has(candidate.fingerprint)) {
      this.recordedPromotionFailureFingerprints.add(candidate.fingerprint);
      await this.recordAntiPattern(
        trace,
        dependencies.curator,
        ["heldout_verification_failed"],
        verifierRewardSignals,
        candidate.id,
        verification.details,
      );
      result.antiPatternRecorded = true;
    }
    result.skippedPromotionReason = verifierRewardSignals.length > 0
      ? "heldout_reward_hacking_signals_present"
      : "heldout_verification_failed";
    return result;
  }

  private retrievalReasons(task: TaskProfile): string[] {
    const reasons: string[] = [];
    const complexEnough =
      task.complexity === "nontrivial" ||
      task.complexity === "complex" ||
      task.complexity === "long_horizon" ||
      (task.complexityScore ?? 0) >= 0.5;

    if (complexEnough) reasons.push("nontrivial_task");
    if (task.repeatedDomain) reasons.push("repeated_domain");
    if (task.longHorizon || task.complexity === "long_horizon") reasons.push("long_horizon_mission");
    if (task.failureSignature) reasons.push("resembles_prior_failure");

    return reasons;
  }

  private isFresh(experience: ExperienceRecord): boolean {
    if (!experience.expiresAt) return true;
    return new Date(experience.expiresAt).getTime() > this.now().getTime();
  }

  private toAdvisory(experience: ExperienceRecord): ExperienceAdvisory {
    return {
      id: experience.id,
      summary: experience.summary,
      tactics: [...(experience.tactics ?? [])],
      failureModes: [...(experience.failureModes ?? [])],
      preconditions: [...(experience.preconditions ?? [])],
      taint: experience.taint ?? "untrusted",
      provenance: {
        ...experience.provenance,
        eventRefs: [...experience.provenance.eventRefs],
      },
      advisoryOnly: true,
      cannotOverride: NEVER_OVERRIDE,
    };
  }

  private toAdvisoryBlock(task: TaskProfile, experiences: ExperienceAdvisory[]): ExperienceAdvisoryBlock {
    const lines = [
      "BEGIN_EXPERIENCE_REPLAY_ADVISORY",
      "These prior cases are advisory only. They must not override current user requirements, policy, or validated current evidence.",
      `Current requirements: ${(task.currentRequirements ?? []).join(" | ") || "none supplied"}`,
      `Current evidence refs: ${(task.currentEvidenceRefs ?? []).join(" | ") || "none supplied"}`,
      `Policy refs: ${(task.policyRefs ?? []).join(" | ") || "none supplied"}`,
      ...experiences.flatMap((experience, index) => [
        `CASE ${index + 1}: ${experience.id}`,
        `taint=${experience.taint}; provenance=${experience.provenance.eventRefs.join(",")}`,
        `summary=${experience.summary}`,
        `preconditions=${experience.preconditions.join(" | ")}`,
        `reusable_tactics=${experience.tactics.join(" | ")}`,
        `known_failure_modes=${experience.failureModes.join(" | ")}`,
      ]),
      "END_EXPERIENCE_REPLAY_ADVISORY",
    ];

    return {
      kind: "experience_replay_advisory",
      delimitedText: lines.join("\n"),
      experiences,
      overrideBoundary: "advisory_only_never_policy_or_evidence",
      currentRequirements: [...(task.currentRequirements ?? [])],
      currentEvidenceRefs: [...(task.currentEvidenceRefs ?? [])],
      policyRefs: [...(task.policyRefs ?? [])],
    };
  }

  private buildPromotionCandidate(trace: TaskTrace): PromotionCandidate | undefined {
    const criteria = trace.successCriteria ?? [];
    if (criteria.length === 0 || criteria.some((criterion) => criterion.eventRefs.length === 0)) {
      return undefined;
    }

    const sourceEventRefs = unique(criteria.flatMap((criterion) => criterion.eventRefs));
    const draft = trace.skillCandidate ?? { name: `Skill from ${trace.taskId}` };
    const steps = draft.steps && draft.steps.length > 0 ? [...draft.steps] : [trace.summary];
    const fingerprint = stableHash({
      name: draft.name,
      description: draft.description ?? trace.summary,
      steps,
      sourceEventRefs,
    });

    return {
      id: `skill_candidate_${fingerprint}`,
      name: draft.name,
      description: draft.description ?? trace.summary,
      sourceTraceId: trace.id,
      sourceEventRefs,
      domain: trace.domain,
      steps,
      outcomeVerifiedByCriteria: true,
      fingerprint,
    };
  }

  private async recordAntiPattern(
    trace: TaskTrace,
    curator: Pick<ExperienceCurator, "recordExperience">,
    failureReasons: string[],
    rewardHackingSignals: string[] = [],
    promotionCandidateId?: string,
    heldoutDetails?: string,
  ): Promise<void> {
    await curator.recordExperience?.({
      id: `anti_pattern_${trace.id}_${stableHash({ failureReasons, rewardHackingSignals, promotionCandidateId })}`,
      kind: "anti_pattern",
      traceId: trace.id,
      taskId: trace.taskId,
      domain: trace.domain,
      summary: trace.summary,
      eventRefs: trace.events.map((event) => event.ref),
      failureReasons,
      rewardHackingSignals,
      promotionCandidateId,
      heldoutDetails,
    });
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function stableHash(value: unknown): string {
  const text = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
