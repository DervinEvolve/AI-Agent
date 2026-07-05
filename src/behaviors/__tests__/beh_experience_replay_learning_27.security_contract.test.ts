import { describe, expect, it, vi } from "vitest";
import {
  ExperienceReplayLearningController,
  ExperienceRecord,
  TaskTrace,
  behaviorExperienceReplayLearning27,
} from "../beh_experience_replay_learning_27";

const freshExperience: ExperienceRecord = {
  id: "exp-1",
  summary: "A prior refactor succeeded after running focused tests first.",
  domain: "typescript-agent",
  tactics: ["run focused test before broad suite"],
  failureModes: ["broad suite hides localized regression"],
  preconditions: ["repo_has_vitest"],
  toolCalls: [{ tool: "browser.open", url: "https://old.example.invalid/stale", args: { q: "stale" } }],
  taint: "untrusted",
  expiresAt: "2099-01-01T00:00:00.000Z",
  provenance: { eventRefs: ["evt-old-1", "evt-old-2"], source: "experience_curator" },
};

function successfulTrace(overrides: Partial<TaskTrace> = {}): TaskTrace {
  return {
    id: "trace-success-1",
    taskId: "task-1",
    status: "success",
    domain: "typescript-agent",
    summary: "Implemented and validated a small behavior module.",
    events: [
      { ref: "evt-plan", kind: "plan" },
      { ref: "evt-test", kind: "test" },
    ],
    successCriteria: [{ id: "tests-pass", eventRefs: ["evt-test"] }],
    skillCandidate: {
      name: "Validate focused behavior changes",
      description: "Run a focused contract test before proposing a reusable behavior skill.",
      steps: ["identify contract", "run focused test", "record evidence ref"],
    },
    ...overrides,
  };
}

