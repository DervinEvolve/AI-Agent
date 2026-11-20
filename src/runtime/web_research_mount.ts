import { createHash, randomUUID } from 'node:crypto';
import type { WebSearchAdapter, WebSearchResultItem } from './brave_web_search_adapter.js';
import { SafeWebTransport, canonicalizeHttpsUrl, createProductionWebTransport } from './web_research_transport.js';

export interface WebEgressAuthorizer {
  authorizeSearch(canonicalQuery: string): Promise<boolean> | boolean;
  authorizeFetch(canonicalUrl: string): Promise<boolean> | boolean;
}

export interface WebResearchConfig {
  enabled: true;
  searchAdapter: WebSearchAdapter;
  authorizer: WebEgressAuthorizer;
  maxPageBytes?: number;
  timeoutMs?: number;
  userAgent?: string;
}

export interface WebSnapshot {
  snapshot_id: string;
  url: string;
  text: string;
  codePoints: string[];
  total_code_points: number;
  text_sha256: string;
  fetched_at: string;
  byteLength: number;
}

export class WebSnapshotStore {
  readonly maxSnapshots = 32;
  readonly maxTotalTextBytes = 16777216;
  private readonly snapshots = new Map<string, WebSnapshot>();
  private totalTextBytes = 0;

  put(url: string, text: string): { ok: true; snapshot: WebSnapshot } | { ok: false; code: 'snapshot_limit'; error: string } {
    const byteLength = Buffer.byteLength(text, 'utf8');
    if (this.snapshots.size >= this.maxSnapshots) {
      return { ok: false, code: 'snapshot_limit', error: `Snapshot count limit (${this.maxSnapshots}) exceeded` };
    }
    if (this.totalTextBytes + byteLength > this.maxTotalTextBytes) {
      return { ok: false, code: 'snapshot_limit', error: `Snapshot total text bytes limit (${this.maxTotalTextBytes}) exceeded` };
    }
    const codePoints = Array.from(text);
    const snapshot: WebSnapshot = {
      snapshot_id: `snap_${randomUUID()}`,
      url,
      text,
      codePoints,
      total_code_points: codePoints.length,
      text_sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      fetched_at: new Date().toISOString(),
      byteLength,
    };
    this.snapshots.set(snapshot.snapshot_id, snapshot);
    this.totalTextBytes += byteLength;
    return { ok: true, snapshot };
  }

  get(snapshotId: string): WebSnapshot | undefined {
    return this.snapshots.get(snapshotId);
  }

  sliceCodePoints(snapshotId: string, charStart: number, maxChars: number): { ok: true; text: string; char_start: number; char_end: number; total_code_points: number; has_more: boolean } | { ok: false; error: string } {
    const snap = this.snapshots.get(snapshotId);
    if (!snap) {
      return { ok: false, error: `Unknown snapshot_id: ${snapshotId}` };
    }
    const start = Math.max(0, Math.min(charStart, snap.total_code_points));
    const end = Math.min(start + maxChars, snap.total_code_points);
    return {
      ok: true,
      text: snap.codePoints.slice(start, end).join(''),
      char_start: start,
      char_end: end,
      total_code_points: snap.total_code_points,
      has_more: end < snap.total_code_points,
    };
  }
}

export const WEB_RESEARCH_TOOL_NAMES = ['search_web', 'fetch_web', 'read_web'] as const;

export function validateDelegationAllowedTools(allowedTools: string[] | undefined): void {
  if (!allowedTools) return;
  for (const name of WEB_RESEARCH_TOOL_NAMES) {
    if (allowedTools.includes(name)) {
      throw new Error(`Configuration error: web research tool '${name}' cannot be listed in delegation.allowedTools`);
    }
  }
}

export interface StoredWebToolResult {
  call_id: string;
  run_id: string;
  tool: 'search_web' | 'fetch_web' | 'read_web';
  outer_status: 'ok' | 'error' | 'timeout';
  output: Record<string, unknown>;
}

export type Shape5Citation =
  | { call_id: string; snapshot_id: string; char_start: number; char_end: number }
  | { call_id: string; result_index: number };

