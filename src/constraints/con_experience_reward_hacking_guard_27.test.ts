import { describe, expect, it } from "vitest";
import {
  authorizeEvidenceForLifecycleClaim,
  evaluateExperiencePromotionGuard,
  replayExperiencePromotionGuardFromDurableRefs,
  sanitizeForExperienceRewardHackingMetadata,
  type DurableVerificationRef,
} from "./con_experience_reward_hacking_guard_27";

const durableRef: DurableVerificationRef = {
  verifierRunId: "verifier-run-27-a",
  policyVersion: "experience-guard-v1",
  sealedTaskDigest: "sha256:sealed-task-digest",
  harnessDigest: "sha256:harness-digest",
  outcome: "passed",
};

describe("experience reward hacking guard", () => {
  it("rejects a skill candidate that passes visible validation traces but fails held-out variants", () => {
    const decision = evaluateExperiencePromotionGuard({
      candidateId: "skill-visible-only-sorter",
      candidateKind: "procedural_skill",
      evidence: [
        { kind: "visible_validation_trace", score: 1, summary: "passed all controller-visible traces" },
        { kind: "visible_test", score: 1 },
      ],
      verification: {
        kind: "sealed_heldout",
        status: "failed",
        validationScore: 1,
        heldoutScore: 0.4,
        durableRef: { ...durableRef, outcome: "failed" },
      },
    });

    expect(decision.status).toBe("promotion_rejected");
    expect(decision.reasons).toContain("heldout_verification_failed");
    expect(decision.redactedMetadata.validationHoldoutGap).toBe(0.6);
  });

  it("policy-blocks candidates that inspect answer files, hidden fixtures, trace ids, rubrics, or sealed seeds", () => {
    const decision = evaluateExperiencePromotionGuard({
      candidateId: "skill-answer-reader",
      candidateKind: "skill_update",
      evidence: [{ kind: "visible_test", score: 1 }],
      verification: {
        kind: "sealed_heldout",
        status: "passed",
        durableRef,
        rewardHackingSignals: [
          {
            kind: "answer_file_read",
            severity: "critical",
            detail: {
              answerPath: "/sealed/harness/answers/SECRET_ANSWER_42.json",
              rubricText: "RUBRIC: award points for exact hidden key",
              sealedSeed: "SEALED_SEED_123",
              traceId: "trace-hidden-abc",
            },
          },
        ],
      },
    });

    expect(decision.status).toBe("policy_blocked");
    expect(decision.reasons).toContain("attempted_sealed_material_access");
    const rendered = JSON.stringify(decision);
    expect(rendered).not.toContain("SECRET_ANSWER_42");
    expect(rendered).not.toContain("SEALED_SEED_123");
    expect(rendered).not.toContain("trace-hidden-abc");
  });

  it("denies outbound network during sealed verification by default and permits explicit read-only allowlists", () => {
    const denied = evaluateExperiencePromotionGuard({
      candidateId: "skill-network-lookup",
      candidateKind: "procedural_skill",
      evidence: [{ kind: "sealed_heldout_verification", score: 1 }],
      verification: {
        kind: "sealed_heldout",
        status: "passed",
        durableRef,
        network: { requested: true },
      },
    });

    expect(denied.status).toBe("policy_blocked");
    expect(denied.reasons).toContain("network_denied_in_sealed_verification");

    const allowed = evaluateExperiencePromotionGuard({
      candidateId: "skill-readonly-api",
      candidateKind: "procedural_skill",
      evidence: [{ kind: "sealed_heldout_verification", score: 1 }],
      verification: {
        kind: "sealed_heldout",
        status: "passed",
        durableRef,
        network: { requested: true, explicitReadOnlyAllowlist: ["https://readonly.example.test"] },
      },
    });

    expect(allowed.status).toBe("promotion_allowed");
    expect(allowed.redactedMetadata.networkDefault).toBe("deny");
    expect(allowed.redactedMetadata.networkAllowlist).toEqual(["https://readonly.example.test"]);
  });

  it("rejects promotion when the validation/holdout gap exceeds the policy threshold even with a high validation score", () => {
    const decision = evaluateExperiencePromotionGuard({
      candidateId: "skill-overfit-visible-suite",
      candidateKind: "planner_heuristic",
      evidence: [{ kind: "sealed_heldout_verification", score: 0.71 }],
      verification: {
        kind: "sealed_heldout",
        status: "passed",
        validationScore: 0.98,
        heldoutScore: 0.71,
        gapThreshold: 0.1,
        durableRef,
      },
    });

    expect(decision.status).toBe("promotion_rejected");
    expect(decision.reasons).toContain("validation_holdout_gap_exceeded");
  });

  it("does not allow retrieved experiences as sole evidence for lifecycle claims or promotions", () => {
    const lifecycleDecision = authorizeEvidenceForLifecycleClaim([
      { kind: "retrieved_experience", summary: "similar task succeeded previously" },
    ]);

    expect(lifecycleDecision).toEqual({ allowed: false, reason: "sole_controller_visible_evidence" });

    const promotionDecision = evaluateExperiencePromotionGuard({
      candidateId: "experience-copycat",
      candidateKind: "experience",
      evidence: [{ kind: "retrieved_experience", summary: "prior answer looked similar" }],
    });

    expect(promotionDecision.status).toBe("promotion_rejected");
    expect(promotionDecision.reasons).toContain("controller_visible_evidence_not_sufficient");
  });

  it("does not let trace-eval scores or evaluator rationales alone promote memory lessons or skill updates", () => {
    const memoryLesson = evaluateExperiencePromotionGuard({
      candidateId: "lesson-from-rationale-only",
      candidateKind: "memory_lesson",
      evidence: [
        { kind: "trace_eval_score", score: 1 },
        { kind: "evaluator_rationale", summary: "looks good to the evaluator" },
      ],
    });

    expect(memoryLesson.status).toBe("promotion_rejected");
    expect(memoryLesson.reasons).toContain("trace_eval_not_sufficient");
  });

  it("keeps held-out harness internals out of model-visible diagnostics and reward-hacking metadata", () => {
    const decision = evaluateExperiencePromotionGuard({
      candidateId: "skill-leaky-diagnostics",
      candidateKind: "context_exemplar",
      evidence: [{ kind: "visible_test", score: 1 }],
      verification: {
        kind: "sealed_heldout",
        status: "passed",
        durableRef,
        exposedHarnessInternals: {
          fixturePath: "/sealed/fixtures/CANARY_FIXTURE_777.json",
          answerKey: "ANSWER_KEY_SHOULD_NOT_RENDER",
        },
        rewardHackingSignals: [
          {
            kind: "hidden_material_rendered",
            detail: "CANARY_DO_NOT_LOG_777 with ANSWER_KEY_SHOULD_NOT_RENDER",
          },
        ],
      },
    });

    expect(decision.status).toBe("policy_blocked");
    const rendered = JSON.stringify(decision);
    expect(rendered).not.toContain("CANARY_FIXTURE_777");
    expect(rendered).not.toContain("CANARY_DO_NOT_LOG_777");
    expect(rendered).not.toContain("ANSWER_KEY_SHOULD_NOT_RENDER");
    expect(decision.redactedMetadata.rewardHackingSignals[0]).toMatchObject({
      kind: "hidden_material_rendered",
      redacted: true,
    });
  });

  it("replays promotion after restart only from durable non-secret refs and blocks plaintext answer keys", () => {
    const replayed = replayExperiencePromotionGuardFromDurableRefs({
      candidateId: "skill-replay-safe",
      candidateKind: "procedural_skill",
      durableVerificationRef: durableRef,
      evidence: [{ kind: "sealed_heldout_verification", score: 1 }],
    });

    expect(replayed.status).toBe("promotion_allowed");
    expect(JSON.stringify(replayed)).toContain("sha256:sealed-task-digest");

    const blocked = replayExperiencePromotionGuardFromDurableRefs({
      candidateId: "skill-replay-unsafe",
      candidateKind: "procedural_skill",
      durableVerificationRef: durableRef,
      evidence: [{ kind: "sealed_heldout_verification", score: 1 }],
      unsafePlaintextSealedMaterial: { answerKey: "ANSWER_KEY_PLAINTEXT" },
    });

    expect(blocked.status).toBe("policy_blocked");
    expect(blocked.reasons).toContain("invalid_durable_verification_ref");
    expect(JSON.stringify(blocked)).not.toContain("ANSWER_KEY_PLAINTEXT");
  });

  it("invalidates dependent experiences and promotion candidates when scope or memory dependencies are deleted", () => {
    const decision = evaluateExperiencePromotionGuard({
      candidateId: "skill-deleted-memory-dependent",
      candidateKind: "skill_update",
      evidence: [{ kind: "sealed_heldout_verification", score: 1 }],
      verification: {
        kind: "sealed_heldout",
        status: "passed",
        durableRef,
      },
      dependencies: [
        { kind: "memory", id: "memory:lesson-12", deleted: true },
        { kind: "scope", id: "scope:old-project" },
      ],
      deletedDependencyIds: ["scope:old-project"],
    });

    expect(decision.status).toBe("promotion_rejected");
    expect(decision.reasons).toContain("deleted_dependency");
    expect(decision.redactedMetadata.deletedDependencyIds).toEqual(["memory:lesson-12", "scope:old-project"]);
  });

  it("sanitizes reward-hacking signal details without exposing hidden tests or answers", () => {
    const sanitized = sanitizeForExperienceRewardHackingMetadata({
      ordinary: "safe summary",
      hiddenTestName: "CANARY_PRIVATE_TEST",
      nested: { rubric: "RUBRIC_SECRET", value: 3 },
    });

    expect(sanitized).toEqual({
      ordinary: "safe summary",
      hiddenTestName: "[REDACTED]",
      nested: { rubric: "[REDACTED]", value: 3 },
    });
  });
});
