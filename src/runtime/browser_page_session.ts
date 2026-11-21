/**
 * cap_browser_interaction_13 - Stage A orchestration substrate, no real browsing.
 *
 * One page session per run over an injected PageBackend. Pages are observed as
 * bounded accessibility-tree snapshots with runtime-minted element refs and are
 * acted on by ref. No production backend is exported from this module.
 *
 * This module is deliberately self-contained (it imports only node:crypto). It is
 * NOT yet registered in ToolRegistry / OutcomeClassifier / EvidenceValidator /
 * AgentRuntime; see docs/browser-interaction-stage-a.md.
 */
import { createHash, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------- published types

export type PageNode = {
  handle: string;
  role: string;
  name: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  focused?: boolean;
};

export type PageState = {
  url: string;
  title: string;
  /** increments on every main-document replacement */
  docGeneration: number;
  nodes: PageNode[];
  backend_truncated: boolean;
};

export type BackendReport = {
  dispatched: boolean;
  settled: boolean;
  code?: string;
  state?: PageState;
};

export type ActionExpect = { docGeneration: number; origin: string };

export interface PageBackend {
  open(url: string, signal: AbortSignal): Promise<BackendReport>;
  snapshot(signal: AbortSignal): Promise<BackendReport>;
  click(handle: string, expect: ActionExpect, signal: AbortSignal): Promise<BackendReport>;
  type(
    handle: string,
    text: string,
    submit: boolean,
    expect: ActionExpect,
    signal: AbortSignal,
  ): Promise<BackendReport>;
  close(): Promise<void>;
}

export type ActionArtifact = {
  origin: string;
  url: string;
  page_state_id: string;
  operation: 'click' | 'type';
  role: string;
  name: string;
  text?: string;
  submit?: boolean;
};

export interface BrowserAuthorizer {
  authorizeNavigation(canonicalUrl: string): Promise<boolean> | boolean;
  authorizeAction(artifact: ActionArtifact): Promise<boolean> | boolean;
}

export type BrowserConfig = {
  enabled: true;
  backend: PageBackend;
  authorizer: BrowserAuthorizer;
  maxActions: number;
  maxNodes: number;
  timeoutMs: number;
};

export type BrowserToolName = 'browser_open' | 'browser_snapshot' | 'browser_click' | 'browser_type';

export const BROWSER_TOOL_NAMES: readonly BrowserToolName[] = [
  'browser_open',
  'browser_snapshot',
  'browser_click',
  'browser_type',
];

export const BROWSER_TOOL_IDEMPOTENT: Readonly<Record<BrowserToolName, boolean>> = {
  browser_open: false,
  browser_snapshot: true,
  browser_click: false,
  browser_type: false,
};

export type StoredNode = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  focused?: boolean;
};

export type BrowserOutput = {
  ok: boolean;
  code?: string;
  page_state_id: string;
  url: string;
  origin: string;
  title: string;
  nodes: StoredNode[];
  total_nodes: number;
  backend_truncated: boolean;
  dispatched: boolean;
  settled: boolean;
  state_confirmed: boolean;
  navigated: boolean;
};

export type BrowserOutcome = 'success' | 'known_failure' | 'unknown';
export type BrowserStatus = 'ok' | 'error' | 'timeout';

export type BrowserToolResult = {
  call_id: string;
  tool: string;
  /** true iff the backend was invoked for this call */
  started: boolean;
  status: BrowserStatus;
  outcome: BrowserOutcome;
  /** full stored output (recall target) */
  output: BrowserOutput;
  /** bounded transcript rendering (JSON, <= 24 KiB) */
  view: string;
  view_truncated: boolean;
};

export type BrowserCitation = { call_id: string; page_state_id: string; ref: string };

export const VIEW_CAP_BYTES = 24 * 1024;
export const STORED_CAP_BYTES = 2 * 1024 * 1024;
const VIEW_FIELD_CP = 200;

// ---------------------------------------------------------------- helpers

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function wellFormed(s: string): boolean {
  return !LONE_SURROGATE.test(s);
}

function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function boundedStr(v: unknown, maxCp: number): v is string {
  return typeof v === 'string' && wellFormed(v) && cpLen(v) <= maxCp;
}