export function validateShape5Citation(
  citation: Shape5Citation,
  currentRunId: string,
  storedResults: Map<string, StoredWebToolResult>,
  snapshotStore: WebSnapshotStore
): { valid: boolean; reason?: string } {
  const record = storedResults.get(citation.call_id);
  if (!record || record.run_id !== currentRunId) {
    return { valid: false, reason: 'Missing or prior-run call_id' };
  }
  if (record.outer_status !== 'ok' || record.output.ok !== true) {
    return { valid: false, reason: 'Referenced tool call did not succeed' };
  }

  if ('result_index' in citation) {
    if (record.tool !== 'search_web') {
      return { valid: false, reason: 'result_index citation requires search_web call' };
    }
    const results = record.output.results;
    if (!Array.isArray(results) || !Number.isInteger(citation.result_index) || citation.result_index < 0 || citation.result_index >= results.length) {
      return { valid: false, reason: 'Out-of-bounds result_index' };
    }
    return { valid: true };
  }

  if (record.tool !== 'fetch_web' && record.tool !== 'read_web') {
    return { valid: false, reason: 'snapshot citation requires fetch_web or read_web call' };
  }
  if (record.output.snapshot_id !== citation.snapshot_id) {
    return { valid: false, reason: 'snapshot_id does not match stored ToolResult' };
  }
  const snap = snapshotStore.get(citation.snapshot_id);
  if (!snap) {
    return { valid: false, reason: 'Forged or missing snapshot_id' };
  }
  const { char_start, char_end } = citation;
  if (!Number.isInteger(char_start) || !Number.isInteger(char_end) || char_start < 0 || char_start >= char_end || char_end > snap.total_code_points) {
    return { valid: false, reason: 'Invalid code-point span' };
  }
  if (char_end - char_start > 2000) {
    return { valid: false, reason: 'Citation span exceeds 2000 code points' };
  }
  const recStart = typeof record.output.char_start === 'number' ? record.output.char_start : 0;
  const recEnd = typeof record.output.char_end === 'number' ? record.output.char_end : -1;
  if (char_start < recStart || char_end > recEnd) {
    return { valid: false, reason: 'Citation span outside stored ToolResult [char_start, char_end) range' };
  }
  return { valid: true };
}

export function classifyWebToolOutcome(
  tool: 'search_web' | 'fetch_web' | 'read_web',
  outerStatus: 'ok' | 'error' | 'timeout',
  output: Record<string, unknown>
): 'success' | 'failure' | 'unknown' {
  if (outerStatus === 'timeout') return 'unknown';
  if (outerStatus !== 'ok') return 'failure';
  if (output.ok !== true) return 'failure';
  if (tool === 'search_web' || tool === 'fetch_web') {
    return output.termination_confirmed === true ? 'success' : 'unknown';
  }
  return 'success';
}

function hasUnknownKeys(obj: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(obj).some((k) => !allowed.includes(k));
}

export class WebResearchRuntime {
  private readonly config: WebResearchConfig;
  private readonly transport: SafeWebTransport;
  private readonly snapshotStore = new WebSnapshotStore();
  private readonly deniedDigests = new Set<string>();
  private redirectChainCount = 0;

  constructor(config: WebResearchConfig, transport?: SafeWebTransport) {
    this.config = config;
    this.transport = transport ?? createProductionWebTransport();
  }

  getSnapshotStore(): WebSnapshotStore {
    return this.snapshotStore;
  }

  private async authorize(kind: 'search' | 'fetch', canonical: string): Promise<boolean> {
    const digest = createHash('sha256').update(`${kind}:${canonical}`, 'utf8').digest('hex');
    if (this.deniedDigests.has(digest)) {
      return false;
    }
    try {
      const fn = kind === 'search' ? this.config.authorizer?.authorizeSearch : this.config.authorizer?.authorizeFetch;
      if (typeof fn !== 'function') {
        this.deniedDigests.add(digest);
        return false;
      }
      const timeoutMs = this.config.timeoutMs ?? 10000;
      const allowed = await Promise.race<boolean>([
        Promise.resolve(fn(canonical)),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]);
      if (allowed !== true) {
        this.deniedDigests.add(digest);
        return false;
      }
      return true;
    } catch {
      this.deniedDigests.add(digest);
      return false;
    }
  }

  async searchWeb(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (hasUnknownKeys(args, ['query', 'count'])) {
      return { ok: false, started: false, code: 'invalid_arguments', error: 'Unknown top-level key' };
    }
    if (typeof args.query !== 'string') {
      return { ok: false, started: false, code: 'invalid_arguments', error: 'query must be a string' };
    }
    const canonicalQuery = args.query.trim();
    const cpLen = Array.from(canonicalQuery).length;
    if (cpLen < 1 || cpLen > 512) {
      return { ok: false, started: false, code: 'invalid_arguments', error: 'query must be 1..512 code points' };
    }
    const count = args.count === undefined ? 5 : args.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 10) {
      return { ok: false, started: false, code: 'invalid_arguments', error: 'count must be integer 1..10' };
    }

    const authorized = await this.authorize('search', canonicalQuery);
    if (!authorized) {
      return { ok: false, code: 'authorization_denied', termination_confirmed: false };
    }

