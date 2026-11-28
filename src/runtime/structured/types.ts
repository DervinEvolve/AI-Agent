import { createHash } from "node:crypto";
import { parseStrictAnswer } from "./parse_strict";
import {
  HeldCandidateSeam,
  holdCandidate,
  digestCandidate,
  releaseCandidate,
  dropCandidate,
  digestText,
  type HeldCandidate,
} from "./held_candidate";
import {
  buildStructuredFeedback,
  UNTRUSTED_FEEDBACK_LABEL,
  type StructuredFeedbackItem,
} from "./feedback";

export {
  parseStrictAnswer,
  HeldCandidateSeam,
  holdCandidate,
  digestCandidate,
  releaseCandidate,
  dropCandidate,
  digestText,
  buildStructuredFeedback,
  UNTRUSTED_FEEDBACK_LABEL,
};
export type { HeldCandidate, StructuredFeedbackItem };

export const STRUCTURED_REASON = {
  passed: "passed",
  not_json: "not_json",
  too_large: "too_large",
  schema_invalid: "schema_invalid",
  skipped_overflow: "skipped_overflow",
  reservation_refused: "reservation_refused",
  reemit_not_answer: "reemit_not_answer",
  structured_no_candidate: "structured_no_candidate",
  output_schema_invalid: "output_schema_invalid",
  structured_schema_unsupported: "structured_schema_unsupported",
  cancelled: "cancelled",
  incomplete: "incomplete",
  co_mount_rejected: "co_mount_rejected",
  admission_rejected: "admission_rejected",
} as const;

export type StructuredReason = (typeof STRUCTURED_REASON)[keyof typeof STRUCTURED_REASON];

export const STRUCTURED_CAPS = {
  maxReemits: { default: 1, hard: 2 },
  maxErrors: { default: 8, hard: 32 },
  maxErrorBytes: { default: 1024, hard: 4096 },
  maxSchemaBytes: { default: 16384, hard: 65536 },
  maxAnswerBytes: { default: 65536, hard: 262144 },
  maxRecordBytes: { default: 4096, hard: 4096 },
} as const;

/** Co-mounts rejected until the held-candidate seam supports combined round accounting. */
export const STRUCTURED_COMOUNT_BLOCKLIST = [
  "cap_verifier_repair_78",
  "verifier_repair",
  "cap_test_synthesis_79",
  "test_synthesis",
  "durable_runs_41",
  "durable_runs",
  "sessions_49",
  "sessions",
  "composition_65",
  "composition",
  "parallel_dispatch_48",
  "parallel_dispatch",
  "async_workers_66",
  "async_workers",
  "deliberation_76",
  "deliberation",
  "triggers_77",
  "triggers",
  "claim_support_68",
  "claim_support",
] as const;

export interface OutputContract {
  schema: unknown;
  schemaDigest: string;
}

export interface StructuredOutputConfig {
  enabled: boolean;
  outputContract: OutputContract | null;
  maxReemits: number;
  maxErrors: number;
  maxErrorBytes: number;
  maxSchemaBytes: number;
  maxAnswerBytes: number;
  maxRecordBytes: number;
}

export interface OutputValidationResult {
  ok: boolean;
  verdict: "passed" | "not_json" | "too_large" | "schema_invalid";
  errors: StructuredFeedbackItem[];
}

export interface OutputRecord {
  run_id: string;
  attempt: number;
  schema_digest: string;
  candidate_digest: string;
  verdict: string;
  error_count: number;
  outcome: string;
  usage: string;
  citable: false;
  pinned: false;
  protected: true;
}

export interface SchemaCompileSuccess {
  ok: true;
  rootType: string;
  validate: (value: unknown) => Array<{ code?: string; pointer?: string; keyword?: string; instancePath?: string; message?: string; data?: unknown; schema?: unknown }>;
}

export interface SchemaCompileFailure {
  ok: false;
  code: "structured_schema_unsupported";
}

export interface SchemaCompiler {
  /** Roots this compiler actually accepts. Do not wrap other roots to force compile. */
  supportedRoots: readonly string[];
  compile: (schema: unknown) => SchemaCompileSuccess | SchemaCompileFailure;
}

