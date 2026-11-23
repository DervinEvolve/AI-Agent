import { createHash } from "node:crypto";

/** Lifecycle points a host may register a synchronous hook for. */
export type HookPoint =
  | "turn_start"
  | "pre_dispatch"
  | "post_result"
  | "pre_finalize";

/** Fail closed only at these points. turn_start and post_result fail open. */
export const FAIL_CLOSED_POINTS: readonly HookPoint[] = [
  "pre_dispatch",
  "pre_finalize",
];

export function isFailClosed(point: HookPoint): boolean {
  return point === "pre_dispatch" || point === "pre_finalize";
}

/** deny is valid only at pre_dispatch and pre_finalize; elsewhere it is malformed. */
export function denyAllowedAt(point: HookPoint): boolean {
  return point === "pre_dispatch" || point === "pre_finalize";
}

export const MAX_HOOKS = 8;
export const MAX_NOTICE_BYTES = 400;
export const DEFAULT_REPEAT_N = 3;
export const DEFAULT_NO_PROGRESS_K = 5;
export const DEFAULT_OSCILLATION_MIN = 4;
export const DEFAULT_POST_WATERMARK_M = 3;

/** Tools the host cannot un-exempt. */
export const IMMUTABLE_EXEMPT_TOOLS: readonly string[] = [
  "recall",
  "list_recalls",
];

export interface HookContext {
  hook_point: HookPoint;
  turn_index: number;
  call_id?: string;
  tool_name?: string;
  args_digest?: string;
  classifier_outcome_kind?: string;
  counters: Readonly<Record<string, number>>;
}

export type HookDecisionKind = "allow" | "deny" | "annotate" | "notice";

export interface HookDecision {
  decision: HookDecisionKind;
  /** Advisory text. Rejected (not truncated) when UTF-8 length exceeds 400. */
  notice?: string;
  annotation?: string;
}

export type RegisteredHook = (
  ctx: HookContext,
) => HookDecision | null | undefined;

export interface HookConfig {
  hooks: ReadonlyArray<{
    point: HookPoint;
    fn: RegisteredHook;
    /** Inclusive post-hoc elapsed budget in milliseconds. */
    time_budget_ms?: number;
  }>;
  /**
   * onFailure is recorded for host documentation. Fail-closed vs fail-open is
   * by HookPoint, never overridden to fail-open at pre_dispatch/pre_finalize.
   */
  onFailure?: "block" | "open";
  stall?: StallConfig;
}

export interface StallConfig {
  enabled?: boolean;
  /** Identical tool_name + digest repeats. Inclusive default 3. */
  repeat_n?: number;
  /** Consecutive no-progress turns. Inclusive default 5. */
  no_progress_k?: number;
  /** Inclusive window of turns after a notice in which a post-watermark match aborts. Default 3. */
  post_watermark_m?: number;
  /** Additional tool names exempt from stall flags. recall and list_recalls always stay exempt. */
  exempt_tools?: readonly string[];
}

export type StallRule = "repeat" | "no_progress" | "oscillation";

export interface StallVerdict {
  flagged: boolean;
  rule?: StallRule;
  /** True when this match is a first notice (set watermark), not an abort. */
  notice: boolean;
  /** True when the same rule matches using a record at or after the watermark within M. */
  abort: boolean;
  /** New watermark index (window length at flag time) when notice is set. */
  watermark_index?: number;
  reason?: "stall_detected";
}

export interface StallRecord {
  /** Monotonic sequence id. Never a shifting array index. */
  seq: number;
  turn_index: number;
  tool_name: string;
  digest: string;
  /** Whether a successful non-read-only result landed this turn. */
  successful_non_readonly?: boolean;
  plan_status?: string;
  read_only?: boolean;
}

export interface StallWindowState {
  watermark_index: number | null;
  watermark_rule?: StallRule;
  /** Turn index when the notice was injected. */
  notice_turn?: number;
  notice_active: boolean;
}

const NOTICE_ENCODER = new TextEncoder();

export function noticeByteLength(text: string): number {
  return NOTICE_ENCODER.encode(text).length;
}

export function isNoticeTooLong(text: string): boolean {
  return noticeByteLength(text) > MAX_NOTICE_BYTES;
}

/**
 * Canonicalize JSON-like args: sorted object keys, stable array order.
 * Returns sha256 hex digest. Non-object values are JSON-encoded as-is.
 */
export function canonicalArgsDigest(args: unknown): string {
  const canonical = canonicalize(args);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortValue(obj[key]);
  }
  return out;
}

export function resolveExemptTools(
  extra: readonly string[] | undefined,
): ReadonlySet<string> {
  const set = new Set<string>(IMMUTABLE_EXEMPT_TOOLS);
  if (extra) {
    for (const name of extra) {
      if (typeof name === "string" && name.length > 0) {
        set.add(name);
      }
    }
  }
  // Host cannot remove immutable exemptions; they are always re-added.
  for (const name of IMMUTABLE_EXEMPT_TOOLS) {
    set.add(name);
  }
  return set;
}

