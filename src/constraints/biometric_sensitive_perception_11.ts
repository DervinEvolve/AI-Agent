export type BiometricSensitivePerceptionDecision = "allowed" | "policy_blocked";

export type MediaType = "image" | "audio" | "video" | "document" | "unknown";

export interface PublicFigurePerceptionContext {
  /** True only when the person is already being treated as a public figure for the request. */
  publicFigure?: boolean;
  /** True for public-interest/public-source settings such as a news photo, press conference, or official archive. */
  publicContext?: boolean;
  /** True when the task is informational/accessibility-oriented rather than targeting, harassment, or verification. */
  benignPurpose?: boolean;
  /** Source/provenance supporting why public-figure identification is appropriate in this context. */
  provenance?: string | readonly string[];
  /** Result of the caller's broader identity/public-figure policy gate. */
  policyAllowsPublicFigureIdentification?: boolean;
}

export interface BiometricSensitivePerceptionRequest {
  request: string;
  mediaTypes?: readonly MediaType[];
  context?: PublicFigurePerceptionContext;
  /** Optional candidate perception output to validate before it is returned or persisted. */
  proposedOutput?: unknown;
}

export interface BiometricSensitivePerceptionResult {
  decision: BiometricSensitivePerceptionDecision;
  reason: string;
  matchedRules: string[];
  safeguards: string[];
}

export const BIOMETRIC_SENSITIVE_PERCEPTION_CONSTRAINT = {
  id: "con_biometric_sensitive_perception_11",
  name: "No biometric identification or sensitive trait inference from media",
  status: "active",
  added_epoch: 11,
  description:
    "The agent must not identify private persons in images, audio, or video; perform face recognition, voiceprint recognition, gait recognition, liveness verification, or biometric matching; or infer protected or highly sensitive traits such as race, ethnicity, religion, sexual orientation, political affiliation, disability, health status, emotional state as a definitive fact, or socioeconomic status from appearance or voice. It may describe non-sensitive visible attributes, transcribe speech, summarize scenes, count visible people, and identify public figures only when the user request is benign, the context is public, and policy allows it. Speaker diarization may use anonymous labels such as Speaker 1, but must not claim real-world speaker identity. Any request for surveillance targeting, identity verification, doxxing, or consequential decisions about a person from media returns policy_blocked.",
  implementation: {
    tests: [
      "face recognition request against a private person returns policy_blocked",
      "voice identification request returns policy_blocked while ordinary transcription succeeds",
      "request to infer protected trait from an image returns policy_blocked",
      "scene description with generic visible non-sensitive attributes is allowed",
      "public-figure identification in a benign news/photo context is routed through policy checks and provenance requirements",
      "speaker diarization uses anonymous speaker labels only",
      "perception outputs never include biometric templates, embeddings, or persistent person identifiers"
    ]
  }
} as const;

const BIOMETRIC_OUTPUT_KEY_PATTERN =
  /(?:biometric|faceprint|voiceprint|gaitprint|template|embedding|vector|faceId|voiceId|personId|persistentPersonId|persistent_id|identityId)/i;
const BIOMETRIC_OUTPUT_VALUE_PATTERN =
  /\b(?:faceprint|voiceprint|biometric template|biometric embedding|persistent person id|watchlist match)\b/i;

const DIRECT_IDENTITY_PATTERNS: readonly RegExp[] = [
  /\b(?:who\s+is|identify|name|recognize|recognise)\b[\s\S]{0,80}\b(?:this|that|the)\b[\s\S]{0,80}\b(?:person|man|woman|child|face|speaker|voice|individual|suspect|employee|customer)\b/i,
  /\b(?:is|are)\s+(?:this|that|the)\b[\s\S]{0,80}\b(?:my\s+)?(?:coworker|co-worker|boss|employee|neighbor|neighbour|friend|relative|suspect|customer|student|patient)\b/i,
  /\b(?:face|facial|voice|speaker|gait)\s+(?:recognition|identification|verification|authentication|matching|match)\b/i,
  /\b(?:match|compare|verify|authenticate)\b[\s\S]{0,80}\b(?:face|photo|image|voice|audio|speaker|gait|biometric)\b/i,
  /\b(?:match|compare|verify|authenticate)\b[\s\S]{0,80}\b(?:suspect|watchlist|database|records?|account|identity)\b/i,
  /\b(?:liveness|proof\s+of\s+life|anti-spoof|antispoof)\b[\s\S]{0,80}\b(?:check|verification|test|detection|score)?\b/i,
  /\b(?:doxx|dox|unmask|de-anonymi[sz]e|real\s+name|home\s+address)\b/i
];

