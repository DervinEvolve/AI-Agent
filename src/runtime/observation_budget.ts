/**
 * Observation budgeting with offload + automatic recall-step insertion.
 *
 * When a tool output exceeds its observation budget, the full output is
 * offloaded to an ObservationStore under an unguessable handle, the in-context
 * observation is replaced with a head+tail preview snapped to line boundaries,
 * and a `read_offloaded` recall step is automatically inserted into the current
 * plan (idempotently) so the agent can page back the omitted region without
 * re-blowing the context budget.
 *
 * Design notes (mirroring timbal / deer-flow prior art):
 * - Budgeting happens once, at result-production time, never per-request, so
 *   already-cached messages are never rewritten.
 * - Error results and the read tool's own output are exempt from budgeting,
 *   preventing recall loops.
 * - If the store write fails, we fall back to lossy head+tail truncation with
 *   an explicit marker (no handle, no recall step).
 * - `read_offloaded` reads are hard-capped at 500 lines / 50,000 chars per
 *   call, so a recall can never blow the budget again.
 */

import { randomBytes } from "node:crypto";

export const DEFAULT_OBSERVATION_BUDGET_CHARS = 8000;
export const READ_OFFLOADED_TOOL_NAME = "read_offloaded";
export const READ_OFFLOADED_MAX_LINES = 500;
export const READ_OFFLOADED_MAX_CHARS = 50000;

/** Space reserved for the truncation marker inside the preview. */
const MARKER_OVERHEAD = 400;

export interface ObservationRecord {
  handle: string;
  content: string;
  totalChars: number;
  totalLines: number;
  sourceTool?: string;
  createdAt: number;
}

/** Content-addressed-by-handle store for oversized tool observations. */
export class ObservationStore {
  private readonly records = new Map<string, ObservationRecord>();

  put(content: string, sourceTool?: string): string {
    // 128 bits of entropy: handles are unguessable and unenumerable.
    const handle = randomBytes(16).toString("hex");
    this.records.set(handle, {
      handle,
      content,
      totalChars: content.length,
      totalLines: content.split("\n").length,
      sourceTool,
      createdAt: Date.now(),
    });
    return handle;
  }

  get(handle: string): ObservationRecord | undefined {
    return this.records.get(handle);
  }

  get size(): number {
    return this.records.size;
  }
}

export interface ReadOffloadedPage {
  handle: string;
  offset: number;
  limit: number;
  pattern?: string;
  lines: string[];
  totalLines: number;
  totalChars: number;
  nextOffset: number;
  hasMore: boolean;
  truncatedByCharCap: boolean;
}

export type ReadOffloadedResult =
  | { ok: true; page: ReadOffloadedPage }
  | { ok: false; error: string };

/**
 * The `read_offloaded` tool: paged, capped retrieval of an offloaded
 * observation. Never returns more than READ_OFFLOADED_MAX_LINES lines or
 * READ_OFFLOADED_MAX_CHARS characters per call.
 */
export function readOffloaded(
  store: ObservationStore,
  args: {
    handle?: unknown;
    offset?: unknown;
    limit?: unknown;
    pattern?: unknown;
  }
): ReadOffloadedResult {
  const handle = typeof args.handle === "string" ? args.handle : "";
  const record = store.get(handle);
  if (!record) {
    return { ok: false, error: `unknown observation handle` };
  }

  const rawLines = record.content.split("\n");
  let start = typeof args.offset === "number" && Number.isFinite(args.offset)
    ? Math.max(0, Math.floor(args.offset))
    : 0;
  if (start > rawLines.length) start = rawLines.length;

  const requestedLimit =
    typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.floor(args.limit)
    : READ_OFFLOADED_MAX_LINES;
  // Hard cap: a recall read can never exceed the per-call line budget.
  const limit = Math.min(
    Math.max(1, requestedLimit),
    READ_OFFLOADED_MAX_LINES
  );

  const pattern =
    typeof args.pattern === "string" && args.pattern.length > 0
      ? args.pattern
      : undefined;

  const lines: string[] = [];
  let chars = 0;
  let truncatedByCharCap = false;
  let i = start;
  for (; i < rawLines.length; i++) {
    if (lines.length >= limit) break;
    const line = rawLines[i];
    if (pattern !== undefined && !line.includes(pattern)) continue;
    const lineCost = line.length + 1;
    if (chars + lineCost > READ_OFFLOADED_MAX_CHARS) {
      truncatedByCharCap = true;
      break;
    }
    lines.push(line);
    chars += lineCost;
  }

  // nextOffset points past every raw line we examined (including skipped
  // non-matching lines), so paging is monotonic and terminates.
  const nextOffset = Math.min(i + (truncatedByCharCap ? 0 : 0) + (lines.length >= limit && i < rawLines.length ? 0 : 0), rawLines.length);
  const consumedTo = truncatedByCharCap ? i : i;
  const hasMore = consumedTo < rawLines.length;

  return {
    ok: true,
    page: {
      handle,
      offset: start,
      limit,
      pattern,
      lines,
      totalLines: record.totalLines,
      totalChars: record.totalChars,
      nextOffset: consumedTo,
      hasMore,
      truncatedByCharCap,
    },
  };
}

export interface BudgetedObservation {
  /** The observation to place in context (preview if offloaded). */
  observation: string;
  offloaded: boolean;
  handle?: string;
  totalLines?: number;
  totalChars?: number;
  /** True when the store write failed and we fell back to lossy truncation. */
  lossyFallback?: boolean;
}