function resolvedThresholds(config: StallConfig | undefined): {
  n: number;
  k: number;
  m: number;
} {
  const n = config?.repeat_n ?? DEFAULT_REPEAT_N;
  const k = config?.no_progress_k ?? DEFAULT_NO_PROGRESS_K;
  const m = config?.post_watermark_m ?? DEFAULT_POST_WATERMARK_M;
  return {
    n: n < 1 ? DEFAULT_REPEAT_N : n,
    k: k < 1 ? DEFAULT_NO_PROGRESS_K : k,
    m: m < 1 ? DEFAULT_POST_WATERMARK_M : m,
  };
}

function tailIdentical(
  window: readonly StallRecord[],
  n: number,
  exempt: ReadonlySet<string>,
): { match: boolean; startSeq: number } {
  if (window.length < n) return { match: false, startSeq: -1 };
  const tail = window.slice(window.length - n);
  const first = tail[0];
  if (!first || exempt.has(first.tool_name)) {
    return { match: false, startSeq: -1 };
  }
  const same = tail.every(
    (r) => r.tool_name === first.tool_name && r.digest === first.digest,
  );
  return { match: same, startSeq: same ? first.seq : -1 };
}

function oscillationMatch(
  window: readonly StallRecord[],
  exempt: ReadonlySet<string>,
): { match: boolean; startSeq: number } {
  if (window.length < DEFAULT_OSCILLATION_MIN) {
    return { match: false, startSeq: -1 };
  }
  const tail = window.slice(window.length - DEFAULT_OSCILLATION_MIN);
  const tool = tail[0]?.tool_name;
  if (!tool || exempt.has(tool)) return { match: false, startSeq: -1 };
  if (!tail.every((r) => r.tool_name === tool)) {
    return { match: false, startSeq: -1 };
  }
  const a = tail[0].digest;
  const b = tail[1].digest;
  if (a === b) return { match: false, startSeq: -1 };
  const ok =
    tail[0].digest === a &&
    tail[1].digest === b &&
    tail[2].digest === a &&
    tail[3].digest === b;
  return { match: ok, startSeq: ok ? tail[0].seq : -1 };
}

function noProgressMatch(
  window: readonly StallRecord[],
  k: number,
): { match: boolean; startSeq: number } {
  if (window.length < k) return { match: false, startSeq: -1 };
  const tail = window.slice(window.length - k);
  // No new distinct digest relative to the first of the streak, no plan status change, no successful non-readonly.
  const baseDigest = tail[0].digest;
  const basePlan = tail[0].plan_status;
  const stalled = tail.every((r) => {
    if (r.digest !== baseDigest) return false;
    if (r.plan_status !== basePlan) return false;
    if (r.successful_non_readonly) return false;
    return true;
  });
  // Distinct arguments across the streak reset it: already covered by digest equality.
  return { match: stalled, startSeq: stalled ? tail[0].seq : -1 };
}

export interface EvaluateStallInput {
  window: readonly StallRecord[];
  config: StallConfig | undefined;
  /**
   * Watermark is a monotonic sequence boundary, not an array index.
   * Records with seq >= watermark_seq count as post-watermark.
   * null means no active notice.
   */
  watermark_seq: number | null;
  watermark_rule?: StallRule;
  notice_turn?: number;
  current_turn: number;
  exempt?: ReadonlySet<string>;
}

/**
 * Pure stall evaluation.
 *
 * watermarkIndex in the exported signature is the monotonic sequence id of the
 * first post-notice record boundary (records with seq >= watermarkIndex are
 * post-watermark). A length-based index is intentionally not used: dropping the
 * head of a bounded window must not invalidate the watermark.
 *
 * Post-watermark repeats only. A match that uses only pre-notice entries never
 * re-triggers. If no post-watermark match occurs within M turns (inclusive),
 * the notice expires and a later match is a new first flag.
 */