export interface AdmissionBudgets {
  step: number;
  inferenceAttempt: number;
  token: number;
  cost: number;
  deadline: number;
}

export interface StructuredBlockers {
  openRecoverySlot?: boolean;
  exhaustedRecoverySlot?: boolean;
  unknownOutcome?: boolean;
  quarantine?: boolean;
  unknownUsage?: boolean;
  abort?: boolean;
  deadline?: boolean;
}

export type DecodedReemit =
  | { kind: "final_answer"; text: string; usage?: "known" | "unknown" }
  | { kind: "tool_call" | "plan_revision" | "batch" | "other" | "none"; usage?: "known" | "unknown" };

export interface Reservation {
  ok: boolean;
  attempts: number;
  tokens: number;
  cost: number;
  steps: number;
  release: () => void;
}

export interface StructuredEpisodeHooks {
  config: StructuredOutputConfig;
  runId: string;
  compiler: SchemaCompiler;
  admission: AdmissionBudgets;
  mounted?: readonly string[];
  blockers?: StructuredBlockers;
  /** First ordinary inference. Counted as adapter call 1. */
  firstDecode: () => DecodedReemit;
  /** Tool-less re-emit. Must not be invoked when measurement or reservation fails. */
  reemit?: (prompt: string) => DecodedReemit;
  measure: (requestBytes: number) => boolean;
  /** Digest compaction only. Never a semantic model call. */
  digestCompact?: (text: string) => string;
  reserve: () => Reservation;
  selfReview?: (text: string) => void;
  evidenceValidator?: (text: string) => void;
  taskContract?: (text: string) => void;
  responseHeadroomBytes?: number;
  clock?: () => number;
}

export interface StructuredEpisodeResult {
  published: boolean;
  incomplete: boolean;
  cancelled: boolean;
  reason: string | null;
  text: string | null;
  records: OutputRecord[];
  adapterCalls: number;
  toolRegistryCalls: number;
  selfReviewCalls: number;
  decoderRejects: number;
  recoverySlotsOpened: number;
  stepsReserved: number;
  reservationReleases: number;
  evidenceCalls: number;
  taskContractCalls: number;
  feedbackRetained: boolean;
  feedbackCitable: boolean;
  feedbackTaintIndexed: boolean;
  semanticCompactionCalls: number;
}

export function defaultStructuredConfig(contract: OutputContract | null, enabled = false): StructuredOutputConfig {
  return freezeConfig({
    enabled,
    outputContract: contract,
    maxReemits: STRUCTURED_CAPS.maxReemits.default,
    maxErrors: STRUCTURED_CAPS.maxErrors.default,
    maxErrorBytes: STRUCTURED_CAPS.maxErrorBytes.default,
    maxSchemaBytes: STRUCTURED_CAPS.maxSchemaBytes.default,
    maxAnswerBytes: STRUCTURED_CAPS.maxAnswerBytes.default,
    maxRecordBytes: STRUCTURED_CAPS.maxRecordBytes.default,
  });
}

export function freezeConfig(config: StructuredOutputConfig): StructuredOutputConfig {
  return Object.freeze({ ...config, outputContract: config.outputContract ? Object.freeze({ ...config.outputContract }) : null });
}

export function schemaDigestOf(schema: unknown): string {
  return createHash("sha256").update(stableStringify(schema), "utf8").digest("hex");
}

