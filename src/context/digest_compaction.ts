/**
 * cap_context_compaction_mount_38 - digest slice, standalone core.
 *
 * Deterministic, runtime-authored context compaction. No model call, no
 * tokenizer. This module is self-contained on purpose: it imports nothing from
 * the rest of the repository, because the bodies of ContextManager,
 * ObservationStore, ToolRegistry and AgentRuntime were not inspectable when it
 * was written. See docs/context-compaction-digest-status.md for mount status.
 *
 * Compaction is a render-time view: the caller's groups are never mutated,
 * split or reordered. Only the compacted-through set and the dropped-line
 * count are kept (sticky), so the rendered prefix is stable between turns.
 */

export const DIGEST_MAX_BYTES = 4096;
export const LIST_RECALLS_MAX_OUTPUT_BYTES = 4096;
export const COMPACTION_TARGET_RATIO = 0.7;
export const DEFAULT_KEEP_RECENT_GROUPS = 4;
export const MIN_KEEP_RECENT_GROUPS = 2;
export const MAX_KEEP_RECENT_GROUPS = 16;

/* ------------------------------------------------------------------ */
/* Shared measurement                                                  */
/* ------------------------------------------------------------------ */

/**
 * The single measure used for both admission and compaction: UTF-8 bytes of
 * the exact JSON serialization of the request, plus reserved response headroom.
 */
export function measureRequestBytes(request: unknown, responseHeadroomBytes = 0): number {
  if (!Number.isInteger(responseHeadroomBytes) || responseHeadroomBytes < 0) {
    throw new TypeError('responseHeadroomBytes must be a non-negative integer');
  }
  const serialized = JSON.stringify(request);
  if (typeof serialized !== 'string') {
    throw new TypeError('request is not JSON-serializable');
  }
  return Buffer.byteLength(serialized, 'utf8') + responseHeadroomBytes;
}

/* ------------------------------------------------------------------ */
/* Host option                                                         */
/* ------------------------------------------------------------------ */

export type ContextCompactionConfig =
  | { enabled: false }
  | { enabled: true; keepRecentGroups: number };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validates HostConfig.contextCompaction. Absent => disabled. Malformed
 * (non-object, unknown key such as `summarizer`, bad types/ranges) throws, so
 * the host can reject before the run.
 */
export function parseContextCompactionOption(value: unknown): ContextCompactionConfig {
  if (value === undefined) return { enabled: false };
  if (!isPlainObject(value)) {
    throw new TypeError('contextCompaction must be a plain object');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'enabled' && key !== 'keepRecentGroups') {
      throw new TypeError(`contextCompaction: unknown key "${key.slice(0, 64)}"`);
    }
  }
  if (typeof value.enabled !== 'boolean') {
    throw new TypeError('contextCompaction.enabled must be a boolean');
  }
  let keep = DEFAULT_KEEP_RECENT_GROUPS;
  if (value.keepRecentGroups !== undefined) {
    const k = value.keepRecentGroups;
    if (
      typeof k !== 'number' ||
      !Number.isInteger(k) ||
      k < MIN_KEEP_RECENT_GROUPS ||
      k > MAX_KEEP_RECENT_GROUPS
    ) {
      throw new TypeError(
        `contextCompaction.keepRecentGroups must be an integer ${MIN_KEEP_RECENT_GROUPS}..${MAX_KEEP_RECENT_GROUPS}`,
      );
    }
    keep = k;
  }
  if (value.enabled !== true) return { enabled: false };
  return { enabled: true, keepRecentGroups: keep };
}

/* ------------------------------------------------------------------ */
/* Digest                                                              */
/* ------------------------------------------------------------------ */

export type TurnGroupKind = 'tool_call' | 'reject' | 'plan_revision';

/** One atomic group: an assistant action plus its runtime response. */
export interface TurnGroup {
  /** Unique, stable id for the group within the run. */
  id: string;
  kind: TurnGroupKind;
  step: number;
  tool?: string;
  call_id?: string;
  /** Outcome label from the shared classifier (runtime record, not model text). */
  outcome?: string;
  stored_bytes?: number;
  /** Unknown/unresolved operation or origin of an open recovery slot. */
  pinned?: boolean;
  /** The verbatim rendered messages of this group. Never inspected here. */
  messages: readonly unknown[];
}