const BIOMETRIC_TEMPLATE_PATTERNS: readonly RegExp[] = [
  /\b(?:create|extract|generate|store|save|return|compute)\b[\s\S]{0,80}\b(?:faceprint|voiceprint|biometric\s+(?:template|embedding|vector)|face\s+embedding|voice\s+embedding|gait\s+signature)\b/i,
  /\b(?:persistent|stable|unique)\b[\s\S]{0,80}\b(?:person|face|speaker|voice|biometric)?\s*(?:id|identifier|embedding|template)\b/i,
  /\btrack\b[\s\S]{0,100}\b(?:same\s+person|people|faces|speakers)\b[\s\S]{0,100}\b(?:across|between|over\s+time|camera|videos?|recordings?)\b/i,
  /\b(?:surveillance|watchlist|blacklist|denylist)\b[\s\S]{0,80}\b(?:face|voice|biometric|match|identify|track)\b/i
];

const SENSITIVE_TRAIT_PATTERNS: readonly RegExp[] = [
  /\b(?:race|racial\s+background|ethnicity|ethnic\s+background|nationality\s+from\s+(?:appearance|face|voice))\b/i,
  /\b(?:religion|religious\s+affiliation|muslim|christian|jewish|hindu|buddhist)\b/i,
  /\b(?:sexual\s+orientation|gay|lesbian|bisexual|straight|transgender|trans)\b/i,
  /\b(?:political\s+(?:affiliation|beliefs?|party)|republican|democrat|socialist|communist|liberal|conservative)\b/i,
  /\b(?:disabled|disability|autistic|neurodivergent|mental\s+(?:illness|health)|depressed|anxious|ptsd|addict(?:ed|ion)?)\b/i,
  /\b(?:health\s+status|medical\s+condition|sick|disease|hiv|pregnant|pregnancy|cancer)\b/i,
  /\b(?:socioeconomic\s+status|income\s+level|social\s+class|working\s+class|upper\s+class|poor|rich|wealthy)\b/i,
  /\b(?:probability|odds|likelihood|likely|guess|infer|determine|tell\s+me)\b[\s\S]{0,100}\b(?:race|ethnicity|religion|sexual\s+orientation|political|disabled|disability|health|income|socioeconomic|poor|rich)\b/i
];

const DEFINITIVE_EMOTION_PATTERNS: readonly RegExp[] = [
  /\b(?:is|are|was|were)\b[\s\S]{0,50}\b(?:angry|sad|happy|depressed|anxious|afraid|scared|upset|hostile|violent|unstable)\b/i,
  /\b(?:what|which)\b[\s\S]{0,40}\b(?:emotion|mood|mental\s+state)\b/i,
  /\b(?:tell|determine|infer|diagnose)\b[\s\S]{0,80}\b(?:emotion|mood|mental\s+state|angry|sad|happy|depressed|anxious)\b/i
];

const TRANSCRIPTION_OR_ANONYMOUS_DIARIZATION_PATTERNS: readonly RegExp[] = [
  /\b(?:transcribe|transcription|caption|subtitles?)\b/i,
  /\b(?:diari[sz]e|speaker\s+diari[sz]ation|split\s+by\s+speaker|label\s+speakers?)\b[\s\S]{0,80}\b(?:speaker\s*1|speaker\s*2|anonymous|without\s+identifying|no\s+names?)?\b/i
];

const BENIGN_MEDIA_ANALYSIS_PATTERNS: readonly RegExp[] = [
  /\b(?:describe|summari[sz]e|what\s+is\s+happening|scene|alt\s*text|caption)\b/i,
  /\b(?:count|how\s+many)\b[\s\S]{0,40}\b(?:people|persons|faces|speakers)\b/i,
  /\b(?:clothing|shirt|jacket|hat|color|colour|visible\s+attributes?|objects?|background|setting)\b/i
];

const PUBLIC_FIGURE_ID_PATTERNS: readonly RegExp[] = [
  /\b(?:public\s+figure|celebrity|politician|head\s+of\s+state|public\s+official)\b/i,
  /\b(?:news\s+photo|press\s+conference|official\s+photo|public\s+event|archive\s+footage)\b/i
];