export function outputContract(schema: unknown): OutputContract {
  return { schema, schemaDigest: schemaDigestOf(schema) };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(",")}}`;
}

export interface StartupResult {
  ok: boolean;
  code: string | null;
  supportedRoots: readonly string[];
  compiledRoot: string | null;
}

function finiteBudget(n: number): boolean {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function withinHard(value: number, hard: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= hard;
}

export function validateStructuredStartup(args: {
  config: StructuredOutputConfig;
  compiler: SchemaCompiler | null;
  admission: AdmissionBudgets;
  mounted?: readonly string[];
}): StartupResult {
  const supportedRoots = args.compiler?.supportedRoots ?? [];
  if (!args.config.enabled) {
    return { ok: true, code: null, supportedRoots, compiledRoot: null };
  }
  const mounted = new Set(args.mounted ?? []);
  for (const id of STRUCTURED_COMOUNT_BLOCKLIST) {
    if (mounted.has(id)) {
      return { ok: false, code: STRUCTURED_REASON.co_mount_rejected, supportedRoots, compiledRoot: null };
    }
  }
  if (!args.compiler) {
    return { ok: false, code: STRUCTURED_REASON.structured_schema_unsupported, supportedRoots, compiledRoot: null };
  }
  const a = args.admission;
  if (!finiteBudget(a.step) || !finiteBudget(a.inferenceAttempt) || !finiteBudget(a.token) || !finiteBudget(a.cost) || !finiteBudget(a.deadline)) {
    return { ok: false, code: STRUCTURED_REASON.admission_rejected, supportedRoots, compiledRoot: null };
  }
  const c = args.config;
  if (
    !withinHard(c.maxReemits, STRUCTURED_CAPS.maxReemits.hard) ||
    !withinHard(c.maxErrors, STRUCTURED_CAPS.maxErrors.hard) ||
    !withinHard(c.maxErrorBytes, STRUCTURED_CAPS.maxErrorBytes.hard) ||
    !withinHard(c.maxSchemaBytes, STRUCTURED_CAPS.maxSchemaBytes.hard) ||
    !withinHard(c.maxAnswerBytes, STRUCTURED_CAPS.maxAnswerBytes.hard) ||
    !withinHard(c.maxRecordBytes, STRUCTURED_CAPS.maxRecordBytes.hard)
  ) {
    return { ok: false, code: STRUCTURED_REASON.structured_schema_unsupported, supportedRoots, compiledRoot: null };
  }
  const contract = c.outputContract;
  if (!contract) {
    return { ok: false, code: STRUCTURED_REASON.structured_schema_unsupported, supportedRoots, compiledRoot: null };
  }
  const schemaBytes = Buffer.byteLength(stableStringify(contract.schema), "utf8");
  if (schemaBytes > c.maxSchemaBytes) {
    return { ok: false, code: STRUCTURED_REASON.structured_schema_unsupported, supportedRoots, compiledRoot: null };
  }
  const root = schemaRootType(contract.schema);
  if (!root || !args.compiler.supportedRoots.includes(root)) {
    return { ok: false, code: STRUCTURED_REASON.structured_schema_unsupported, supportedRoots, compiledRoot: root };
  }
  const compiled = args.compiler.compile(contract.schema);
  if (!compiled.ok) {
    return { ok: false, code: STRUCTURED_REASON.structured_schema_unsupported, supportedRoots, compiledRoot: root };
  }
  if (!args.compiler.supportedRoots.includes(compiled.rootType)) {
    return { ok: false, code: STRUCTURED_REASON.structured_schema_unsupported, supportedRoots, compiledRoot: compiled.rootType };
  }
  return { ok: true, code: null, supportedRoots, compiledRoot: compiled.rootType };
}

function schemaRootType(schema: unknown): string | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const t = (schema as Record<string, unknown>).type;
  return typeof t === "string" ? t : null;
}

function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function boundRecord(record: OutputRecord, maxRecordBytes: number): OutputRecord {
  let usage = record.usage;
  let copy: OutputRecord = { ...record, usage };
  while (byteLen(JSON.stringify(copy)) > maxRecordBytes && usage.length > 0) {
    usage = usage.slice(0, Math.max(0, usage.length - 8));
    copy = { ...copy, usage };
  }
  if (byteLen(JSON.stringify(copy)) > maxRecordBytes) {
    copy = { ...copy, candidate_digest: copy.candidate_digest.slice(0, 16), schema_digest: copy.schema_digest.slice(0, 16), usage: "" };
  }
  return copy;
}

function hasBlocker(b: StructuredBlockers | undefined): boolean {
  if (!b) return false;
  return Boolean(
    b.openRecoverySlot || b.exhaustedRecoverySlot || b.unknownOutcome || b.quarantine || b.unknownUsage || b.abort || b.deadline,
  );
}

/**
 * Opt-in schema-constrained final answer.
 * Holds the first syntactic final_answer, strict-parses, validates with the injected
 * merged compiler, and grants at most maxReemits tool-less re-emits.
 * Semantic compaction is never invoked.
 */
export function runStructuredEpisode(hooks: StructuredEpisodeHooks): StructuredEpisodeResult {
  const result: StructuredEpisodeResult = {
    published: false,
    incomplete: false,
    cancelled: false,
    reason: null,
    text: null,
    records: [],
    adapterCalls: 0,
    toolRegistryCalls: 0,
    selfReviewCalls: 0,
    decoderRejects: 0,
    recoverySlotsOpened: 0,
    stepsReserved: 0,
    reservationReleases: 0,
    evidenceCalls: 0,
    taskContractCalls: 0,
    feedbackRetained: false,
    feedbackCitable: false,
    feedbackTaintIndexed: false,
    semanticCompactionCalls: 0,
  };

  if (!hooks.config.enabled) {
    return result;
  }

  const startup = validateStructuredStartup({
    config: hooks.config,
    compiler: hooks.compiler,
    admission: hooks.admission,
    mounted: hooks.mounted,
  });
  if (!startup.ok) {
    result.incomplete = true;
    result.reason = startup.code;
    return result;
  }

  const compiled = hooks.compiler.compile(hooks.config.outputContract!.schema);
  if (!compiled.ok) {
    result.incomplete = true;
    result.reason = STRUCTURED_REASON.structured_schema_unsupported;
    return result;
  }

  const seam = new HeldCandidateSeam();
  let feedbackLabelled: string | null = null;
  const clearFeedback = () => {
    feedbackLabelled = null;
    result.feedbackRetained = false;
  };

  const pushRecord = (partial: Omit<OutputRecord, "citable" | "pinned" | "protected">) => {
    result.records.push(
      boundRecord(
        { ...partial, citable: false, pinned: false, protected: true },
        hooks.config.maxRecordBytes,
      ),
    );
  };

  const publishReleased = (released: HeldCandidate, attempt: number) => {
    if (hooks.evidenceValidator) {
      hooks.evidenceValidator(released.text);
      result.evidenceCalls += 1;
    }
    if (hooks.taskContract) {
      hooks.taskContract(released.text);
      result.taskContractCalls += 1;
    }
    result.published = true;
    result.text = released.text;
    result.reason = STRUCTURED_REASON.passed;
    pushRecord({
      run_id: hooks.runId,
      attempt,
      schema_digest: hooks.config.outputContract!.schemaDigest,
      candidate_digest: released.digest,
      verdict: STRUCTURED_REASON.passed,
      error_count: 0,
      outcome: STRUCTURED_REASON.passed,
      usage: "known",
    });
    clearFeedback();
  };

  const classify = (text: string): OutputValidationResult => {
    if (byteLen(text) > hooks.config.maxAnswerBytes) {
      return { ok: false, verdict: "too_large", errors: [] };
    }
    const parsed = parseStrictAnswer(text);
    if (!parsed.ok) {
      return { ok: false, verdict: "not_json", errors: [] };
    }
    const rawErrors = compiled.validate(parsed.value);
    if (rawErrors.length === 0) return { ok: true, verdict: "passed", errors: [] };
    const fb = buildStructuredFeedback(rawErrors, {
      maxErrors: hooks.config.maxErrors,
      maxErrorBytes: hooks.config.maxErrorBytes,
    });
    feedbackLabelled = fb.labelled;
    return { ok: false, verdict: "schema_invalid", errors: fb.items };
  };

  let attempt = 0;
  result.adapterCalls += 1;
  let decoded = hooks.firstDecode();
  let reemitsUsed = 0;

  const failNoCandidate = (outcome: string) => {
    seam.drop();
    result.incomplete = true;
    result.reason = STRUCTURED_REASON.structured_no_candidate;
    result.text = null;
    pushRecord({
      run_id: hooks.runId,
      attempt,
      schema_digest: hooks.config.outputContract!.schemaDigest,
      candidate_digest: "",
      verdict: outcome,
      error_count: 0,
      outcome,
      usage: "known",
    });
    clearFeedback();
  };

  while (true) {
    if (decoded.kind !== "final_answer") {
      if (attempt > 0) {
        seam.drop();
        result.incomplete = true;
        result.reason = STRUCTURED_REASON.structured_no_candidate;
        pushRecord({
          run_id: hooks.runId,
          attempt,
          schema_digest: hooks.config.outputContract!.schemaDigest,
          candidate_digest: seam.digest() ?? "",
          verdict: STRUCTURED_REASON.reemit_not_answer,
          error_count: 0,
          outcome: STRUCTURED_REASON.reemit_not_answer,
          usage: decoded.usage ?? "known",
        });
        clearFeedback();
        return result;
      }
      failNoCandidate(STRUCTURED_REASON.structured_no_candidate);
      return result;
    }

    if (decoded.usage === "unknown") {
      seam.drop();
      result.incomplete = true;
      result.reason = STRUCTURED_REASON.incomplete;
      pushRecord({
        run_id: hooks.runId,
        attempt,
        schema_digest: hooks.config.outputContract!.schemaDigest,
        candidate_digest: "",
        verdict: "unknown_usage",
        error_count: 0,
        outcome: "unknown_usage",
        usage: "unknown",
      });
      clearFeedback();
      return result;
    }

    seam.drop();
    seam.hold(decoded.text);
    if (attempt === 0 && hooks.selfReview) {
      hooks.selfReview(decoded.text);
      result.selfReviewCalls += 1;
    }

    const verdict = classify(decoded.text);
    if (verdict.ok) {
      const released = seam.releaseToGates();
      if (!released) {
        failNoCandidate(STRUCTURED_REASON.structured_no_candidate);
        return result;
      }
      publishReleased(released, attempt);
      return result;
    }

    pushRecord({
      run_id: hooks.runId,
      attempt,
      schema_digest: hooks.config.outputContract!.schemaDigest,
      candidate_digest: seam.digest() ?? digestText(decoded.text),
      verdict: verdict.verdict,
      error_count: verdict.errors.length,
      outcome: verdict.verdict,
      usage: "known",
    });

    const blockers = hooks.blockers;
    if (blockers?.abort) {
      seam.drop();
      result.cancelled = true;
      result.reason = STRUCTURED_REASON.cancelled;
      result.text = null;
      clearFeedback();
      return result;
    }
    if (blockers?.deadline || hasBlocker(blockers)) {
      seam.drop();
      result.incomplete = true;
      result.reason = blockers?.deadline ? STRUCTURED_REASON.incomplete : STRUCTURED_REASON.output_schema_invalid;
      result.text = null;
      clearFeedback();
      return result;
    }

    if (reemitsUsed >= hooks.config.maxReemits) {
      seam.drop();
      result.incomplete = true;
      result.reason = STRUCTURED_REASON.output_schema_invalid;
      result.text = null;
      clearFeedback();
      return result;
    }

    const headroom = hooks.responseHeadroomBytes ?? 256;
    let prompt = renderReemit(hooks, feedbackLabelled ?? UNTRUSTED_FEEDBACK_LABEL);
    if (hooks.digestCompact) prompt = hooks.digestCompact(prompt);
    const measured = byteLen(prompt) + headroom;
    const fits = hooks.measure(measured);
    if (!fits) {
      seam.drop();
      result.incomplete = true;
      result.reason = STRUCTURED_REASON.output_schema_invalid;
      pushRecord({
        run_id: hooks.runId,
        attempt,
        schema_digest: hooks.config.outputContract!.schemaDigest,
        candidate_digest: digestText(decoded.text),
        verdict: verdict.verdict,
        error_count: verdict.errors.length,
        outcome: STRUCTURED_REASON.skipped_overflow,
        usage: "known",
      });
      clearFeedback();
      return result;
    }

    const reservation = hooks.reserve();
    result.stepsReserved += reservation.steps;
    if (!reservation.ok || reservation.steps !== 0 || reservation.attempts !== 1) {
      if (reservation.ok) reservation.release();
      result.reservationReleases += 1;
      seam.drop();
      result.incomplete = true;
      result.reason = STRUCTURED_REASON.output_schema_invalid;
      pushRecord({
        run_id: hooks.runId,
        attempt,
        schema_digest: hooks.config.outputContract!.schemaDigest,
        candidate_digest: digestText(decoded.text),
        verdict: verdict.verdict,
        error_count: verdict.errors.length,
        outcome: STRUCTURED_REASON.reservation_refused,
        usage: "known",
      });
      clearFeedback();
      return result;
    }

    reemitsUsed += 1;
    attempt += 1;
    result.adapterCalls += 1;
    let next: DecodedReemit;
    try {
      next = hooks.reemit ? hooks.reemit(prompt) : { kind: "none" };
    } finally {
      reservation.release();
      result.reservationReleases += 1;
    }
    if (next.usage === "unknown") {
      seam.drop();
      result.incomplete = true;
      result.reason = STRUCTURED_REASON.incomplete;
      result.text = null;
      pushRecord({
        run_id: hooks.runId,
        attempt,
        schema_digest: hooks.config.outputContract!.schemaDigest,
        candidate_digest: "",
        verdict: "unknown_usage",
        error_count: 0,
        outcome: "unknown_usage",
        usage: "unknown",
      });
      clearFeedback();
      return result;
    }
    decoded = next;
    clearFeedback();
  }
}

function renderReemit(hooks: StructuredEpisodeHooks, feedback: string): string {
  const transcript = "TRANSCRIPT";
  return `${transcript}\n${UNTRUSTED_FEEDBACK_LABEL}\n${feedback}\nHEADROOM`;
}

export function childOutputContract(): null {
  return null;
}

/** Object-root subset compiler used when the host injects the merged validator shape. */
export function objectRootCompiler(supportedRoots: readonly string[] = ["object"]): SchemaCompiler {
  return {
    supportedRoots,
    compile(schema: unknown): SchemaCompileSuccess | SchemaCompileFailure {
      const root = schemaRootType(schema);
      if (!root || !supportedRoots.includes(root)) return { ok: false, code: "structured_schema_unsupported" };
      if (root !== "object" && root !== "array" && root !== "string" && root !== "number" && root !== "boolean" && root !== "null") {
        return { ok: false, code: "structured_schema_unsupported" };
      }
      return {
        ok: true,
        rootType: root,
        validate(value: unknown) {
          return validateSubset(schema, value, "");
        },
      };
    },
  };
}

function validateSubset(schema: unknown, value: unknown, pointer: string): Array<{ code: string; pointer: string; keyword: string; message?: string; data?: unknown }> {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as Record<string, unknown>;
  const errors: Array<{ code: string; pointer: string; keyword: string; message?: string; data?: unknown }> = [];
  if (typeof s.type === "string") {
    if (!typeMatches(s.type, value)) {
      errors.push({ code: "type", pointer, keyword: "type", message: `expected ${s.type}`, data: value });
      return errors;
    }
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push({ code: "enum", pointer, keyword: "enum", data: value });
  }
  if (s.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const required = Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === "string") : [];
    for (const key of required) {
      if (!(key in obj)) errors.push({ code: "required", pointer: pointer ? `${pointer}/${key}` : `/${key}`, keyword: "required" });
    }
    const props = s.properties && typeof s.properties === "object" ? (s.properties as Record<string, unknown>) : {};
    for (const key of Object.keys(obj)) {
      if (props[key]) errors.push(...validateSubset(props[key], obj[key], pointer ? `${pointer}/${escapePtr(key)}` : `/${escapePtr(key)}`));
    }
  }
  if (s.type === "array" && Array.isArray(value) && s.items) {
    value.forEach((item, idx) => {
      errors.push(...validateSubset(s.items, item, `${pointer}/${idx}`));
    });
  }
  return errors;
}

function escapePtr(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}