function snapToLineEnd(s: string, idx: number): string {
  if (idx >= s.length) return s;
  let i = Math.max(0, idx);
  while (i < s.length && s[i] !== "\n") i++;
  return s.slice(0, i);
}

function snapToLineStart(s: string, idx: number): string {
  if (idx <= 0) return s;
  let i = Math.min(s.length, idx);
  while (i > 0 && s[i - 1] !== "\n") i--;
  return s.slice(i);
}

/**
 * Budget a tool output at production time. Error results and the recall
 * tool's own output are exempt. On overflow, offload the full output and
 * return a head+tail preview with an omitted-chars marker.
 */
export function budgetObservation(
  output: string,
  opts: {
    store: ObservationStore;
    budget?: number;
    toolName?: string;
    isError?: boolean;
  }
): BudgetedObservation {
  const budget =
    opts.budget !== undefined && Number.isFinite(opts.budget)
      ? Math.max(1, Math.floor(opts.budget))
      : DEFAULT_OBSERVATION_BUDGET_CHARS;

  // Exemptions: errors (so failures stay visible) and the read tool itself
  // (so recall pages are never re-offloaded, which would loop).
  if (opts.isError || opts.toolName === READ_OFFLOADED_TOOL_NAME) {
    return { observation: output, offloaded: false };
  }
  if (output.length <= budget) {
    return { observation: output, offloaded: false };
  }

  const usable = Math.max(0, budget - MARKER_OVERHEAD);
  const headBudget = Math.floor(usable * 0.6);
  const tailBudget = usable - headBudget;

  const head = snapToLineEnd(output, Math.min(headBudget, output.length));
  let tailStart = Math.max(output.length - tailBudget, head.length);
  const tail = tailStart >= output.length ? "" : snapToLineStart(output, tailStart);

  const totalChars = output.length;
  const totalLines = output.split("\n").length;
  const omitted = totalChars - head.length - tail.length;

  if (omitted <= 0) {
    return { observation: output, offloaded: false };
  }

  let handle: string | undefined;
  let persisted = true;
  try {
    handle = opts.store.put(output, opts.toolName);
  } catch {
    persisted = false;
  }

  if (!persisted) {
    // deer-flow style lossy fallback: truncate, mark, no handle.
    const marker =
      `\n...[observation truncated: ${omitted} chars omitted; ` +
      `offload persistence failed; tail lost]...\n`;
    return {
      observation: head + marker + tail,
      offloaded: false,
      lossyFallback: true,
    };
  }

  const marker =
    `\n...[observation truncated: ${omitted} chars omitted; full output offloaded as handle=${handle} ` +
    `(${totalLines} lines / ${totalChars} chars); recall with ${READ_OFFLOADED_TOOL_NAME} ` +
    `{"handle":"${handle}","offset":${head.split("\n").length},"limit":${READ_OFFLOADED_MAX_LINES}}]...\n`;

  return {
    observation: head + marker + tail,
    offloaded: true,
    handle,
    totalLines,
    totalChars,
  };
}

export interface PlanStep {
  id?: string;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Insert a read_offloaded recall step into the plan after `afterIndex`,
 * targeting the omitted region (offset = first line after the kept head).
 * Idempotent: if the plan already contains a recall step for this handle,
 * the plan is returned unchanged. Prior steps are never mutated or reordered
 * (append-only / prompt-cache friendly).
 */
export function insertRecallStep(
  plan: PlanStep[],
  handle: string,
  afterIndex: number,
  meta: { totalLines: number }
): PlanStep[] {
  if (
    plan.some(
      (s) => s.tool === READ_OFFLOADED_TOOL_NAME && s.args?.handle === handle
    )
  ) {
    return plan;
  }
  const headLinesKept = Math.max(0, meta.totalLines - Math.max(0, meta.totalLines - Math.ceil(meta.totalLines * 0.4)));
  // Offset targets the omitted middle: skip past the head preview's lines.
  const offset = Math.min(
    Math.max(0, Math.ceil(meta.totalLines * 0.6)),
    headLinesKept > 0 ? headLinesKept : Math.ceil(meta.totalLines * 0.6)
  );
  const step: PlanStep = {
    id: `recall:${handle}`,
    tool: READ_OFFLOADED_TOOL_NAME,
    args: {
      handle,
      offset,
      limit: READ_OFFLOADED_MAX_LINES,
    },
  };
  const idx = Math.min(Math.max(0, afterIndex), plan.length);
  return [...plan.slice(0, idx + 1), step, ...plan.slice(idx + 1)];
}

export interface StepBudgetResult {
  observation: string;
  plan: PlanStep[];
  offloaded: boolean;
  handle?: string;
}

/**
 * Middleware-style hook for the plan executor: budget a step's tool result and,
 * when it overflows, revise the plan to insert an idempotent recall step.
 */
export function processStepResult(
  params: {
    result: string;
    toolName: string;
    plan: PlanStep[];
    stepIndex: number;
    store: ObservationStore;
    budget?: number;
    isError?: boolean;
  }
): StepBudgetResult {
  const budgeted = budgetObservation(params.result, {
    store: params.store,
    budget: params.budget,
    toolName: params.toolName,
    isError: params.isError,
  });

  if (!budgeted.offloaded || !budgeted.handle) {
    return {
      observation: budgeted.observation,
      plan: params.plan,
      offloaded: false,
    };
  }

  const plan = insertRecallStep(
    params.plan,
    budgeted.handle,
    params.stepIndex,
    { totalLines: budgeted.totalLines ?? 0 }
  );

  return {
    observation: budgeted.observation,
    plan,
    offloaded: true,
    handle: budgeted.handle,
  };
}
