export const conTracePrivacyAndNonAuthority18 = {
  id: "con_trace_privacy_and_non_authority_18",
  name: "Trace telemetry privacy and evaluator non-authority",
  status: "active",
  description:
    "The agent must treat internal traces, trajectory evaluations, evaluator rationales, and derived lesson candidates as sensitive telemetry, not as trusted external facts or authorization. Traces must never contain raw secrets, OAuth tokens, private keys, passwords, browser cookies, approval tokens, reusable HITL binding material, vault session handles, hidden prompts, deleted memory content, or live adapter/auth state. Trace-derived scores or LLM-judge outputs must never authorize side effects, satisfy HITL confirmation, clear taint, weaken success criteria, override policy, directly set tool arguments, directly write memory, or directly promote/update skills. Any trace export, persistence, replay, or lesson derivation must pass redaction, scope authorization, retention limits, deletion handling, and taint propagation.",
  implementation: {
    tests: [
      "trace persistence rejects or redacts raw secrets, OAuth tokens, private keys, browser cookies, approval tokens, host paths, and vault session handles",
      "trace export cannot reveal hidden prompts, deleted memory content, live auth state, or reusable approval binding material",
      "an evaluator score cannot satisfy a HITL gate or authorize browser/API/vault dispatch",
      "an evaluator score cannot clear taint or convert tainted evidence into trusted tool arguments",
      "trace-derived lesson candidates cannot write long-term memory without explicit controller approval and memory policy checks",
      "trace-derived skill suggestions cannot promote or modify skills without cap_procedural_memory_skill_library_14 verification",
      "resume/replay of a trace treats all loaded trace content as tainted advisory evidence",
      "attempted exfiltration of actual vault-held secret bytes through trace logs causes policy_blocked and hard session termination",
    ],
  },
} as const;

export type TraceOperation =
  | "persist"
  | "export"
  | "replay"
  | "evaluate"
  | "deriveLesson"
  | "promoteSkill";

export type TraceTaint = "sensitive_telemetry" | "tainted_advisory";

export type EvaluatorUse =
  | "informPlanning"
  | "authorizeSideEffect"
  | "satisfyHitl"
  | "clearTaint"
  | "weakenSuccessCriteria"
  | "overridePolicy"
  | "setToolArguments"
  | "writeMemory"
  | "promoteSkill";

export interface TraceBoundaryInput {
  operation: TraceOperation;
  trace: unknown;
  scope?: string;
  allowedScopes?: readonly string[];
  retentionMs?: number;
  maxRetentionMs?: number;
  deletionTombstones?: readonly string[];
  vaultSecretBytes?: readonly string[];
}

export interface TraceBoundaryDecision {
  allowed: true;
  operation: TraceOperation;
  sanitizedTrace: unknown;
  taint: TraceTaint;
  contentTrusted: false;
  canAuthorizeSideEffects: false;
  canSatisfyHitl: false;
  canClearTaint: false;
  canOverridePolicy: false;
  canDirectlySetToolArguments: false;
  canDirectlyWriteMemory: false;
  canDirectlyPromoteSkills: false;
  retentionMs?: number;
}

export interface TraceEvaluation {
  score: number;
  rationale?: unknown;
}

export interface TraceLessonCandidate {
  kind: "trace_lesson_candidate";
  content: unknown;
  taint: "tainted_advisory";
  requiresControllerApproval: true;
  requiresMemoryPolicyCheck: true;
  directWriteAllowed: false;
}

export interface TraceSkillSuggestion {
  kind: "trace_skill_suggestion";
  content: unknown;
  taint: "tainted_advisory";
  requiresCapProceduralMemorySkillLibrary14Verification: true;
  directPromotionAllowed: false;
}

const DEFAULT_MAX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const REDACTION = Object.freeze({
  secret: "[REDACTED_SECRET]",
  privateKey: "[REDACTED_PRIVATE_KEY]",
  token: "[REDACTED_TOKEN]",
  password: "[REDACTED_PASSWORD]",
  cookie: "[REDACTED_COOKIE]",
  approval: "[REDACTED_APPROVAL_BINDING]",
  vault: "[REDACTED_VAULT_SESSION]",
  hiddenPrompt: "[REDACTED_HIDDEN_PROMPT]",
  deletedMemory: "[REDACTED_DELETED_MEMORY]",
  liveAuthState: "[REDACTED_LIVE_AUTH_STATE]",
  hostPath: "[REDACTED_HOST_PATH]",
});

const SENSITIVE_KEY =
  /(?:secret|api[_-]?key|token|oauth|password|passwd|pwd|cookie|authorization|private[_-]?key|approval(?:[_-]?token|[_-]?binding)?|hitl(?:[_-]?binding)?|vault(?:[_-]?session|[_-]?handle)?|hidden(?:[_-]?system)?[_-]?prompt|deleted[_-]?memory|live[_-]?(?:adapter|auth)|session[_-]?id|host[_-]?path|auth[_-]?state)/i;