export function evaluateStall(
  window: readonly StallRecord[],
  config: StallConfig | undefined,
  watermarkIndex: number | null,
  extras?: {
    watermark_rule?: StallRule;
    notice_turn?: number;
    current_turn?: number;
    exempt?: ReadonlySet<string>;
  },
): StallVerdict {
  if (config && config.enabled === false) {
    return { flagged: false, notice: false, abort: false };
  }
  const { n, k, m } = resolvedThresholds(config);
  const exempt = extras?.exempt ?? resolveExemptTools(config?.exempt_tools);
  const currentTurn =
    extras?.current_turn ??
    (window.length > 0 ? window[window.length - 1].turn_index : 0);

  const repeat = tailIdentical(window, n, exempt);
  const osc = oscillationMatch(window, exempt);
  const progress = noProgressMatch(window, k);

  const candidates: Array<{ rule: StallRule; startSeq: number }> = [];
  if (repeat.match) candidates.push({ rule: "repeat", startSeq: repeat.startSeq });
  if (osc.match) candidates.push({ rule: "oscillation", startSeq: osc.startSeq });
  if (progress.match) {
    candidates.push({ rule: "no_progress", startSeq: progress.startSeq });
  }

  if (candidates.length === 0) {
    return { flagged: false, notice: false, abort: false };
  }

  const noticeActive =
    watermarkIndex !== null && watermarkIndex !== undefined;
  const noticeTurn = extras?.notice_turn;
  const expired =
    noticeActive &&
    noticeTurn !== undefined &&
    currentTurn - noticeTurn > m;

  if (!noticeActive || expired) {
    const first = candidates[0];
    const last = window[window.length - 1];
    return {
      flagged: true,
      rule: first.rule,
      notice: true,
      abort: false,
      watermark_index: last ? last.seq + 1 : 0,
    };
  }

  const rule = extras?.watermark_rule;
  const same = rule
    ? candidates.find((c) => c.rule === rule)
    : candidates[0];

  if (!same) {
    return { flagged: false, notice: false, abort: false };
  }

  // Must use at least one record at or after the watermark.
  const post = window.filter((r) => r.seq >= (watermarkIndex as number));
  if (post.length === 0) {
    return { flagged: false, notice: false, abort: false };
  }

  const withinM =
    noticeTurn === undefined || currentTurn - noticeTurn <= m;
  if (!withinM) {
    const last = window[window.length - 1];
    return {
      flagged: true,
      rule: same.rule,
      notice: true,
      abort: false,
      watermark_index: last ? last.seq + 1 : 0,
    };
  }

  // The matching tail must include a post-watermark record.
  const tailUsesPost = same.startSeq >= (watermarkIndex as number) ||
    window.some(
      (r) =>
        r.seq >= (watermarkIndex as number) &&
        r.seq >= same.startSeq,
    );

  if (!tailUsesPost) {
    return { flagged: false, notice: false, abort: false };
  }

  return {
    flagged: true,
    rule: same.rule,
    notice: false,
    abort: true,
    reason: "stall_detected",
  };
}

export interface HookRunResult {
  decision: HookDecisionKind | "hook_error";
  hook_error: boolean;
  fail_closed: boolean;
  notice?: string;
  annotation?: string;
  /** True when a notice was rejected for exceeding 400 bytes. */
  notice_rejected?: boolean;
  elapsed_ms: number;
}

export function interpretHookOutcome(
  point: HookPoint,
  raw: unknown,
  threw: boolean,
  elapsedMs: number,
  timeBudgetMs: number | undefined,
): HookRunResult {
  const overrun =
    timeBudgetMs !== undefined && elapsedMs > timeBudgetMs;
  const failClosed = isFailClosed(point);

  if (threw || overrun) {
    return {
      decision: "hook_error",
      hook_error: true,
      fail_closed: failClosed,
      elapsed_ms: elapsedMs,
    };
  }

  if (!isWellFormedDecision(raw)) {
    return {
      decision: "hook_error",
      hook_error: true,
      fail_closed: failClosed,
      elapsed_ms: elapsedMs,
    };
  }

  const decision = raw as HookDecision;
  if (decision.decision === "deny" && !denyAllowedAt(point)) {
    return {
      decision: "hook_error",
      hook_error: true,
      fail_closed: failClosed,
      elapsed_ms: elapsedMs,
    };
  }

  let notice = decision.notice;
  let noticeRejected = false;
  if (notice !== undefined) {
    if (typeof notice !== "string" || isNoticeTooLong(notice)) {
      noticeRejected = true;
      notice = undefined;
      if (decision.decision === "notice") {
        return {
          decision: "hook_error",
          hook_error: true,
          fail_closed: failClosed,
          notice_rejected: true,
          elapsed_ms: elapsedMs,
        };
      }
    }
  }

  return {
    decision: decision.decision,
    hook_error: false,
    fail_closed: false,
    notice,
    annotation: decision.annotation,
    notice_rejected: noticeRejected,
    elapsed_ms: elapsedMs,
  };
}

function isWellFormedDecision(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const d = (raw as { decision?: unknown }).decision;
  return d === "allow" || d === "deny" || d === "annotate" || d === "notice";
}

/**
 * Run one hook synchronously. Time budget is post-hoc; a hook that never
 * returns hangs the turn (stated host-defect limitation).
 */
export function runHook(
  point: HookPoint,
  fn: RegisteredHook,
  ctx: HookContext,
  timeBudgetMs?: number,
): HookRunResult {
  const start = Date.now();
  let threw = false;
  let raw: unknown;
  try {
    raw = fn(ctx);
  } catch {
    threw = true;
  }
  const elapsed = Date.now() - start;
  return interpretHookOutcome(point, raw, threw, elapsed, timeBudgetMs);
}