function token(value: unknown): string {
  const s = String(value ?? '')
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, 64);
  return s.length > 0 ? s : 'unknown';
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** One digest line, built from runtime metadata only. */
export function digestLine(group: TurnGroup): string {
  if (group.kind === 'tool_call') {
    return (
      `step=${count(group.step)} tool=${token(group.tool)} call_id=${token(group.call_id)}` +
      ` outcome=${token(group.outcome)} stored_bytes=${count(group.stored_bytes)}`
    );
  }
  return `step=${count(group.step)} kind=${token(group.kind)} outcome=${token(group.outcome)}`;
}

export function digestCountLine(dropped: number): string {
  return `[${dropped} earlier compacted steps not listed; call list_recalls to enumerate stored call_ids]`;
}

export interface BuiltDigest {
  text: string | null;
  dropped: number;
  lineCount: number;
}

/**
 * Joins lines into a digest of at most DIGEST_MAX_BYTES. Oldest lines are
 * dropped (at least `minDropped`) and replaced by one count line.
 */
export function buildDigest(lines: readonly string[], minDropped = 0): BuiltDigest {
  if (lines.length === 0) return { text: null, dropped: 0, lineCount: 0 };
  let dropped = Math.min(Math.max(0, minDropped), lines.length);
  for (;;) {
    const parts = dropped > 0 ? [digestCountLine(dropped)] : [];
    for (let i = dropped; i < lines.length; i++) parts.push(lines[i]);
    const text = parts.join('\n');
    if (Buffer.byteLength(text, 'utf8') <= DIGEST_MAX_BYTES || dropped >= lines.length) {
      return { text, dropped, lineCount: lines.length };
    }
    dropped++;
  }
}

/* ------------------------------------------------------------------ */
/* Compactor                                                           */
/* ------------------------------------------------------------------ */

export interface CompactionRecord {
  events: number;
  groupsCompacted: number;
  pinnedGroups: number;
  digestLinesDropped: number;
  fixedOverheadExceededLimit: boolean;
}

export interface DigestCompactorOptions {
  hardLimitBytes: number;
  keepRecentGroups?: number;
  responseHeadroomBytes?: number;
}

export type RequestBuilder = (digest: string | null, retained: readonly TurnGroup[]) => unknown;

export interface CompactionRender {
  request: unknown;
  /** measureRequestBytes(request, responseHeadroomBytes) - the admission measure. */
  bytes: number;
  digest: string | null;
  retained: readonly TurnGroup[];
  compactedNow: number;
  /** True only when the hard limit cannot be met after everything eligible is compacted. */
  overflow: boolean;
}

export class DigestCompactor {
  readonly hardLimitBytes: number;
  readonly keepRecentGroups: number;
  readonly responseHeadroomBytes: number;
  private readonly compacted = new Set<string>();
  private dropped = 0;
  private readonly rec: CompactionRecord = {
    events: 0,
    groupsCompacted: 0,
    pinnedGroups: 0,
    digestLinesDropped: 0,
    fixedOverheadExceededLimit: false,
  };

  constructor(options: DigestCompactorOptions) {
    if (!Number.isInteger(options.hardLimitBytes) || options.hardLimitBytes <= 0) {
      throw new TypeError('hardLimitBytes must be a positive integer');
    }
    const keep = options.keepRecentGroups ?? DEFAULT_KEEP_RECENT_GROUPS;
    if (!Number.isInteger(keep) || keep < MIN_KEEP_RECENT_GROUPS || keep > MAX_KEEP_RECENT_GROUPS) {
      throw new TypeError('keepRecentGroups out of range');
    }
    this.hardLimitBytes = options.hardLimitBytes;
    this.keepRecentGroups = keep;
    this.responseHeadroomBytes = options.responseHeadroomBytes ?? 0;
    measureRequestBytes(null, this.responseHeadroomBytes); // validates headroom
  }

  get record(): CompactionRecord {
    return { ...this.rec };
  }

  isCompacted(groupId: string): boolean {
    return this.compacted.has(groupId);
  }

