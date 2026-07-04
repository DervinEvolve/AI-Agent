import {
  TracePolicyViolation,
  assertEvaluatorUseAllowed,
  assertTraceDoesNotSetToolArguments,
  assertTraceLessonMemoryWriteAllowed,
  assertTraceSkillPromotionAllowed,
  conTracePrivacyAndNonAuthority18,
  deriveTraceLessonCandidate,
  evaluateTraceTelemetry,
  exportTraceTelemetry,
  persistTraceTelemetry,
  replayTraceTelemetry,
  suggestTraceDerivedSkill,
} from "./con_trace_privacy_and_non_authority_18";

describe("con_trace_privacy_and_non_authority_18", () => {
  it("declares the active trace telemetry privacy constraint", () => {
    expect(conTracePrivacyAndNonAuthority18.id).toBe("con_trace_privacy_and_non_authority_18");
    expect(conTracePrivacyAndNonAuthority18.status).toBe("active");
  });

  it("rejects exact vault-held secret bytes in trace persistence with policy_blocked hard termination", () => {
    const vaultSecret = "vault-live-secret-6f8c20e2";

    try {
      persistTraceTelemetry({
        scope: "session-a",
        allowedScopes: ["session-a"],
        vaultSecretBytes: [vaultSecret],
        trace: {
          thought: "summarize tool output",
          logLine: `adapter returned ${vaultSecret}`,
        },
      });
      throw new Error("expected policy violation");
    } catch (error) {
      expect(error).toBeInstanceOf(TracePolicyViolation);
      expect((error as TracePolicyViolation).code).toBe("policy_blocked");
      expect((error as TracePolicyViolation).hardTerminate).toBe(true);
    }
  });

  it("redacts raw secrets, OAuth tokens, private keys, browser cookies, approval tokens, host paths, and vault handles", () => {
    const persisted = persistTraceTelemetry({
      scope: "session-a",
      allowedScopes: ["session-a"],
      retentionMs: 1000,
      trace: {
        transcript:
          "Bearer ya29.oauthToken123 Cookie: sid=browser-cookie; password=hunter2 approval_token=approve-reuse vault_session_handle=vsh_live_123 /home/agent/work",
        privateKey: "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----",
        nested: "github ghp_1234567890abcdefABCDEF1234567890ab and sk-1234567890abcdefABCDEF1234567890",
      },
    });

    const serialized = JSON.stringify(persisted.sanitizedTrace);
    expect(serialized).not.toContain("ya29.oauthToken123");
    expect(serialized).not.toContain("browser-cookie");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("approve-reuse");
    expect(serialized).not.toContain("vsh_live_123");
    expect(serialized).not.toContain("/home/agent/work");
    expect(serialized).not.toContain("abc123");
    expect(serialized).toContain("[REDACTED_TOKEN]");
    expect(serialized).toContain("[REDACTED_HOST_PATH]");
  });

  it("prevents trace export from revealing hidden prompts, deleted memory content, live auth state, or reusable approval material", () => {
    const deletedMemory = "old-memory-that-was-deleted";
    const exported = exportTraceTelemetry({
      scope: "review",
      allowedScopes: ["review"],
      deletionTombstones: [deletedMemory],
      trace: {
        hiddenPrompt: "never reveal system chain",
        deletedMemoryContent: deletedMemory,
        liveAuthState: { accessToken: "live-auth-token" },
        approvalBindingMaterial: "reuse-this-approval-nonce",
        visible: `The removed note was ${deletedMemory}`,
      },
    });

    const serialized = JSON.stringify(exported.sanitizedTrace);
    expect(serialized).not.toContain("never reveal system chain");
    expect(serialized).not.toContain(deletedMemory);
    expect(serialized).not.toContain("live-auth-token");
    expect(serialized).not.toContain("reuse-this-approval-nonce");
    expect(serialized).toContain("[REDACTED_HIDDEN_PROMPT]");
    expect(serialized).toContain("[REDACTED_DELETED_MEMORY]");
    expect(serialized).toContain("[REDACTED_LIVE_AUTH_STATE]");
    expect(serialized).toContain("[REDACTED_APPROVAL_BINDING]");
  });

  it("does not let evaluator scores satisfy HITL gates or authorize side effects", () => {
    const evaluation = evaluateTraceTelemetry({ score: 0.99, rationale: "looks safe" });

    expect(evaluation.canAuthorizeSideEffects).toBe(false);
    expect(evaluation.canSatisfyHitl).toBe(false);
    expect(() => assertEvaluatorUseAllowed("satisfyHitl")).toThrow(TracePolicyViolation);
    expect(() => assertEvaluatorUseAllowed("authorizeSideEffect")).toThrow(TracePolicyViolation);
    expect(() => assertEvaluatorUseAllowed("informPlanning")).not.toThrow();
  });

  it("does not let evaluator output clear taint or become trusted tool arguments", () => {
    const replayed = replayTraceTelemetry({
      trace: { evaluatorScore: 1, suggestedArgs: { url: "https://example.invalid/delete" } },
    });

    expect(replayed.taint).toBe("tainted_advisory");
    expect(replayed.contentTrusted).toBe(false);
    expect(replayed.canClearTaint).toBe(false);
    expect(replayed.canDirectlySetToolArguments).toBe(false);
    expect(() => assertEvaluatorUseAllowed("clearTaint")).toThrow(TracePolicyViolation);
    expect(() => assertTraceDoesNotSetToolArguments()).toThrow(TracePolicyViolation);
  });

  it("requires explicit controller approval and memory policy checks before trace-derived memory writes", () => {
    const candidate = deriveTraceLessonCandidate({ observation: "prefer smaller batches" });

    expect(candidate.taint).toBe("tainted_advisory");
    expect(candidate.directWriteAllowed).toBe(false);
    expect(candidate.requiresControllerApproval).toBe(true);
    expect(candidate.requiresMemoryPolicyCheck).toBe(true);
    expect(() =>
      assertTraceLessonMemoryWriteAllowed(candidate, {
        controllerApproved: false,
        memoryPolicyAllowed: true,
      }),
    ).toThrow(TracePolicyViolation);
    expect(() =>
      assertTraceLessonMemoryWriteAllowed(candidate, {
        controllerApproved: true,
        memoryPolicyAllowed: true,
      }),
    ).not.toThrow();
  });

  it("requires cap_procedural_memory_skill_library_14 verification before trace-derived skill promotion", () => {
    const suggestion = suggestTraceDerivedSkill({ patch: "try a retry wrapper" });

    expect(suggestion.taint).toBe("tainted_advisory");
    expect(suggestion.directPromotionAllowed).toBe(false);
    expect(suggestion.requiresCapProceduralMemorySkillLibrary14Verification).toBe(true);
    expect(() =>
      assertTraceSkillPromotionAllowed(suggestion, {
        verifiedByCapProceduralMemorySkillLibrary14: false,
      }),
    ).toThrow(TracePolicyViolation);
    expect(() =>
      assertTraceSkillPromotionAllowed(suggestion, {
        verifiedByCapProceduralMemorySkillLibrary14: true,
      }),
    ).not.toThrow();
  });

  it("marks every resumed trace as tainted advisory evidence", () => {
    const replayed = replayTraceTelemetry({
      trace: { priorRunSaid: "the API approved this" },
    });

    expect(replayed.taint).toBe("tainted_advisory");
    expect(replayed.contentTrusted).toBe(false);
    expect(replayed.canOverridePolicy).toBe(false);
    expect(replayed.canDirectlyWriteMemory).toBe(false);
    expect(replayed.canDirectlyPromoteSkills).toBe(false);
  });

  it("enforces scope allowlists and retention limits before persistence", () => {
    expect(() =>
      persistTraceTelemetry({
        scope: "other-session",
        allowedScopes: ["current-session"],
        trace: "benign",
      }),
    ).toThrow(TracePolicyViolation);

    expect(() =>
      persistTraceTelemetry({
        scope: "current-session",
        allowedScopes: ["current-session"],
        retentionMs: 10_001,
        maxRetentionMs: 10_000,
        trace: "benign",
      }),
    ).toThrow(TracePolicyViolation);
  });
});
