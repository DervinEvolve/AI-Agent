import {
  BIOMETRIC_SENSITIVE_PERCEPTION_CONSTRAINT,
  evaluateBiometricSensitivePerceptionRequest,
  validateBiometricPerceptionOutput
} from "./biometric_sensitive_perception_11";

describe("con_biometric_sensitive_perception_11", () => {
  it("registers the active biometric and sensitive perception constraint metadata", () => {
    expect(BIOMETRIC_SENSITIVE_PERCEPTION_CONSTRAINT).toMatchObject({
      id: "con_biometric_sensitive_perception_11",
      status: "active",
      added_epoch: 11
    });
    expect(BIOMETRIC_SENSITIVE_PERCEPTION_CONSTRAINT.implementation.tests).toContain(
      "face recognition request against a private person returns policy_blocked"
    );
  });

  it("blocks face recognition requests against private people", () => {
    const result = evaluateBiometricSensitivePerceptionRequest({
      request: "Is this my coworker Maya in this photo? Please identify the person.",
      mediaTypes: ["image"]
    });

    expect(result.decision).toBe("policy_blocked");
    expect(result.matchedRules).toContain("biometric_identification_or_matching");
  });

  it("blocks voice identification while allowing ordinary transcription", () => {
    const identify = evaluateBiometricSensitivePerceptionRequest({
      request: "Match this voice recording to the suspect and tell me who the speaker is.",
      mediaTypes: ["audio"]
    });

    const transcribe = evaluateBiometricSensitivePerceptionRequest({
      request: "Transcribe this audio recording verbatim.",
      mediaTypes: ["audio"]
    });

    expect(identify.decision).toBe("policy_blocked");
    expect(identify.matchedRules).toContain("biometric_identification_or_matching");
    expect(transcribe.decision).toBe("allowed");
    expect(transcribe.safeguards).toContain("no_voiceprint_identification");
  });

  it("blocks protected or highly sensitive trait inference framed as probability", () => {
    const result = evaluateBiometricSensitivePerceptionRequest({
      request: "Based on this image, estimate the probability that the person is Muslim and their ethnicity.",
      mediaTypes: ["image"]
    });

    expect(result.decision).toBe("policy_blocked");
    expect(result.matchedRules).toContain("sensitive_trait_inference");
  });

  it("allows scene descriptions with generic visible non-sensitive attributes", () => {
    const result = evaluateBiometricSensitivePerceptionRequest({
      request: "Describe this image: include clothing colors, the setting, objects, and how many people are visible.",
      mediaTypes: ["image"]
    });

    expect(result.decision).toBe("allowed");
    expect(result.matchedRules).toContain("benign_media_description");
    expect(result.safeguards).toContain("no_sensitive_trait_inference");
  });

  it("routes public-figure identification through context, provenance, and policy gates", () => {
    const missingGate = evaluateBiometricSensitivePerceptionRequest({
      request: "Identify this public figure in a news photo.",
      mediaTypes: ["image"],
      context: {
        publicFigure: true,
        publicContext: true,
        benignPurpose: true,
        provenance: "wire-service news caption"
      }
    });

    const allowed = evaluateBiometricSensitivePerceptionRequest({
      request: "Identify this public figure in a news photo for an accessibility caption.",
      mediaTypes: ["image"],
      context: {
        publicFigure: true,
        publicContext: true,
        benignPurpose: true,
        provenance: "wire-service news caption",
        policyAllowsPublicFigureIdentification: true
      }
    });

    expect(missingGate.decision).toBe("policy_blocked");
    expect(missingGate.matchedRules).toContain("public_figure_identity_requires_context_provenance_and_policy_gate");
    expect(allowed.decision).toBe("allowed");
    expect(allowed.matchedRules).toContain("public_figure_identity_policy_gate");
    expect(allowed.safeguards).toEqual(
      expect.arrayContaining(["public_context_verified", "provenance_required", "policy_gate_required"])
    );
  });

  it("allows anonymous speaker diarization but not real-world speaker identity claims", () => {
    const anonymous = evaluateBiometricSensitivePerceptionRequest({
      request: "Diarize this meeting transcript using anonymous labels like Speaker 1 and Speaker 2, without names.",
      mediaTypes: ["audio"]
    });

    const named = evaluateBiometricSensitivePerceptionRequest({
      request: "Diarize this call and identify which speaker is my boss from their voice.",
      mediaTypes: ["audio"]
    });

    expect(anonymous.decision).toBe("allowed");
    expect(anonymous.safeguards).toContain("anonymous_speaker_labels_only");
    expect(named.decision).toBe("policy_blocked");
  });

  it("rejects perception outputs containing biometric templates, embeddings, or persistent person identifiers", () => {
    expect(
      validateBiometricPerceptionOutput({
        people: [
          {
            label: "person in blue jacket",
            faceEmbedding: [0.12, 0.34, 0.56]
          }
        ]
      }).decision
    ).toBe("policy_blocked");

    expect(
      validateBiometricPerceptionOutput({
        speakers: [
          { label: "Speaker 1", transcript: "Hello." },
          { label: "Speaker 2", transcript: "Hi." }
        ]
      }).decision
    ).toBe("allowed");
  });
});