  /**
   * Derives the request for this turn from the untouched groups. Compacts only
   * when the measured request exceeds the hard limit.
   */
  render(groups: readonly TurnGroup[], buildRequest: RequestBuilder): CompactionRender {
    const measure = (request: unknown) => measureRequestBytes(request, this.responseHeadroomBytes);
    const view = (minDropped: number) => {
      const lines: string[] = [];
      const retained: TurnGroup[] = [];
      for (const g of groups) {
        if (this.compacted.has(g.id)) lines.push(digestLine(g));
        else retained.push(g);
      }
      const d = buildDigest(lines, minDropped);
      const request = buildRequest(d.text, retained);
      return { request, bytes: measure(request), digest: d.text, retained, dropped: d.dropped, lineCount: d.lineCount };
    };

    let v = view(this.dropped);
    let compactedNow = 0;
    let overflow = false;

    if (v.bytes > this.hardLimitBytes) {
      const target = Math.floor(this.hardLimitBytes * COMPACTION_TARGET_RATIO);
      const lastEligible = groups.length - this.keepRecentGroups;
      for (let i = 0; i < lastEligible; i++) {
        if (v.bytes <= target) break;
        const g = groups[i];
        if (g.pinned === true || this.compacted.has(g.id)) continue;
        this.compacted.add(g.id);
        compactedNow++;
        v = view(v.dropped);
      }
      while (v.bytes > this.hardLimitBytes && v.dropped < v.lineCount) {
        v = view(v.dropped + 1);
      }
      overflow = v.bytes > this.hardLimitBytes;
      if (overflow && measure(buildRequest(null, [])) > this.hardLimitBytes) {
        this.rec.fixedOverheadExceededLimit = true;
      }
      this.rec.events++;
      this.rec.groupsCompacted += compactedNow;
    }

    this.dropped = v.dropped;
    this.rec.digestLinesDropped = v.dropped;
    this.rec.pinnedGroups = v.retained.filter((g) => g.pinned === true).length;

    return {
      request: v.request,
      bytes: v.bytes,
      digest: v.digest,
      retained: v.retained,
      compactedNow,
      overflow,
    };
  }
}

/* ------------------------------------------------------------------ */
/* list_recalls                                                        */
/* ------------------------------------------------------------------ */

export interface RecallEntry {
  call_id: string;
  tool: string;
  step: number;
  outcome: string;
  stored_bytes: number;
}

export interface ListRecallsOutput {
  ok: true;
  total: number;
  has_more: boolean;
  entries: RecallEntry[];
}

export type ListRecallsResult =
  | { status: 'ok'; started: true; output: ListRecallsOutput }
  | { status: 'invalid_args'; started: false; error: string };

export const LIST_RECALLS_SCHEMA = {
  type: 'object',
  properties: {
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
  additionalProperties: false,
} as const;

export type ListRecallsArgsCheck =
  | { ok: true; offset: number; limit: number }
  | { ok: false; error: string };

/** Strict validation, enforced by the tool itself regardless of registry support. */
export function validateListRecallsArgs(args: unknown): ListRecallsArgsCheck {
  if (!isPlainObject(args)) return { ok: false, error: 'args must be an object' };
  for (const key of Object.keys(args)) {
    if (key !== 'offset' && key !== 'limit') {
      return { ok: false, error: `unknown key: ${token(key)}` };
    }
  }
  const offset = args.offset === undefined ? 0 : args.offset;
  const limit = args.limit === undefined ? 20 : args.limit;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    return { ok: false, error: 'offset must be an integer >= 0' };
  }
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    return { ok: false, error: 'limit must be an integer 1..50' };
  }
  return { ok: true, offset, limit };
}

/**
 * Read-only metadata listing over the current run's stored calls, in call
 * order. `source` is the only data it can see, so binding it to one run's
 * store keeps other runs out by construction.
 */
export function createListRecallsTool(source: () => readonly RecallEntry[]) {
  return {
    name: 'list_recalls' as const,
    description:
      'List metadata (call_id, tool, step, outcome, stored_bytes) of stored tool results in call order. Use recall with a call_id to read the stored output.',
    idempotent: true as const,
    parameters: LIST_RECALLS_SCHEMA,
    execute(args: unknown): ListRecallsResult {
      const check = validateListRecallsArgs(args);
      if (!check.ok) return { status: 'invalid_args', started: false, error: check.error };
      const all = source();
      const total = all.length;
      const entries: RecallEntry[] = all.slice(check.offset, check.offset + check.limit).map((e) => ({
        call_id: token(e.call_id),
        tool: token(e.tool),
        step: count(e.step),
        outcome: token(e.outcome),
        stored_bytes: count(e.stored_bytes),
      }));
      for (;;) {
        const output: ListRecallsOutput = {
          ok: true,
          total,
          has_more: check.offset + entries.length < total,
          entries,
        };
        if (entries.length === 0 || measureRequestBytes(output) <= LIST_RECALLS_MAX_OUTPUT_BYTES) {
          return { status: 'ok', started: true, output };
        }
        entries.pop();
      }
    },
  };
}

/** Classifier predicate for list_recalls: outer status=ok and output.ok=true. */
export function isListRecallsSuccess(result: unknown): boolean {
  if (!isPlainObject(result) || result.status !== 'ok') return false;
  const output = result.output;
  return isPlainObject(output) && output.ok === true;
}
