import {
  PERCEPTION_FORBIDDEN_CALLERS,
  cap_multimodal_perception_11 as cap,
  isTaskScopedArtifactRef,
  validatePerceptionAnalyzeInput,
} from "../cap_multimodal_perception_11";

describe("cap_multimodal_perception_11 security contract", () => {
  it("accepts only finalized task-scoped artifact refs and rejects paths or URLs", () => {
    for (const ref of [
      "artifact:task:image_001",
      "upload:photo-1",
      "browser-artifact:screenshot_abc",
      "document-artifact:page_1",
      "run-python-artifact:plot_png",
    ]) {
      expect(isTaskScopedArtifactRef(ref)).toBe(true);
      expect(validatePerceptionAnalyzeInput({ action: "image_describe", artifact_ref: ref }).ok).toBe(true);
    }

    for (const ref of [
      "/etc/passwd",
      "C:\\Users\\agent\\secret.png",
      "file:///tmp/image.png",
      "https://example.test/image.png",
      "data:image/png;base64,AAAA",
      "host:/var/lib/agent/artifacts/image.png",
      "artifact:task:draft:123",
      "artifact:task:../secret",
      "artifact:task:pending_upload",
    ]) {
      expect(isTaskScopedArtifactRef(ref)).toBe(false);
      const result = validatePerceptionAnalyzeInput({ action: "image_describe", artifact_ref: ref });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.status).toBe("policy_blocked");
        expect(result.failure.error?.code).toBe("artifact_ref_not_allowed");
        expect(result.failure.tainted).toBe(true);
      }
    }
  });

  it("keeps perception_analyze behind the host-controller adapter boundary", () => {
    expect(cap.interface.tool_name).toBe("perception_analyze");
    expect(cap.security.boundary.adapter).toBe("host-controller");
    expect(cap.security.boundary.accepts_host_paths).toBe(false);
    expect(cap.security.boundary.accepts_raw_urls).toBe(false);

    for (const caller of PERCEPTION_FORBIDDEN_CALLERS) {
      const result = validatePerceptionAnalyzeInput(
        { action: "image_describe", artifact_ref: "artifact:task:image_001" },
        { caller },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.status).toBe("policy_blocked");
        expect(result.failure.error?.code).toBe("caller_not_authorized");
      }
    }

    expect(
      validatePerceptionAnalyzeInput(
        { action: "image_describe", artifact_ref: "artifact:task:image_001" },
        { caller: "host_controller" },
      ).ok,
    ).toBe(true);
  });

  it("fails closed before dispatch when unified budget reservation cannot cover the request", () => {
    const result = validatePerceptionAnalyzeInput(
      {
        action: "video_sample_frames",
        artifact_ref: "artifact:task:clip_001",
        sampling_options: { max_frames: 8, strategy: "uniform" },
        max_output_bytes: 1024,
      },
      {
        budget: {
          wallClockMs: 30_000,
          providerTokens: 1_000,
          inputBytes: 10_000_000,
          outputBytes: 2_048,
          artifacts: 2,
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.status).toBe("budget_exhausted");
      expect(result.failure.error?.code).toBe("budget_reservation_failed");
      expect(result.failure.provenance.provider.id).toBe("not_dispatched");
      expect(result.failure.provenance.action_trace).toContain("return_budget_exhausted");
    }
  });

  it("blocks disallowed biometric, speaker identity, sensitive trait, and restricted media workflows", () => {
    const cases = [
      {
        input: {
          action: "image_qa" as const,
          artifact_ref: "artifact:task:face_001",
          question: "Who is this person? Identify the face in the image.",
        },
        code: "private_person_identification",
      },
      {
        input: {
          action: "image_qa" as const,
          artifact_ref: "artifact:task:portrait_001",
          question: "Infer this person's religion and ethnicity from appearance.",
        },
        code: "sensitive_trait_inference",
      },
      {
        input: {
          action: "audio_transcribe" as const,
          artifact_ref: "artifact:task:call_001",
          question: "Transcribe this and identify the speaker by voiceprint.",
        },
        code: "speaker_identity_recognition",
      },
      {
        input: {
          action: "video_summarize" as const,
          artifact_ref: "artifact:task:cctv_001",
          question: "Use this video for liveness and legal identity verification.",
        },
        code: "restricted_media_workflow",
      },
    ];

    for (const { input, code } of cases) {
      const result = validatePerceptionAnalyzeInput(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.status).toBe("policy_blocked");
        expect(result.failure.error?.code).toBe(code);
        expect(result.failure.safety_annotations.biometric_identification_performed).toBe(false);
        expect(result.failure.safety_annotations.sensitive_trait_inference_performed).toBe(false);
      }
    }
  });
});