function intIn(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function hasOnlyKeys(o: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

/** WHATWG-canonicalize; https only; no embedded credentials. */
export function canonicalizeHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !wellFormed(raw)) return null;
  const n = cpLen(raw);
  if (n < 1 || n > 2048) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return null;
  if (cpLen(u.href) > 2048) return null;
  return u.href;
}

// ---------------------------------------------------------------- config

export type BrowserConfigResult =
  | { ok: true; config: BrowserConfig | null }
  | { ok: false; error: string };

const CONFIG_KEYS = ['enabled', 'backend', 'authorizer', 'maxActions', 'maxNodes', 'timeoutMs'];

/**
 * Validates a HostConfig.browser value. Absent or enabled!==true yields config=null
 * (no browser tools). Unknown keys or out-of-range values are rejected.
 */
export function validateBrowserConfig(raw: unknown): BrowserConfigResult {
  if (raw === undefined || raw === null) return { ok: true, config: null };
  if (!isObj(raw)) return { ok: false, error: 'browser config must be an object' };
  for (const k of Object.keys(raw)) {
    if (!CONFIG_KEYS.includes(k)) return { ok: false, error: `unknown browser config key: ${k}` };
  }
  if (raw.enabled !== true) return { ok: true, config: null };
  const b = raw.backend as Record<string, unknown> | undefined;
  if (!isObj(b) || !['open', 'snapshot', 'click', 'type', 'close'].every((m) => typeof b[m] === 'function')) {
    return { ok: false, error: 'browser.backend must implement PageBackend' };
  }
  const a = raw.authorizer as Record<string, unknown> | undefined;
  if (!isObj(a) || typeof a.authorizeNavigation !== 'function' || typeof a.authorizeAction !== 'function') {
    return { ok: false, error: 'browser.authorizer must implement BrowserAuthorizer' };
  }
  const maxActions = raw.maxActions === undefined ? 24 : raw.maxActions;
  const maxNodes = raw.maxNodes === undefined ? 400 : raw.maxNodes;
  const timeoutMs = raw.timeoutMs === undefined ? 10000 : raw.timeoutMs;
  if (!intIn(maxActions, 1, 64)) return { ok: false, error: 'browser.maxActions must be an integer 1..64' };
  if (!intIn(maxNodes, 50, 800)) return { ok: false, error: 'browser.maxNodes must be an integer 50..800' };
  if (!intIn(timeoutMs, 1000, 30000)) return { ok: false, error: 'browser.timeoutMs must be an integer 1000..30000' };
  return {
    ok: true,
    config: {
      enabled: true,
      backend: b as unknown as PageBackend,
      authorizer: a as unknown as BrowserAuthorizer,
      maxActions,
      maxNodes,
      timeoutMs,
    },
  };
}

/** Browser tools may not be delegated to children. */
export function assertNoBrowserToolsDelegated(allowedTools: readonly string[]): void {
  const bad = allowedTools.filter((t) => (BROWSER_TOOL_NAMES as readonly string[]).includes(t));
  if (bad.length > 0) {
    throw new Error(`browser tools cannot be delegated: ${bad.join(', ')}`);
  }
}

// ---------------------------------------------------------------- state validation