const HOST_PATH_PATTERN =
  /(?:\b[A-Za-z]:\\Users\\[^\s"'`<>|]+|\/(?:Users|home|root|var|etc|tmp)\/[^\s"'`<>|]+)/g;

const STRING_REDACTIONS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, REDACTION.privateKey],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/g, `Bearer ${REDACTION.token}`],
  [/\b(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, REDACTION.token],
  [/\b(?:oauth[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token)\s*[:=]\s*[^\s"'`,;]+/gi, `token=${REDACTION.token}`],
  [/\b(?:approval[_-]?token|approval[_-]?binding|hitl[_-]?binding)\s*[:=]\s*[^\s"'`,;]+/gi, `approval=${REDACTION.approval}`],
  [/\b(?:vault[_-]?session[_-]?(?:handle|id)|vault[_-]?handle)\s*[:=]\s*[^\s"'`,;]+/gi, `vault=${REDACTION.vault}`],
  [/\b(?:password|passwd|pwd)\s*[:=]\s*[^\s"'`,;]+/gi, `password=${REDACTION.password}`],
  [/\bCookie\s*:\s*[^\r\n]+/gi, `Cookie: ${REDACTION.cookie}`],
  [HOST_PATH_PATTERN, REDACTION.hostPath],
];

export class TracePolicyViolation extends Error {
  readonly code = "policy_blocked";
  readonly hardTerminate: boolean;

  constructor(message: string, options: { hardTerminate?: boolean } = {}) {
    super(message);
    this.name = "TracePolicyViolation";
    this.hardTerminate = options.hardTerminate === true;
  }
}

export function guardTraceOperation(input: TraceBoundaryInput): TraceBoundaryDecision {
  enforceScopeAuthorization(input.scope, input.allowedScopes);
  const retentionMs = enforceRetention(input.retentionMs, input.maxRetentionMs);
  enforceNoVaultSecretBytes(input.trace, input.vaultSecretBytes);

  const sanitizedTrace = redactTraceTelemetry(input.trace, {
    deletionTombstones: input.deletionTombstones,
  });

  return {
    allowed: true,
    operation: input.operation,
    sanitizedTrace,
    taint: input.operation === "replay" ? "tainted_advisory" : "sensitive_telemetry",
    contentTrusted: false,
    canAuthorizeSideEffects: false,
    canSatisfyHitl: false,
    canClearTaint: false,
    canOverridePolicy: false,
    canDirectlySetToolArguments: false,
    canDirectlyWriteMemory: false,
    canDirectlyPromoteSkills: false,
    retentionMs,
  };
}

export function persistTraceTelemetry(input: Omit<TraceBoundaryInput, "operation">): TraceBoundaryDecision {
  return guardTraceOperation({ ...input, operation: "persist" });
}

export function exportTraceTelemetry(input: Omit<TraceBoundaryInput, "operation">): TraceBoundaryDecision {
  return guardTraceOperation({ ...input, operation: "export" });
}

export function replayTraceTelemetry(input: Omit<TraceBoundaryInput, "operation">): TraceBoundaryDecision {
  return guardTraceOperation({ ...input, operation: "replay" });
}

export function evaluateTraceTelemetry(
  evaluation: TraceEvaluation,
  input: Omit<TraceBoundaryInput, "operation" | "trace"> & { trace?: unknown } = {},
): TraceBoundaryDecision & { evaluation: TraceEvaluation } {
  const decision = guardTraceOperation({
    ...input,
    operation: "evaluate",
    trace: input.trace ?? evaluation.rationale ?? evaluation,
  });

  return {
    ...decision,
    evaluation: {
      score: evaluation.score,
      rationale: decision.sanitizedTrace,
    },
  };
}

export function assertEvaluatorUseAllowed(use: EvaluatorUse): void {
  if (use !== "informPlanning") {
    throw new TracePolicyViolation(
      `trace evaluator output is advisory telemetry and cannot be used to ${use}`,
    );
  }
}

export function deriveTraceLessonCandidate(
  trace: unknown,
  input: Omit<TraceBoundaryInput, "operation" | "trace"> = {},
): TraceLessonCandidate {
  const decision = guardTraceOperation({ ...input, operation: "deriveLesson", trace });

  return {
    kind: "trace_lesson_candidate",
    content: decision.sanitizedTrace,
    taint: "tainted_advisory",
    requiresControllerApproval: true,
    requiresMemoryPolicyCheck: true,
    directWriteAllowed: false,
  };
}

export function assertTraceLessonMemoryWriteAllowed(
  candidate: TraceLessonCandidate,
  checks: { controllerApproved: boolean; memoryPolicyAllowed: boolean },
): void {
  if (
    candidate.kind !== "trace_lesson_candidate" ||
    checks.controllerApproved !== true ||
    checks.memoryPolicyAllowed !== true
  ) {
    throw new TracePolicyViolation(
      "trace-derived lessons cannot write long-term memory without controller approval and memory policy checks",
    );
  }
}

export function suggestTraceDerivedSkill(
  trace: unknown,
  input: Omit<TraceBoundaryInput, "operation" | "trace"> = {},
): TraceSkillSuggestion {
  const decision = guardTraceOperation({ ...input, operation: "promoteSkill", trace });

  return {
    kind: "trace_skill_suggestion",
    content: decision.sanitizedTrace,
    taint: "tainted_advisory",
    requiresCapProceduralMemorySkillLibrary14Verification: true,
    directPromotionAllowed: false,
  };
}

export function assertTraceSkillPromotionAllowed(
  suggestion: TraceSkillSuggestion,
  checks: { verifiedByCapProceduralMemorySkillLibrary14: boolean },
): void {
  if (
    suggestion.kind !== "trace_skill_suggestion" ||
    checks.verifiedByCapProceduralMemorySkillLibrary14 !== true
  ) {
    throw new TracePolicyViolation(
      "trace-derived skill suggestions require cap_procedural_memory_skill_library_14 verification",
    );
  }
}

export function assertTraceDoesNotSetToolArguments(): never {
  throw new TracePolicyViolation(
    "tainted trace content cannot be converted directly into trusted tool arguments",
  );
}

export function redactTraceTelemetry(
  value: unknown,
  options: { deletionTombstones?: readonly string[] } = {},
): unknown {
  return redactValue(value, new WeakSet<object>(), options.deletionTombstones ?? []);
}

function enforceScopeAuthorization(scope?: string, allowedScopes?: readonly string[]): void {
  if (allowedScopes && allowedScopes.length > 0 && (!scope || !allowedScopes.includes(scope))) {
    throw new TracePolicyViolation("trace telemetry scope is not authorized for this operation");
  }
}

function enforceRetention(retentionMs?: number, maxRetentionMs = DEFAULT_MAX_RETENTION_MS): number | undefined {
  if (retentionMs === undefined) {
    return retentionMs;
  }

  if (!Number.isFinite(retentionMs) || retentionMs < 0 || retentionMs > maxRetentionMs) {
    throw new TracePolicyViolation("trace telemetry retention exceeds authorized limits");
  }

  return retentionMs;
}

function enforceNoVaultSecretBytes(value: unknown, vaultSecretBytes?: readonly string[]): void {
  const secrets = (vaultSecretBytes ?? []).filter((secret) => secret.length > 0);
  if (secrets.length === 0) {
    return;
  }

  for (const secret of secrets) {
    if (containsExactString(value, secret, new WeakSet<object>())) {
      throw new TracePolicyViolation(
        "trace telemetry attempted to emit exact vault-held secret bytes",
        { hardTerminate: true },
      );
    }
  }
}

function containsExactString(value: unknown, needle: string, seen: WeakSet<object>): boolean {
  if (typeof value === "string") {
    return value.includes(needle);
  }

  if (value === null || typeof value !== "object") {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => containsExactString(item, needle, seen));
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.includes(needle) || containsExactString(child, needle, seen)) {
      return true;
    }
  }
  return false;
}

function redactValue(
  value: unknown,
  seen: WeakSet<object>,
  deletionTombstones: readonly string[],
): unknown {
  if (typeof value === "string") {
    return redactString(value, deletionTombstones);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[REDACTED_CYCLE]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen, deletionTombstones));
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const redactedKey = redactString(key, deletionTombstones);
    result[redactedKey] = SENSITIVE_KEY.test(key)
      ? redactionForKey(key)
      : redactValue(child, seen, deletionTombstones);
  }
  return result;
}

function redactString(value: string, deletionTombstones: readonly string[]): string {
  let redacted = value;

  for (const tombstone of deletionTombstones) {
    if (tombstone.length > 0) {
      redacted = redacted.split(tombstone).join(REDACTION.deletedMemory);
    }
  }

  for (const [pattern, replacement] of STRING_REDACTIONS) {
    redacted = redacted.replace(pattern, replacement);
  }

  return redacted;
}

function redactionForKey(key: string): string {
  if (/private[_-]?key/i.test(key)) return REDACTION.privateKey;
  if (/hidden(?:[_-]?system)?[_-]?prompt/i.test(key)) return REDACTION.hiddenPrompt;
  if (/deleted[_-]?memory/i.test(key)) return REDACTION.deletedMemory;
  if (/live[_-]?(?:adapter|auth)|auth[_-]?state/i.test(key)) return REDACTION.liveAuthState;
  if (/cookie/i.test(key)) return REDACTION.cookie;
  if (/approval|hitl/i.test(key)) return REDACTION.approval;
  if (/vault/i.test(key)) return REDACTION.vault;
  if (/host[_-]?path/i.test(key)) return REDACTION.hostPath;
  if (/password|passwd|pwd/i.test(key)) return REDACTION.password;
  if (/token|oauth|authorization|api[_-]?key|session[_-]?id/i.test(key)) return REDACTION.token;
  return REDACTION.secret;
}