describe("beh_experience_replay_learning_27", () => {
  it("declares active behavior metadata", () => {
    expect(behaviorExperienceReplayLearning27).toMatchObject({
      id: "beh_experience_replay_learning_27",
      status: "active",
      added_epoch: 27,
    });
  });

  it("retrieves bounded relevant experiences for nontrivial repeated-domain tasks and includes delimited advisory data through context_manager", async () => {
    const controller = new ExperienceReplayLearningController({ maxExperiences: 2 });
    const staleExperience: ExperienceRecord = {
      ...freshExperience,
      id: "exp-stale",
      expiresAt: "2001-01-01T00:00:00.000Z",
    };
    const thirdExperience: ExperienceRecord = { ...freshExperience, id: "exp-3" };
    const curator = {
      retrieveRelevant: vi.fn().mockResolvedValue([freshExperience, thirdExperience, staleExperience]),
    };
    const contextManager = { addAdvisoryBlock: vi.fn() };

    const result = await controller.assembleContext(
      {
        id: "task-1",
        description: "Implement a long-horizon TypeScript behavior",
        domain: "typescript-agent",
        complexity: "nontrivial",
        repeatedDomain: true,
        currentRequirements: ["do not change public API"],
        currentEvidenceRefs: ["evt-current-requirements"],
        policyRefs: ["policy-no-secret-exfiltration"],
      },
      curator,
      contextManager,
    );

    expect(curator.retrieveRelevant).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        domain: "typescript-agent",
        limit: 2,
        reasons: expect.arrayContaining(["nontrivial_task", "repeated_domain"]),
      }),
    );
    expect(result.experiences).toHaveLength(2);
    expect(result.experiences.map((experience) => experience.id)).toEqual(["exp-1", "exp-3"]);
    expect(contextManager.addAdvisoryBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "experience_replay_advisory",
        overrideBoundary: "advisory_only_never_policy_or_evidence",
        delimitedText: expect.stringContaining("BEGIN_EXPERIENCE_REPLAY_ADVISORY"),
      }),
    );
  });

  it("skips experience retrieval for simple low-stakes tasks when budget is better spent on direct execution", async () => {
    const controller = new ExperienceReplayLearningController();
    const curator = { retrieveRelevant: vi.fn() };

    const result = await controller.assembleContext(
      {
        id: "task-simple",
        description: "Answer a direct arithmetic question",
        complexity: "simple",
        lowStakes: true,
      },
      curator,
    );

    expect(result).toMatchObject({
      retrieved: false,
      skippedReason: "simple_low_stakes_direct_execution",
      experiences: [],
    });
    expect(curator.retrieveRelevant).not.toHaveBeenCalled();
  });

  it("preserves taint and never lets retrieved experiences override current user requirements, policy, or validated evidence", async () => {
    const controller = new ExperienceReplayLearningController();
    const curator = { retrieveRelevant: vi.fn().mockResolvedValue([freshExperience]) };

    const result = await controller.assembleContext(
      {
        id: "task-taint",
        description: "Reuse prior work cautiously",
        complexity: "nontrivial",
        currentRequirements: ["use the new endpoint, not old examples"],
        currentEvidenceRefs: ["evt-current-api-doc"],
        policyRefs: ["policy-current"],
      },
      curator,
    );

    expect(result.experiences[0]).toMatchObject({
      taint: "untrusted",
      advisoryOnly: true,
      provenance: { eventRefs: ["evt-old-1", "evt-old-2"] },
      cannotOverride: ["current_user_requirements", "policy", "validated_current_evidence"],
    });
    expect(result.advisoryBlock?.delimitedText).toContain("must not override current user requirements, policy, or validated current evidence");
    expect(result.advisoryBlock?.currentRequirements).toEqual(["use the new endpoint, not old examples"]);
  });

  it("adapts experiences only after checking preconditions and does not copy stale tool arguments or URLs", () => {
    const controller = new ExperienceReplayLearningController();

    const missingPrecondition = controller.adaptExperience(freshExperience, {
      satisfiedPreconditions: [],
      currentEvidenceRefs: ["evt-current-doc"],
    });
    expect(missingPrecondition.preconditionsSatisfied).toBe(false);
    expect(missingPrecondition.reusableTactics).toEqual([]);

    const adapted = controller.adaptExperience(freshExperience, {
      satisfiedPreconditions: ["repo_has_vitest"],
      currentEvidenceRefs: ["evt-current-doc"],
    });
    expect(adapted.preconditionsSatisfied).toBe(true);
    expect(adapted.reusableTactics).toEqual(["run focused test before broad suite"]);
    expect(adapted.copiedStaleToolArguments).toBe(false);
    expect(adapted.toolActionsToRecreateFresh).toEqual([
      {
        tool: "browser.open",
        requiresFreshArguments: true,
        originalArgsCopied: false,
        originalUrlCopied: false,
      },
    ]);
    expect(JSON.stringify(adapted)).not.toContain("old.example.invalid");
    expect(JSON.stringify(adapted)).not.toContain("stale");
    expect(adapted.consequentialStepsRequireValidationAgainst).toContain("validated_current_evidence");
  });

  it("runs a bounded post-task learning pass after success, structured failure, or correction exhaustion when budget permits", async () => {
    const controller = new ExperienceReplayLearningController();
    const curator = { recordExperience: vi.fn() };
    const heldoutVerifier = { verify: vi.fn().mockResolvedValue({ passed: true }) };
    const skillLibrary = { addSkill: vi.fn() };

    await controller.runPostTaskLearning(successfulTrace(), { curator, heldoutVerifier, skillLibrary });
    await controller.runPostTaskLearning(
      successfulTrace({ id: "trace-fail", status: "failure", failureReasons: ["tests_failed"] }),
      { curator, heldoutVerifier, skillLibrary },
    );
    await controller.runPostTaskLearning(
      successfulTrace({
        id: "trace-exhausted",
        status: "correction_exhausted",
        failureReasons: ["retry_budget_exhausted"],
        correctionAttemptsExhausted: true,
      }),
      { curator, heldoutVerifier, skillLibrary },
    );

    expect(curator.recordExperience).toHaveBeenCalledWith(expect.objectContaining({ kind: "success_case" }));
    expect(curator.recordExperience).toHaveBeenCalledWith(expect.objectContaining({ kind: "anti_pattern", traceId: "trace-fail" }));
    expect(curator.recordExperience).toHaveBeenCalledWith(expect.objectContaining({ kind: "anti_pattern", traceId: "trace-exhausted" }));
  });

  it("allows successful traces to produce skill candidates only when criterion-linked event_refs exist", async () => {
    const controller = new ExperienceReplayLearningController();
    const curator = { recordExperience: vi.fn() };
    const heldoutVerifier = { verify: vi.fn().mockResolvedValue({ passed: true }) };
    const skillLibrary = { addSkill: vi.fn() };

    const missingRefs = await controller.runPostTaskLearning(
      successfulTrace({ id: "trace-no-refs", successCriteria: [{ id: "tests-pass", eventRefs: [] }] }),
      { curator, heldoutVerifier, skillLibrary },
    );
    expect(missingRefs.skippedPromotionReason).toBe("missing_criterion_linked_event_refs");
    expect(heldoutVerifier.verify).not.toHaveBeenCalled();
    expect(skillLibrary.addSkill).not.toHaveBeenCalled();

    const withRefs = await controller.runPostTaskLearning(successfulTrace({ id: "trace-with-refs" }), {
      curator,
      heldoutVerifier,
      skillLibrary,
    });
    expect(withRefs.promotionCandidate).toMatchObject({
      sourceTraceId: "trace-with-refs",
      sourceEventRefs: ["evt-test"],
      outcomeVerifiedByCriteria: true,
    });
    expect(skillLibrary.addSkill).toHaveBeenCalledWith(expect.objectContaining({ sourceTraceId: "trace-with-refs" }));
  });

  it("turns failed traces into anti-pattern experiences and never procedural skills", async () => {
    const controller = new ExperienceReplayLearningController();
    const curator = { recordExperience: vi.fn() };
    const heldoutVerifier = { verify: vi.fn() };
    const skillLibrary = { addSkill: vi.fn() };

    const result = await controller.runPostTaskLearning(
      successfulTrace({ id: "trace-failed-only", status: "failure", failureReasons: ["assertion_mismatch"] }),
      { curator, heldoutVerifier, skillLibrary },
    );

    expect(result).toMatchObject({ antiPatternRecorded: true, promoted: false, promotionAttempted: false });
    expect(curator.recordExperience).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "anti_pattern", failureReasons: ["assertion_mismatch"] }),
    );
    expect(heldoutVerifier.verify).not.toHaveBeenCalled();
    expect(skillLibrary.addSkill).not.toHaveBeenCalled();
  });

  it("does not add promotion candidates to skill_library unless heldout_verifier passes and no reward_hacking_signals block promotion", async () => {
    const controller = new ExperienceReplayLearningController();
    const curator = { recordExperience: vi.fn() };
    const skillLibrary = { addSkill: vi.fn() };

    await controller.runPostTaskLearning(
      successfulTrace({ id: "trace-reward", rewardHackingSignals: ["criterion_satisfied_by_mock_only"] }),
      { curator, heldoutVerifier: { verify: vi.fn().mockResolvedValue({ passed: true }) }, skillLibrary },
    );
    expect(skillLibrary.addSkill).not.toHaveBeenCalled();
    expect(curator.recordExperience).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "anti_pattern", rewardHackingSignals: ["criterion_satisfied_by_mock_only"] }),
    );

    await controller.runPostTaskLearning(successfulTrace({ id: "trace-verifier-reward" }), {
      curator,
      heldoutVerifier: { verify: vi.fn().mockResolvedValue({ passed: true, rewardHackingSignals: ["overfit_fixture"] }) },
      skillLibrary,
    });
    expect(skillLibrary.addSkill).not.toHaveBeenCalled();

    await controller.runPostTaskLearning(successfulTrace({ id: "trace-pass" }), {
      curator,
      heldoutVerifier: { verify: vi.fn().mockResolvedValue({ passed: true }) },
      skillLibrary,
    });
    expect(skillLibrary.addSkill).toHaveBeenCalledWith(expect.objectContaining({ sourceTraceId: "trace-pass" }));
  });

  it("records a failed held-out promotion once and does not retry without candidate changes", async () => {
    const controller = new ExperienceReplayLearningController();
    const curator = { recordExperience: vi.fn() };
    const heldoutVerifier = { verify: vi.fn().mockResolvedValue({ passed: false, details: "fails on held-out repo" }) };
    const skillLibrary = { addSkill: vi.fn() };
    const trace = successfulTrace({ id: "trace-heldout-fail" });

    const first = await controller.runPostTaskLearning(trace, { curator, heldoutVerifier, skillLibrary });
    const second = await controller.runPostTaskLearning(trace, { curator, heldoutVerifier, skillLibrary });

    expect(first).toMatchObject({ promotionAttempted: true, promoted: false, antiPatternRecorded: true });
    expect(second).toMatchObject({
      promotionAttempted: false,
      promoted: false,
      skippedPromotionReason: "previous_heldout_failure_for_same_candidate",
    });
    expect(heldoutVerifier.verify).toHaveBeenCalledTimes(1);
    expect(curator.recordExperience.mock.calls.filter(([record]) => record.kind === "anti_pattern")).toHaveLength(1);
    expect(skillLibrary.addSkill).not.toHaveBeenCalled();

    await controller.runPostTaskLearning(
      successfulTrace({
        id: "trace-heldout-fail-changed",
        skillCandidate: {
          name: "Validate focused behavior changes",
          description: "Materially changed candidate with an extra independent validation step.",
          steps: ["identify contract", "run focused test", "run independent held-out scenario"],
        },
      }),
      { curator, heldoutVerifier, skillLibrary },
    );
    expect(heldoutVerifier.verify).toHaveBeenCalledTimes(2);
  });
});
