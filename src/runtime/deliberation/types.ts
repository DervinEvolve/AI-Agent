/**
 * cap_structured_deliberation_76 - shared types, reason codes and caps.
 *
 * This module is deliberately free of imports from the rest of the runtime: the
 * deliberation core talks to the runtime through the structural ports below, so
 * the existing ActionDecoder / ModelAdapter / ContextManager are adapted at the
 * mount site rather than duplicated here.
 */

export const DELIBERATION_CAPS = Object.freeze({
  attemptShareDefault: 0.25,
  attemptShareMax: 0.5,
  maxDeliberatedTurnsDefault: 4,
  maxDeliberatedTurnsHard: 12,
  maxCritiqueBytesDefault: 2048,
  maxCritiqueBytesMin: 64,
  maxCritiqueBytesHard: 4096,
  maxRecordBytesDefault: 4096,
  maxRecordBytesMin: 1024,
  maxRecordBytesHard: 16384,
  maxConcerns: 4,
  maxAssumptions: 4,
  maxItemBytes: 240,
  /** Deliberation attempts reserved per round: critic + possible revision. */
  attemptsPerRound: 2,
});

export interface DeliberationConfig {
  enabled: boolean;
  /** Host allowlist of registered tool names. */
  deliberateTools: readonly string[];
  deliberateFinalAnswer: boolean;
  deliberationAttemptShare: number;
  maxDeliberatedTurns: number;
  maxCritiqueBytes: number;
  maxRecordBytes: number;
}

export type CritiqueVerdict = 'proceed' | 'reconsider';

export interface Critique {
  verdict: CritiqueVerdict;
  concerns: string[];
  assumptions: string[];
  suggested_check?: string;
}

export type CritiqueRejectReason =
  | 'not_text'
  | 'oversize'
  | 'bad_json'
  | 'not_object'
  | 'unknown_field'
  | 'bad_verdict'
  | 'bad_concerns'
  | 'bad_assumptions'
  | 'bad_suggested_check';

export type DeliberationTrigger = 'tool' | 'final_answer';

/** Reason codes for how a turn left the deliberation state machine. */
export type DeliberationOutcome =
  | 'disabled'
  | 'not_triggered'
  | 'skipped_turn_cap'
  | 'skipped_overflow'
  | 'skipped_budget'
  | 'proceed'
  | 'revised'
  | 'critique_rejected'
  | 'revision_rejected'
  | 'critic_failed'
  | 'revision_failed'
  | 'usage_unknown'
  | 'cancelled';

export type InferenceUsage = { known: true; tokens: number; cost: number } | { known: false };

export type ActionKind = 'tool_call' | 'final_answer' | 'plan_revision' | 'batch' | 'reject';

/** Minimal view of what the existing ActionDecoder produced. Extra fields pass through. */
export interface DecodedAction {
  kind: ActionKind;
  tool?: string;
  [extra: string]: unknown;
}

/** A decoded but uncommitted model response. `message` is opaque and is committed unchanged. */
export interface HeldCandidate<M> {
  action: DecodedAction;
  message: M;
  /** Canonical serialization of the candidate shown to the critic as untrusted data. */
  serialized: string;
}

export interface DeliberationRequest {
  role: 'critic' | 'revision';
  /** Fixed role instruction (critic only). The revision uses the primary's own instructions. */
  instruction?: string;
  /** The frozen primary rendering, byte-identical across primary, critic and revision. */
  rendering: string;
  /** Labelled untrusted section placed after the transcript. */
  untrustedSection: string;
  tools: 'none' | 'primary';
  maxResponseTokens: number;
}

export type DeliberationInferenceResult<M> =
  | { ok: true; message: M; text: string; toolCallCount: number; usage: InferenceUsage }
  | { ok: false; error: string; usage: InferenceUsage };

export interface AttemptAllowance {
  tokens: number;
  cost: number;
}

export type ReserveResult = { ok: true; id: string } | { ok: false; reason: string };

/** Shared run-wide inference admission. All-or-nothing reservations. */
export interface SharedInferenceAdmission {
  /** Finite run-wide inference-attempt limit B. */
  attemptLimit(): number;
  reserve(allowances: readonly AttemptAllowance[]): ReserveResult;
  /** Marks the next reserved attempt as started. */
  start(id: string): void;
  /** Records usage for the oldest started attempt of the reservation. */
  settle(id: string, usage: InferenceUsage): void;
  /** Releases unstarted attempts. Returns true only the first time. */
  release(id: string): boolean;
  stopInference(reason: string): void;
  inferenceStopped(): boolean;
}

export interface DeliberationPorts<M> {
  admission: SharedInferenceAdmission;
  /** Same authorized destination as the primary turn. Never retried by the core. */
  infer(request: DeliberationRequest): Promise<DeliberationInferenceResult<M>>;
  /** The existing ActionDecoder, applied without committing state. May throw on reject. */
  decode(message: M): DecodedAction;
  /** Complete context measurement of a request, including response headroom. */
  measure(request: DeliberationRequest): { fits: boolean; inputTokens: number };
  estimateCost?(inputTokens: number, outputTokens: number): number;
  /** Abort / deadline probe, rechecked before critic start, revision start and commitment. */
  stop(): 'abort' | 'deadline' | null;
  /** Optional IFC TaintIndex ingest; called on reconsider only. */
  taint?: { ingest(text: string): void };
}

export interface DeliberationTurnInput<M> {
  turnIndex: number;
  /** Only 'primary' can trigger; child/review/verifier/checker inference never does. */
  inferenceKind: 'primary' | 'child' | 'review' | 'verifier' | 'checker';
  rendering: string;
  candidate: HeldCandidate<M>;
  primaryUsage: InferenceUsage;
  /** Ordinary base response cap, reserved for the revision. */
  baseResponseTokens: number;
  /** Adapter response limit; bounds the critic response allowance. */
  adapterMaxResponseTokens?: number;
}

export interface DeliberationRecord {
  run_id: string;
  turn_index: number;
  rendering_digest: string;
  candidate_digest: string;
  trigger: DeliberationTrigger;
  verdict: CritiqueVerdict | null;
  outcome: DeliberationOutcome;
  committed: 'original' | 'revision' | 'none';
  critique_digest: string | null;
  critique_bytes: number;
  usage: { critic: InferenceUsage | null; revision: InferenceUsage | null };
  instruction_digest: string;
  /** Host metadata: protected, never citable, never pinned into a model request. */
  protected: true;
  citable: false;
}

export interface DeliberationResult<M> {
  /** 'none' means: commit nothing from this turn and follow the existing terminal path. */
  commit: 'original' | 'revision' | 'none';
  message?: M;
  action?: DecodedAction;
  outcome: DeliberationOutcome;
  /** True when a deliberated turn commits a valid action (reset the reject counter once). */
  resetDecoderRejects: boolean;
  record?: DeliberationRecord;
}

export type DeliberationConfigErrorCode =
  | 'bad_share'
  | 'bad_max_turns'
  | 'bad_critique_bytes'
  | 'bad_record_bytes'
  | 'unregistered_tool'
  | 'no_attempt_limit'
  | 'share_too_small'
  | 'co_mount_rejected'
  | 'self_review_conflict';

export class DeliberationConfigError extends Error {
  readonly code: DeliberationConfigErrorCode;
  constructor(code: DeliberationConfigErrorCode, detail: string) {
    super(`deliberation config rejected (${code}): ${detail}`);
    this.name = 'DeliberationConfigError';
    this.code = code;
  }
}