export function validatePageState(raw: unknown, maxNodes: number): PageState | null {
  if (!isObj(raw)) return null;
  const url = canonicalizeHttpsUrl(raw.url);
  if (url === null) return null;
  if (!boundedStr(raw.title, 512)) return null;
  if (!intIn(raw.docGeneration, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (typeof raw.backend_truncated !== 'boolean') return null;
  if (!Array.isArray(raw.nodes) || raw.nodes.length > maxNodes) return null;
  const seen = new Set<string>();
  const nodes: PageNode[] = [];
  for (const n of raw.nodes) {
    if (!isObj(n)) return null;
    const h = n.handle;
    if (typeof h !== 'string' || h.length < 1 || h.length > 128 || !wellFormed(h) || seen.has(h)) return null;
    seen.add(h);
    if (!boundedStr(n.role, 64)) return null;
    if (!boundedStr(n.name, 2000)) return null;
    const out: PageNode = { handle: h, role: n.role, name: n.name };
    if (n.value !== undefined) {
      if (!boundedStr(n.value, 2000)) return null;
      out.value = n.value;
    }
    for (const k of ['disabled', 'checked', 'focused'] as const) {
      if (n[k] !== undefined) {
        if (typeof n[k] !== 'boolean') return null;
        out[k] = n[k] as boolean;
      }
    }
    nodes.push(out);
  }
  if (Buffer.byteLength(JSON.stringify(nodes), 'utf8') > STORED_CAP_BYTES - 16 * 1024) return null;
  return { url, title: raw.title, docGeneration: raw.docGeneration, nodes, backend_truncated: raw.backend_truncated };
}

// ---------------------------------------------------------------- classifier

/**
 * Success for open/click/type: status=ok, ok, dispatched, settled, state_confirmed.
 * Known failure: dispatched=false. Unknown: timeout or anything else after dispatch.
 * A success proves no external business outcome.
 */
export function classifyBrowserOutcome(
  tool: string,
  status: BrowserStatus,
  output: Pick<BrowserOutput, 'ok' | 'code' | 'dispatched' | 'settled' | 'state_confirmed'>,
): BrowserOutcome {
  if (tool === 'browser_snapshot') {
    if (status === 'ok' && output.ok === true) return 'success';
    return status === 'timeout' ? 'unknown' : 'known_failure';
  }
  if (status === 'timeout') return 'unknown';
  if (output.dispatched === false) return 'known_failure';
  if (
    status === 'ok' &&
    output.ok === true &&
    output.code === undefined &&
    output.settled === true &&
    output.state_confirmed === true
  ) {
    return 'success';
  }
  return 'unknown';
}

// ---------------------------------------------------------------- view

function clip(s: string): { s: string; cut: boolean } {
  if (s.length <= VIEW_FIELD_CP) return { s, cut: false };
  const cps = Array.from(s);
  if (cps.length <= VIEW_FIELD_CP) return { s, cut: false };
  return { s: cps.slice(0, VIEW_FIELD_CP).join(''), cut: true };
}

/** Renders the transcript view: <= 24 KiB, fields shortened, trailing nodes dropped. */
export function renderBrowserView(output: BrowserOutput): { view: string; view_truncated: boolean } {
  let truncated = false;
  const base = { ...output, nodes: [] as StoredNode[], view_truncated: false };
  let size = Buffer.byteLength(JSON.stringify(base), 'utf8') + 1;
  const kept: StoredNode[] = [];
  for (const n of output.nodes) {
    const name = clip(n.name);
    const node: StoredNode = { ...n, name: name.s };
    let cut = name.cut;
    if (n.value !== undefined) {
      const v = clip(n.value);
      node.value = v.s;
      cut = cut || v.cut;
    }
    const bytes = Buffer.byteLength(JSON.stringify(node), 'utf8') + 1;
    if (size + bytes > VIEW_CAP_BYTES) {
      truncated = true;
      break;
    }
    size += bytes;
    kept.push(node);
    if (cut) truncated = true;
  }
  let view = JSON.stringify({ ...output, nodes: kept, view_truncated: truncated });
  while (Buffer.byteLength(view, 'utf8') > VIEW_CAP_BYTES && kept.length > 0) {
    kept.pop();
    truncated = true;
    view = JSON.stringify({ ...output, nodes: kept, view_truncated: true });
  }
  return { view, view_truncated: truncated };
}

// ---------------------------------------------------------------- session

type BoundState = {
  id: string;
  url: string;
  origin: string;
  title: string;
  docGeneration: number;
  nodes: StoredNode[];
  handles: Map<string, PageNode>;
  backend_truncated: boolean;
  fingerprint: string;
};

type BackendRun = { kind: 'report'; report: unknown } | { kind: 'timeout' } | { kind: 'threw' };

export type BrowserCallOptions = {
  /** remaining run deadline in ms; the call is bounded by min(timeoutMs, remainingMs) */
  remainingMs?: number;
  signal?: AbortSignal;
};

type Partial_ = {
  ok: boolean;
  code?: string;
  dispatched: boolean;
  settled?: boolean;
  state_confirmed?: boolean;
  navigated?: boolean;
  withNodes?: boolean;
};

const TIMEOUT = Symbol('timeout');

export class BrowserSession {
  readonly runId: string;
  private readonly cfg: BrowserConfig;
  private current: BoundState | null = null;
  private refCounter = 0;
  private callCounter = 0;
  private actionsUsed = 0;
  private isQuarantined = false;
  private readonly denied = new Set<string>();
  private readonly results = new Map<string, BrowserToolResult>();
  private tail: Promise<void> = Promise.resolve();
  private closePromise: Promise<{ cleanup_confirmed: boolean }> | null = null;

  constructor(config: BrowserConfig, opts: { runId?: string } = {}) {
    this.cfg = config;
    this.runId = opts.runId ?? randomBytes(8).toString('hex');
  }

  /** true once an action outcome is unknown: open/click/type are refused for the run. */
  get quarantined(): boolean {
    return this.isQuarantined;
  }

  get actionsRemaining(): number {
    return Math.max(0, this.cfg.maxActions - this.actionsUsed);
  }

  get currentPageStateId(): string | null {
    return this.current ? this.current.id : null;
  }

  /** Full stored result for a call of this run (recall). */
  recall(callId: string): BrowserToolResult | undefined {
    return this.results.get(callId);
  }

  /** Calls are serialized: one page, one operation at a time. Never throws. */
  call(tool: string, args: unknown, opts: BrowserCallOptions = {}): Promise<BrowserToolResult> {
    const run = this.tail.then(() => this.dispatch(tool, args, opts));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Runs backend.close() exactly once, bounded by timeoutMs. */
  close(): Promise<{ cleanup_confirmed: boolean }> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const p = Promise.resolve().then(() => this.cfg.backend.close());
        p.catch(() => undefined);
        const r = await Promise.race([
          p.then(() => true),
          new Promise<typeof TIMEOUT>((res) => {
            timer = setTimeout(() => res(TIMEOUT), this.cfg.timeoutMs);
          }),
        ]);
        return { cleanup_confirmed: r === true };
      } catch {
        return { cleanup_confirmed: false };
      } finally {
        if (timer) clearTimeout(timer);
        this.current = null;
      }
    })();
    return this.closePromise;
  }

  /**
   * Citation shape 8: { call_id, page_state_id, ref }. Supports only "the page rendered
   * this element at that state" - provenance, not truth, not a server-side effect.
   */
  validateCitation(c: unknown): { ok: true } | { ok: false; reason: string } {
    if (!isObj(c) || !hasOnlyKeys(c, ['call_id', 'page_state_id', 'ref'])) {
      return { ok: false, reason: 'malformed_citation' };
    }
    if (typeof c.call_id !== 'string' || typeof c.page_state_id !== 'string' || typeof c.ref !== 'string') {
      return { ok: false, reason: 'malformed_citation' };
    }
    const r = this.results.get(c.call_id);
    if (!r) return { ok: false, reason: 'unknown_call_id' };
    if (r.outcome !== 'success') return { ok: false, reason: 'call_not_successful' };
    if (c.page_state_id === '' || r.output.page_state_id !== c.page_state_id) {
      return { ok: false, reason: 'page_state_mismatch' };
    }
    if (!r.output.nodes.some((n) => n.ref === c.ref)) return { ok: false, reason: 'ref_not_in_state' };
    return { ok: true };
  }

  // ------------------------------------------------------------ internals

  private finish(callId: string, tool: string, started: boolean, status: BrowserStatus, p: Partial_): BrowserToolResult {
    const s = this.current;
    const output: BrowserOutput = {
      ok: p.ok,
      ...(p.code !== undefined ? { code: p.code } : {}),
      page_state_id: s ? s.id : '',
      url: s ? s.url : '',
      origin: s ? s.origin : '',
      title: s ? s.title : '',
      nodes: s && p.withNodes ? s.nodes : [],
      total_nodes: s && p.withNodes ? s.nodes.length : 0,
      backend_truncated: s && p.withNodes ? s.backend_truncated : false,
      dispatched: p.dispatched,
      settled: p.settled === true,
      state_confirmed: p.state_confirmed === true,
      navigated: p.navigated === true,
    };
    const outcome = classifyBrowserOutcome(tool, status, output);
    if (outcome === 'unknown' && tool !== 'browser_snapshot') this.isQuarantined = true;
    const { view, view_truncated } = renderBrowserView(output);
    const result: BrowserToolResult = { call_id: callId, tool, started, status, outcome, output, view, view_truncated };
    this.results.set(callId, result);
    return result;
  }

  private reject(callId: string, tool: string, code: string): BrowserToolResult {
    return this.finish(callId, tool, false, 'error', { ok: false, code, dispatched: false });
  }

  private mint(state: PageState): BoundState {
    const handles = new Map<string, PageNode>();
    const nodes: StoredNode[] = state.nodes.map((n) => {
      const ref = `e${++this.refCounter}`;
      handles.set(ref, n);
      const { handle: _h, ...rest } = n;
      return { ref, ...rest };
    });
    return {
      id: `ps_${randomBytes(12).toString('hex')}`,
      url: state.url,
      origin: new URL(state.url).origin,
      title: state.title,
      docGeneration: state.docGeneration,
      nodes,
      handles,
      backend_truncated: state.backend_truncated,
      fingerprint: fingerprint(state),
    };
  }

  /** Fail closed: only a literal `true` within the time budget approves. */
  private async authorize(fn: () => unknown, ms: number): Promise<boolean> {
    if (!(ms > 0)) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const p = Promise.resolve().then(fn);
      p.catch(() => undefined);
      const r = await Promise.race([
        p,
        new Promise<typeof TIMEOUT>((res) => {
          timer = setTimeout(() => res(TIMEOUT), ms);
        }),
      ]);
      return r === true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** A report arriving after the deadline or abort is discarded. */
  private runBackend(
    fn: (signal: AbortSignal) => Promise<BackendReport>,
    ms: number,
    outer?: AbortSignal,
  ): Promise<BackendRun> {
    const ac = new AbortController();
    return new Promise<BackendRun>((resolve) => {
      let done = false;
      const expire = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ac.abort();
        resolve({ kind: 'timeout' });
      };
      const timer = setTimeout(expire, ms);
      if (outer) {
        if (outer.aborted) {
          expire();
          return;
        }
        outer.addEventListener('abort', expire, { once: true });
      }
      let p: Promise<unknown>;
      try {
        p = Promise.resolve(fn(ac.signal));
      } catch (e) {
        p = Promise.reject(e);
      }
      p.then(
        (report) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ kind: 'report', report });
        },
        () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ kind: 'threw' });
        },
      );
    });
  }

  private async dispatch(tool: string, args: unknown, opts: BrowserCallOptions): Promise<BrowserToolResult> {
    const callId = `${this.runId}:b${++this.callCounter}`;
    try {
      if (this.closePromise) return this.reject(callId, tool, 'session_closed');
      if (!(BROWSER_TOOL_NAMES as readonly string[]).includes(tool)) return this.reject(callId, tool, 'unknown_tool');
      const budget = Math.min(this.cfg.timeoutMs, opts.remainingMs === undefined ? Infinity : opts.remainingMs);
      if (!(budget > 0) || (opts.signal && opts.signal.aborted)) return this.reject(callId, tool, 'deadline_exhausted');
      const deadline = Date.now() + budget;
      if (!isObj(args)) return this.reject(callId, tool, 'invalid_arguments');
      switch (tool as BrowserToolName) {
        case 'browser_snapshot':
          return await this.doSnapshot(callId, args, deadline, opts);
        case 'browser_open':
          return await this.doOpen(callId, args, deadline, opts);
        case 'browser_click':
          return await this.doAction(callId, 'browser_click', args, deadline, opts);
        default:
          return await this.doAction(callId, 'browser_type', args, deadline, opts);
      }
    } catch {
      // Internal fault: conservatively unknown for actions.
      this.current = null;
      return this.finish(callId, tool, true, 'error', { ok: false, code: 'internal_error', dispatched: true });
    }
  }

  private async doSnapshot(
    callId: string,
    args: Record<string, unknown>,
    deadline: number,
    opts: BrowserCallOptions,
  ): Promise<BrowserToolResult> {
    const tool = 'browser_snapshot';
    if (Object.keys(args).length !== 0) return this.reject(callId, tool, 'invalid_arguments');
    const run = await this.runBackend((s) => this.cfg.backend.snapshot(s), deadline - Date.now(), opts.signal);
    if (run.kind === 'timeout') {
      return this.finish(callId, tool, true, 'timeout', { ok: false, code: 'timeout', dispatched: false });
    }
    if (run.kind === 'threw') {
      return this.finish(callId, tool, true, 'error', { ok: false, code: 'backend_error', dispatched: false });
    }
    const report = run.report;
    if (!isObj(report)) {
      return this.finish(callId, tool, true, 'error', { ok: false, code: 'malformed_state', dispatched: false });
    }
    if (report.state === undefined) {
      return this.finish(callId, tool, true, 'error', {
        ok: false,
        code: safeCode(report.code, 'snapshot_unavailable'),
        dispatched: false,
      });
    }
    const state = validatePageState(report.state, this.cfg.maxNodes);
    if (!state) {
      return this.finish(callId, tool, true, 'error', { ok: false, code: 'malformed_state', dispatched: false });
    }
    const prior = this.current;
    const same = prior !== null && prior.fingerprint === fingerprint(state);
    if (!same) this.current = this.mint(state);
    return this.finish(callId, tool, true, 'ok', {
      ok: true,
      dispatched: false,
      settled: true,
      state_confirmed: true,
      navigated: prior !== null && !same && (prior.url !== state.url || prior.docGeneration !== state.docGeneration),
      withNodes: true,
    });
  }

  private async doOpen(
    callId: string,
    args: Record<string, unknown>,
    deadline: number,
    opts: BrowserCallOptions,
  ): Promise<BrowserToolResult> {
    const tool = 'browser_open';
    if (!hasOnlyKeys(args, ['url']) || typeof args.url !== 'string') {
      return this.reject(callId, tool, 'invalid_arguments');
    }
    if (this.isQuarantined) return this.reject(callId, tool, 'quarantined');
    const canonical = canonicalizeHttpsUrl(args.url);
    if (canonical === null) return this.reject(callId, tool, 'invalid_url');
    if (this.actionsUsed >= this.cfg.maxActions) return this.reject(callId, tool, 'action_budget_exhausted');
    const key = sha256(`navigation\u0000${canonical}`);
    if (this.denied.has(key)) return this.reject(callId, tool, 'authorization_denied');
    const approved = await this.authorize(
      () => this.cfg.authorizer.authorizeNavigation(canonical),
      deadline - Date.now(),
    );
    if (!approved) {
      this.denied.add(key);
      return this.reject(callId, tool, 'authorization_denied');
    }
    const ms = deadline - Date.now();
    if (!(ms > 0)) return this.reject(callId, tool, 'deadline_exhausted');
    this.actionsUsed++;
    const run = await this.runBackend((s) => this.cfg.backend.open(canonical, s), ms, opts.signal);
    return this.settleAction(callId, tool, run, null);
  }

  private async doAction(
    callId: string,
    tool: 'browser_click' | 'browser_type',
    args: Record<string, unknown>,
    deadline: number,
    opts: BrowserCallOptions,
  ): Promise<BrowserToolResult> {
    const isType = tool === 'browser_type';
    const allowed = isType ? ['page_state_id', 'ref', 'text', 'submit'] : ['page_state_id', 'ref'];
    if (
      !hasOnlyKeys(args, allowed) ||
      !boundedStr(args.page_state_id, 128) ||
      args.page_state_id.length < 1 ||
      !boundedStr(args.ref, 64) ||
      args.ref.length < 1
    ) {
      return this.reject(callId, tool, 'invalid_arguments');
    }
    let text = '';
    let submit = false;
    if (isType) {
      if (!boundedStr(args.text, 2000)) return this.reject(callId, tool, 'invalid_arguments');
      if (args.submit !== undefined && typeof args.submit !== 'boolean') {
        return this.reject(callId, tool, 'invalid_arguments');
      }
      text = args.text;
      submit = args.submit === true;
    }
    if (this.isQuarantined) return this.reject(callId, tool, 'quarantined');
    const state = this.current;
    if (!state || state.id !== args.page_state_id) return this.reject(callId, tool, 'stale_ref');
    const node = state.handles.get(args.ref);
    if (!node) return this.reject(callId, tool, 'unknown_ref');
    if (node.disabled === true) return this.reject(callId, tool, 'element_disabled');
    if (this.actionsUsed >= this.cfg.maxActions) return this.reject(callId, tool, 'action_budget_exhausted');

    const artifact: ActionArtifact = {
      origin: state.origin,
      url: state.url,
      page_state_id: state.id,
      operation: isType ? 'type' : 'click',
      role: node.role,
      name: node.name,
      ...(isType ? { text, submit } : {}),
    };
    const key = sha256(
      JSON.stringify(['action', artifact.operation, state.origin, state.url, node.role, node.name, text, submit]),
    );
    if (this.denied.has(key)) return this.reject(callId, tool, 'authorization_denied');
    const approved = await this.authorize(() => this.cfg.authorizer.authorizeAction(artifact), deadline - Date.now());
    if (!approved) {
      this.denied.add(key);
      return this.reject(callId, tool, 'authorization_denied');
    }
    // Re-check after the asynchronous approval.
    if (this.closePromise) return this.reject(callId, tool, 'session_closed');
    if (this.current !== state) return this.reject(callId, tool, 'stale_ref');
    const ms = deadline - Date.now();
    if (!(ms > 0)) return this.reject(callId, tool, 'deadline_exhausted');
    const expect: ActionExpect = { docGeneration: state.docGeneration, origin: state.origin };
    this.actionsUsed++;
    const run = await this.runBackend(
      (s) =>
        isType
          ? this.cfg.backend.type(node.handle, text, submit, expect, s)
          : this.cfg.backend.click(node.handle, expect, s),
      ms,
      opts.signal,
    );
    return this.settleAction(callId, tool, run, state);
  }

  private settleAction(callId: string, tool: string, run: BackendRun, prior: BoundState | null): BrowserToolResult {
    // Whether the effect happened cannot be known on timeout/throw: assume dispatched.
    if (run.kind === 'timeout') {
      this.current = null;
      return this.finish(callId, tool, true, 'timeout', { ok: false, code: 'timeout', dispatched: true });
    }
    if (run.kind === 'threw') {
      this.current = null;
      return this.finish(callId, tool, true, 'error', { ok: false, code: 'backend_error', dispatched: true });
    }
    const report = run.report;
    if (!isObj(report) || typeof report.dispatched !== 'boolean' || typeof report.settled !== 'boolean') {
      this.current = null;
      return this.finish(callId, tool, true, 'error', { ok: false, code: 'malformed_state', dispatched: true });
    }
    if (report.dispatched === false) {
      // Known failure, no effect: the current state and its refs stay valid.
      const malformed = report.state !== undefined && validatePageState(report.state, this.cfg.maxNodes) === null;
      return this.finish(callId, tool, true, 'error', {
        ok: false,
        code: malformed ? 'malformed_state' : safeCode(report.code, 'backend_error'),
        dispatched: false,
      });
    }
    // Dispatched: every earlier ref is invalid from here on.
    this.current = null;
    const unknown = (code: string) =>
      this.finish(callId, tool, true, 'error', { ok: false, code, dispatched: true, settled: report.settled === true });
    if (report.code !== undefined) return unknown(safeCode(report.code, 'backend_error'));
    if (report.settled !== true) return unknown('not_settled');
    if (report.state === undefined) return unknown('missing_post_state');
    const state = validatePageState(report.state, this.cfg.maxNodes);
    if (!state) return unknown('malformed_state');
    this.current = this.mint(state);
    return this.finish(callId, tool, true, 'ok', {
      ok: true,
      dispatched: true,
      settled: true,
      state_confirmed: true,
      navigated: prior === null || prior.url !== state.url || prior.docGeneration !== state.docGeneration,
      withNodes: true,
    });
  }
}

function fingerprint(state: PageState): string {
  return JSON.stringify([state.docGeneration, state.url, state.title, state.backend_truncated, state.nodes]);
}

function safeCode(v: unknown, fallback: string): string {
  return typeof v === 'string' && /^[a-z0-9_]{1,64}$/.test(v) ? v : fallback;
}

/** Builds a session from a raw HostConfig.browser value; null when absent/disabled. Throws on invalid config. */
export function createBrowserSession(raw: unknown, opts: { runId?: string } = {}): BrowserSession | null {
  const r = validateBrowserConfig(raw);
  if (!r.ok) throw new Error(r.error);
  return r.config ? new BrowserSession(r.config, opts) : null;
}