    const controller = new AbortController();
    const timeoutMs = this.config.timeoutMs ?? 10000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const items: WebSearchResultItem[] = await this.config.searchAdapter.search(canonicalQuery, count, controller.signal);
      return {
        ok: true,
        results: items.map((item, idx) => ({ result_index: idx, ...item })),
        termination_confirmed: true,
      };
    } catch (err) {
      return {
        ok: false,
        code: 'search_failed',
        error: err instanceof Error ? err.message : String(err),
        termination_confirmed: false,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchWeb(args: Record<string, unknown>, isRedirectFollowUp = false): Promise<Record<string, unknown>> {
    if (hasUnknownKeys(args, ['url'])) {
      return { ok: false, started: false, code: 'invalid_arguments', error: 'Unknown top-level key' };
    }
    if (typeof args.url !== 'string') {
      return { ok: false, started: false, code: 'invalid_arguments', error: 'url must be a string' };
    }
    const cpLen = Array.from(args.url).length;
    if (cpLen < 1 || cpLen > 2048) {
      return { ok: false, started: false, code: 'invalid_arguments', error: 'url must be 1..2048 code points' };
    }

    if (isRedirectFollowUp) {
      if (this.redirectChainCount >= 2) {
        return { ok: false, code: 'redirect_limit', error: 'Maximum redirect chain of 2 hops exceeded', termination_confirmed: false };
      }
      this.redirectChainCount += 1;
    } else {
      this.redirectChainCount = 0;
    }

    const canon = canonicalizeHttpsUrl(args.url);
    if (!canon.ok) {
      return { ok: false, code: 'invalid_url', error: canon.error, termination_confirmed: false };
    }

    const authorized = await this.authorize('fetch', canon.canonical);
    if (!authorized) {
      return { ok: false, code: 'authorization_denied', termination_confirmed: false };
    }

    const resp = await this.transport.fetch({
      url: canon.canonical,
      timeoutMs: this.config.timeoutMs ?? 10000,
      maxPageBytes: this.config.maxPageBytes ?? 2097152,
      userAgent: this.config.userAgent,
    });

    if (!resp.ok) {
      return {
        ok: false,
        code: resp.code ?? 'fetch_failed',
        error: resp.error,
        redirect_url: resp.redirect_url,
        termination_confirmed: resp.termination_confirmed,
      };
    }

    const stored = this.snapshotStore.put(canon.canonical, resp.bodyText ?? '');
    if (!stored.ok) {
      return {
        ok: false,
        code: stored.code,
        error: stored.error,
        termination_confirmed: resp.termination_confirmed,
      };
    }

    const slice = this.snapshotStore.sliceCodePoints(stored.snapshot.snapshot_id, 0, 4000);
    if (!slice.ok) {
      return { ok: false, code: 'snapshot_error', error: slice.error, termination_confirmed: resp.termination_confirmed };
    }

    return {
      ok: true,
      snapshot_id: stored.snapshot.snapshot_id,
      text_sha256: stored.snapshot.text_sha256,
      fetched_at: stored.snapshot.fetched_at,
      total_code_points: slice.total_code_points,
      char_start: slice.char_start,
      char_end: slice.char_end,
      has_more: slice.has_more,
      text: slice.text,
      termination_confirmed: resp.termination_confirmed,
    };
  }

  readWeb(args: Record<string, unknown>): Record<string, unknown> {
    if (hasUnknownKeys(args, ['snapshot_id', 'char_start', 'max_chars'])) {
      return { ok: false, started: false, code: 'invalid_arguments', error: 'Unknown top-level key' };
    }
    if (typeof args.snapshot_id !== 'string' || !args.snapshot_id) {
      return { ok: false, started: false, code: 'invalid_arguments', error: 'snapshot_id must be a non-empty string' };
    }
    const charStart = args.char_start === undefined ? 0 : args.char_start;
    if (typeof charStart !== 'number' || !Number.isInteger(charStart) || charStart < 0) {
      return { ok: false, started: false, code: 'invalid_arguments', error: 'char_start must be integer >= 0' };
    }
    const maxChars = args.max_chars === undefined ? 4000 : args.max_chars;
    if (typeof maxChars !== 'number' || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > 8000) {
      return { ok: false, started: false, code: 'invalid_arguments', error: 'max_chars must be integer 1..8000' };
    }

    const slice = this.snapshotStore.sliceCodePoints(args.snapshot_id, charStart, maxChars);
    if (!slice.ok) {
      return { ok: false, code: 'snapshot_not_found', error: slice.error };
    }
    return {
      ok: true,
      snapshot_id: args.snapshot_id,
      char_start: slice.char_start,
      char_end: slice.char_end,
      total_code_points: slice.total_code_points,
      has_more: slice.has_more,
      text: slice.text,
    };
  }
}