function normalize(request: string): string {
  return request.replace(/\s+/g, " ").trim();
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function hasPublicFigureRoute(input: BiometricSensitivePerceptionRequest, text: string): boolean {
  const context = input.context;
  const requestClaimsPublicFigure = matchesAny(text, PUBLIC_FIGURE_ID_PATTERNS);
  const hasProvenance =
    typeof context?.provenance === "string"
      ? context.provenance.trim().length > 0
      : Array.isArray(context?.provenance) && context.provenance.length > 0;

  return Boolean(
    (context?.publicFigure || requestClaimsPublicFigure) &&
      context?.publicContext &&
      context?.benignPurpose &&
      context?.policyAllowsPublicFigureIdentification &&
      hasProvenance
  );
}

function isPublicFigureIdentificationAttempt(input: BiometricSensitivePerceptionRequest, text: string): boolean {
  return Boolean((input.context?.publicFigure || matchesAny(text, PUBLIC_FIGURE_ID_PATTERNS)) && /\b(?:identify|who\s+is|name|recognize|recognise)\b/i.test(text));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function outputContainsBiometricArtifact(value: unknown, path: string[] = []): boolean {
  if (typeof value === "string") {
    return BIOMETRIC_OUTPUT_VALUE_PATTERN.test(value);
  }

  if (Array.isArray(value)) {
    return value.some((entry, index) => outputContainsBiometricArtifact(entry, [...path, String(index)]));
  }

  if (!isPlainRecord(value)) {
    return false;
  }

  return Object.entries(value).some(([key, nested]) => {
    const nextPath = [...path, key];
    const pathText = nextPath.join(".");
    if (BIOMETRIC_OUTPUT_KEY_PATTERN.test(key) || BIOMETRIC_OUTPUT_KEY_PATTERN.test(pathText)) {
      return true;
    }
    return outputContainsBiometricArtifact(nested, nextPath);
  });
}

export function validateBiometricPerceptionOutput(proposedOutput: unknown): BiometricSensitivePerceptionResult {
  if (outputContainsBiometricArtifact(proposedOutput)) {
    return {
      decision: "policy_blocked",
      reason: "Perception outputs must not expose biometric templates, embeddings, or persistent person identifiers.",
      matchedRules: ["biometric_output_artifact"],
      safeguards: []
    };
  }

  return {
    decision: "allowed",
    reason: "The proposed output does not contain biometric templates, embeddings, or persistent person identifiers.",
    matchedRules: [],
    safeguards: ["anonymous_speaker_labels_only", "no_persistent_person_identifiers"]
  };
}

export function evaluateBiometricSensitivePerceptionRequest(
  input: BiometricSensitivePerceptionRequest
): BiometricSensitivePerceptionResult {
  const text = normalize(input.request);

  if (input.proposedOutput !== undefined) {
    const outputValidation = validateBiometricPerceptionOutput(input.proposedOutput);
    if (outputValidation.decision === "policy_blocked") {
      return outputValidation;
    }
  }

  const matchedRules: string[] = [];

  if (matchesAny(text, BIOMETRIC_TEMPLATE_PATTERNS)) {
    matchedRules.push("biometric_template_or_persistent_identifier");
  }

  if (matchesAny(text, DIRECT_IDENTITY_PATTERNS)) {
    matchedRules.push("biometric_identification_or_matching");
  }

  if (matchesAny(text, SENSITIVE_TRAIT_PATTERNS)) {
    matchedRules.push("sensitive_trait_inference");
  }

  if (matchesAny(text, DEFINITIVE_EMOTION_PATTERNS)) {
    matchedRules.push("definitive_emotional_or_mental_state_inference");
  }

  if (isPublicFigureIdentificationAttempt(input, text)) {
    if (hasPublicFigureRoute(input, text)) {
      return {
        decision: "allowed",
        reason:
          "Public-figure identification may proceed only because the request is benign, public-context, provenance-backed, and allowed by the broader policy gate.",
        matchedRules: ["public_figure_identity_policy_gate"],
        safeguards: ["public_context_verified", "benign_purpose_verified", "provenance_required", "policy_gate_required"]
      };
    }

    matchedRules.push("public_figure_identity_requires_context_provenance_and_policy_gate");
  }

  if (matchedRules.length > 0) {
    return {
      decision: "policy_blocked",
      reason:
        "Requests for biometric identification, biometric matching, sensitive trait inference, surveillance targeting, identity verification, or consequential media-based decisions are not allowed.",
      matchedRules: [...new Set(matchedRules)],
      safeguards: []
    };
  }

  if (matchesAny(text, TRANSCRIPTION_OR_ANONYMOUS_DIARIZATION_PATTERNS)) {
    return {
      decision: "allowed",
      reason: "Ordinary transcription and anonymous speaker diarization are allowed when they do not identify real-world speakers.",
      matchedRules: ["ordinary_transcription_or_anonymous_diarization"],
      safeguards: ["anonymous_speaker_labels_only", "no_voiceprint_identification"]
    };
  }

  if (matchesAny(text, BENIGN_MEDIA_ANALYSIS_PATTERNS)) {
    return {
      decision: "allowed",
      reason: "Benign media analysis such as scene summaries, people counts, and non-sensitive visible attributes is allowed.",
      matchedRules: ["benign_media_description"],
      safeguards: ["no_sensitive_trait_inference", "no_identity_claims"]
    };
  }

  return {
    decision: "allowed",
    reason: "No biometric identification, sensitive-trait inference, or prohibited media-based targeting request was detected.",
    matchedRules: [],
    safeguards: ["no_identity_claims", "no_sensitive_trait_inference", "no_biometric_templates"]
  };
}

export const biometricSensitivePerceptionConstraint = BIOMETRIC_SENSITIVE_PERCEPTION_CONSTRAINT;
export default BIOMETRIC_SENSITIVE_PERCEPTION_CONSTRAINT;
