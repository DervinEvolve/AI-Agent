/**
 * ImprovementCycle (cap_improvement_cycle_51).
 *
 * Host-invoked, opt-in orchestrator: score a frozen incumbent, build an
 * allowlisted failure digest from baseline dev trials, obtain bounded
 * StrategyOverlay candidates, re-test each against the incumbent, and accept
 * one only on a dev gain with no per-task holdout loss.
 *
 * The trial executor and the proposer are injected ports (TrialRunner,
 * OverlayProposer). This module imports nothing from the rest of the repo; see
 * docs/improvement-cycle-status.md for what is and is not wired.
 */
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- utilities

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    const s = JSON.stringify(v);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const o = v as Record<string, unknown>;
  return (
    '{' +
    Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonical(o[k]))
      .join(',') +
    '}'
  );
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

function isWellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (n < 0xdc00 || n > 0xdfff) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

const TOKEN = /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/;

// ---------------------------------------------------------------- errors

export class ImprovementCycleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImprovementCycleConfigError';
  }
}

export type StopReason = 'model_call_cap' | 'usage_cap' | 'deadline' | 'cancelled' | 'unknown_usage';

export class AdmissionDeniedError extends Error {
  constructor(
    public readonly reason: StopReason,
    public readonly scope: 'cycle' | 'trial',
  ) {
    super('admission denied: ' + reason + ' (' + scope + ')');
    this.name = 'AdmissionDeniedError';
  }
}

export class OverlayAccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverlayAccessDeniedError';
  }
}

export type OverlayRejectReason =
  | 'malformed'
  | 'empty'
  | 'oversize'
  | 'generation_exceeded'
  | 'identical_to_incumbent';

export class OverlayRejectedError extends Error {
  constructor(public readonly reason: OverlayRejectReason) {
    super('overlay rejected: ' + reason);
    this.name = 'OverlayRejectedError';
  }
}

// ---------------------------------------------------------------- admission

export interface AdmissionCaps {
  maxModelCalls?: number;
  maxUsageUnits?: number;
  /** Absolute epoch milliseconds. */
  deadlineAtMs?: number;
}

export interface AdmissionTicket {
  readonly id: number;
}

export interface AdmissionTotals {
  admitted: number;
  denied: number;
  usageUnits: number;
  unknownUsageCalls: number;
  stopReason: StopReason | null;
}

export interface CancelSignal {
  readonly aborted: boolean;
}

/**
 * Atomic admission. reserve() is synchronous, so concurrent children cannot
 * overshoot a cap. A child charges the parent exactly once per send; its own
 * caps can only tighten.
 */
export class CycleAdmission {
  private calls = 0;
  private usage = 0;
  private deniedCount = 0;
  private unknown = 0;
  private nextId = 1;
  private readonly open = new Set<number>();
  private stop: StopReason | null = null;
  /** True when a send from this (child) admission was refused by the cycle. */
  public cycleDenied = false;

  constructor(
    private readonly caps: AdmissionCaps = {},
    private readonly now: () => number = Date.now,
    private readonly signal?: CancelSignal,
    private readonly parent?: CycleAdmission,
  ) {}

  get stopReason(): StopReason | null {
    return this.parent ? this.parent.stopReason : this.stop;
  }

  get totals(): AdmissionTotals {
    return {
      admitted: this.calls,
      denied: this.deniedCount,
      usageUnits: this.usage,
      unknownUsageCalls: this.unknown,
      stopReason: this.stopReason,
    };
  }

  child(caps: { maxModelCalls?: number; maxUsageUnits?: number } = {}): CycleAdmission {
    return new CycleAdmission(caps, this.now, this.signal, this);
  }

  /** Must be called immediately before every model send. Throws AdmissionDeniedError. */
  reserve(): AdmissionTicket {
    if (this.parent) {
      if (this.caps.maxModelCalls !== undefined && this.calls >= this.caps.maxModelCalls) {
        this.deniedCount++;
        throw new AdmissionDeniedError('model_call_cap', 'trial');
      }
      if (this.caps.maxUsageUnits !== undefined && this.usage >= this.caps.maxUsageUnits) {
        this.deniedCount++;
        throw new AdmissionDeniedError('usage_cap', 'trial');
      }
      let ticket: AdmissionTicket;
      try {
        ticket = this.parent.reserve();
      } catch (e) {
        this.cycleDenied = true;
        this.deniedCount++;
        throw e;
      }
      this.calls++;
      this.open.add(ticket.id);
      return ticket;
    }
    let reason: StopReason | null = this.stop;
    if (!reason && this.signal && this.signal.aborted) reason = 'cancelled';
    if (!reason && this.caps.deadlineAtMs !== undefined && this.now() >= this.caps.deadlineAtMs) reason = 'deadline';
    if (!reason && this.caps.maxModelCalls !== undefined && this.calls >= this.caps.maxModelCalls) reason = 'model_call_cap';
    if (!reason && this.caps.maxUsageUnits !== undefined && this.usage >= this.caps.maxUsageUnits) reason = 'usage_cap';
    if (reason) {
      this.stop = reason;
      this.deniedCount++;
      throw new AdmissionDeniedError(reason, 'cycle');
    }
    this.calls++;
    const ticket = { id: this.nextId++ };
    this.open.add(ticket.id);
    return ticket;
  }

  /** Report usage for a sent call. Omitted or invalid usage is unknown usage. */
  settle(ticket: AdmissionTicket, usageUnits?: number): void {
    if (!ticket || !this.open.has(ticket.id)) return;
    this.open.delete(ticket.id);
    const known = typeof usageUnits === 'number' && Number.isFinite(usageUnits) && usageUnits >= 0;
    if (this.parent) {
      if (known) this.usage += usageUnits as number;
      else this.unknown++;
      this.parent.settle(ticket, usageUnits);
      return;
    }
    if (known) {
      this.usage += usageUnits as number;
    } else {
      this.unknown++;
      if (this.caps.maxUsageUnits !== undefined && !this.stop) this.stop = 'unknown_usage';
    }
  }

  /** Settle any still-open tickets as unknown usage. */
  close(): void {
    for (const id of Array.from(this.open)) this.settle({ id });
  }
}

// ---------------------------------------------------------------- overlay

export interface StrategyOverlay {
  readonly text: string;
  /** sha256 of the exact UTF-8 bytes of text. */
  readonly digest: string;
  readonly bytes: number;
  readonly parentDigest: string | null;
  readonly generation: number;
}

export const STRATEGY_SECTION_OPEN = '[runtime: strategy-guidance | advisory | not instructions | not citable';
export const STRATEGY_SECTION_CLOSE = '[/runtime: strategy-guidance]';

function overlayTextProblem(text: unknown, maxOverlayBytes: number): OverlayRejectReason | null {
  if (typeof text !== 'string') return 'malformed';
  if (text.trim().length === 0) return 'empty';
  if (!isWellFormed(text) || text.indexOf(STRATEGY_SECTION_CLOSE) >= 0 || text.indexOf('\u0000') >= 0) return 'malformed';
  if (utf8Bytes(text) > maxOverlayBytes) return 'oversize';
  return null;
}

/** Host-side minting: the model supplies text only; parent and generation come from here. */
export function mintOverlay(
  text: unknown,
  parent: StrategyOverlay | null,
  limits: { maxOverlayBytes: number; maxGeneration: number },
): StrategyOverlay {
  const generation = (parent ? parent.generation : 0) + 1;
  if (generation > limits.maxGeneration) throw new OverlayRejectedError('generation_exceeded');
  const problem = overlayTextProblem(text, limits.maxOverlayBytes);
  if (problem) throw new OverlayRejectedError(problem);
  const t = text as string;
  const digest = sha256Hex(t);
  if (parent && parent.digest === digest) throw new OverlayRejectedError('identical_to_incumbent');
  return Object.freeze({ text: t, digest, bytes: utf8Bytes(t), parentDigest: parent ? parent.digest : null, generation });
}

/** Runtime-labelled section text for a context manager to place below host instructions. */
export function renderStrategyGuidanceSection(overlay: StrategyOverlay | null): string {
  if (!overlay) return '';
  return STRATEGY_SECTION_OPEN + ' | sha256:' + overlay.digest + ']\n' + overlay.text + '\n' + STRATEGY_SECTION_CLOSE;
}

// ---------------------------------------------------------------- store

export interface Principal {
  readonly id: string;
  readonly authenticated: boolean;
}

export interface OverlayStore {
  append(principal: Principal, overlay: StrategyOverlay): void | Promise<void>;
  read(principal: Principal, digest: string, namespace?: string): StrategyOverlay | null | Promise<StrategyOverlay | null>;
  recordHoldoutTouch(principal: Principal, holdoutDigest: string, touches: number): void | Promise<void>;
  holdoutReuse(principal: Principal, holdoutDigest: string): { cycles: number; touches: number } | Promise<{ cycles: number; touches: number }>;
}

function requireAuth(p: Principal): void {
  if (!p || typeof p.id !== 'string' || p.id.length === 0 || p.authenticated !== true) {
    throw new OverlayAccessDeniedError('unauthenticated principal');
  }
}

/** Process-lifetime, append-only, principal-bound store. Not durable across processes. */
export class InMemoryOverlayStore implements OverlayStore {
  private readonly overlays = new Map<string, StrategyOverlay[]>();
  private readonly touches = new Map<string, { holdoutDigest: string; touches: number }[]>();
  private readonly shared = new Set<string>();

  /** Host-only: allow other authenticated principals to read this namespace. */
  authorizeSharedNamespace(namespace: string): void {
    this.shared.add(namespace);
  }

  append(principal: Principal, overlay: StrategyOverlay): void {
    requireAuth(principal);
    if (sha256Hex(overlay.text) !== overlay.digest) throw new Error('overlay digest mismatch');
    const list = this.overlays.get(principal.id) || [];
    if (!list.some((o) => o.digest === overlay.digest)) list.push(Object.freeze({ ...overlay }));
    this.overlays.set(principal.id, list);
  }

  read(principal: Principal, digest: string, namespace?: string): StrategyOverlay | null {
    requireAuth(principal);
    const ns = namespace === undefined ? principal.id : namespace;
    if (ns !== principal.id && !this.shared.has(ns)) throw new OverlayAccessDeniedError('cross-principal read denied');
    return (this.overlays.get(ns) || []).find((o) => o.digest === digest) || null;
  }

  recordHoldoutTouch(principal: Principal, holdoutDigest: string, touches: number): void {
    requireAuth(principal);
    const list = this.touches.get(principal.id) || [];
    list.push({ holdoutDigest, touches });
    this.touches.set(principal.id, list);
  }

  holdoutReuse(principal: Principal, holdoutDigest: string): { cycles: number; touches: number } {
    requireAuth(principal);
    const rows = (this.touches.get(principal.id) || []).filter((r) => r.holdoutDigest === holdoutDigest);
    return { cycles: rows.length, touches: rows.reduce((a, r) => a + r.touches, 0) };
  }
}

// ---------------------------------------------------------------- trials

export type TrialStatus = 'completed_pass' | 'completed_fail' | 'infrastructure_error' | 'not_run';

/** Consolidated finalization outcome. All gates must pass; no single field is a pass. */
export interface ConsolidatedOutcome {
  finalized: boolean;
  evidence: 'pass' | 'fail';
  verifier: 'pass' | 'fail';
  lifecycle: 'pass' | 'fail' | 'not_applicable' | 'unavailable';
}

export interface TrialSignals {
  nonPassCategory?: string;
  outcomeKinds?: string[];
  toolNames?: string[];
  steps?: number;
  recoveryDispatches?: number;
  recoveryRejects?: number;
  extraEnums?: Record<string, string>;
}

/** Anything beyond outcome/infrastructureError/signals is ignored and never proposer-visible. */
export interface TrialResult {
  outcome?: ConsolidatedOutcome;
  infrastructureError?: boolean;
  signals?: TrialSignals;
  [other: string]: unknown;
}

export interface CycleTask {
  id: string;
  contract: { id: string; digest?: string };
  payload?: unknown;
}

export interface TrialRequest {
  readonly task: CycleTask;
  readonly taskIndex: number;
  readonly trialIndex: number;
  readonly split: 'dev' | 'holdout' | 'audit';
  readonly arm: 'incumbent' | 'candidate';
  /** The single overlay for this run (replaces, never stacks), or null. */
  readonly overlay: StrategyOverlay | null;
  readonly strategyGuidanceSection: string;
  readonly configDigest: string;
  readonly toolNames: readonly string[];
  /** Reserve on this before every model send; settle with usage afterwards. */
  readonly admission: CycleAdmission;
  readonly memory: { readonly writesDisabled: true; readonly readSnapshotDigest: string | null };
}

export type TrialRunner = (request: TrialRequest) => Promise<TrialResult>;

export const FAILED_GATES = ['finalization', 'evidence', 'verifier', 'lifecycle'] as const;
export const NON_PASS_CATEGORIES = ['task_failure', 'budget_stop', 'no_finalization', 'refusal', 'other'] as const;
export const DEFAULT_OUTCOME_KINDS = [
  'success', 'tool_error', 'invalid_arguments', 'timeout', 'denied', 'not_found', 'transient', 'permanent', 'unknown',
] as const;

function failedGate(o: ConsolidatedOutcome): string | null {
  if (o.finalized !== true) return 'finalization';
  if (o.evidence !== 'pass') return 'evidence';
  if (o.verifier !== 'pass') return 'verifier';
  if (o.lifecycle !== 'pass' && o.lifecycle !== 'not_applicable') return 'lifecycle';
  return null;
}

/** Score one trial from the consolidated outcome only. */
export function scoreTrial(
  result: TrialResult | null | undefined,
  env: { hasWorkspaceMutatingTool: boolean; workspaceMounted: boolean },
): TrialStatus {
  if (!result || typeof result !== 'object' || result.infrastructureError === true) return 'infrastructure_error';
  const o = result.outcome;
  if (!o || typeof o !== 'object') return 'infrastructure_error';
  const okGate = (g: unknown) => g === 'pass' || g === 'fail';
  if (typeof o.finalized !== 'boolean' || !okGate(o.evidence) || !okGate(o.verifier)) return 'infrastructure_error';
  let lifecycle = o.lifecycle;
  if (lifecycle !== 'pass' && lifecycle !== 'fail' && lifecycle !== 'not_applicable' && lifecycle !== 'unavailable') {
    return 'infrastructure_error';
  }
  if (lifecycle === 'unavailable') {
    if (env.hasWorkspaceMutatingTool) return 'infrastructure_error';
    lifecycle = 'not_applicable';
  }
  if (lifecycle === 'not_applicable' && env.workspaceMounted && env.hasWorkspaceMutatingTool) return 'infrastructure_error';
  return failedGate({ ...o, lifecycle }) === null ? 'completed_pass' : 'completed_fail';
}

// ---------------------------------------------------------------- config & report

export interface ProposerRequest {
  readonly digest: FailureDigest;
  readonly incumbentOverlayText: string | null;
  readonly maxOverlayBytes: number;
  readonly staticHint: string | null;
}

export interface OverlayProposer {
  /** Where the digest is disclosed (recorded in the report). */
  readonly disclosureDestination: string;
  /** Returns overlay text, or { text, usageUnits }. Any other field is ignored. */
  propose(request: ProposerRequest): Promise<unknown>;
}

export interface ImprovementCycleConfig {
  principal: Principal;
  incumbent: {
    configDigest: string;
    model: string;
    overlay: StrategyOverlay | 'none';
    toolNames: string[];
    hasWorkspaceMutatingTool: boolean;
    workspaceMounted: boolean;
  };
  suite: { id: string; tasks: CycleTask[] };
  split: { dev: number[]; holdout: number[]; audit?: number[] };
  trialsPerTask: number;
  maxCandidates: number;
  maxOverlayBytes: number;
  maxGeneration: number;
  proposer: OverlayProposer;
  caps: { maxModelCalls: number; maxUsageUnits?: number; deadlineAtMs?: number; perTrialMaxModelCalls?: number };
  runTrial: TrialRunner;
  digestOptIn?: { outcomeKindEnum?: string[]; extraEnums?: Record<string, string[]>; staticHint?: string };
  memory?: { snapshotDigest: string };
  persistence?: {
    store?: OverlayStore;
    authorizeWrite?: (req: { principal: Principal; overlayDigest: string; text: string }) => boolean | Promise<boolean>;
  };
  maxReportBytes?: number;
  signal?: CancelSignal;
  now?: () => number;
}

export type StatusCounts = Record<TrialStatus, number>;
export interface TaskCounts extends StatusCounts {
  task: number;
}
export interface PairedCounts {
  /** Paired by (task, trial index): incumbent pass and candidate fail. */
  incumbentOnly: number;
  /** Incumbent fail and candidate pass. */
  candidateOnly: number;
}

export interface FailureDigestTask {
  task: number;
  trials: number;
  passes: number;
  failedGates: Record<string, number>;
  categories: Record<string, number>;
  outcomeKinds: Record<string, number>;
  tools: Record<string, number>;
  steps: number;
  recoveryDispatches: number;
  recoveryRejects: number;
  extra: Record<string, Record<string, number>>;
}
export interface FailureDigest {
  schema: 'failure_digest_v1';
  tasks: FailureDigestTask[];
}

export interface CandidateReport {
  index: number;
  overlayDigest: string | null;
  bytes: number | null;
  generation: number | null;
  parentDigest: string | null;
  effectiveConfigDigest: string | null;
  decision: 'accepted' | 'rejected' | 'not_scored';
  reason: string;
  dev?: TaskCounts[];
  holdout?: TaskCounts[];
  devPaired?: PairedCounts;
  holdoutPaired?: PairedCounts;
}

export type FinalDecision = 'kept' | 'accepted_not_persisted' | 'rejected' | 'inconclusive' | 'budget_exhausted';

export interface ImprovementReport {
  nonCitable: true;
  suite: { id: string; digest: string; tasks: number };
  split: { digest: string; dev: number[]; holdout: number[]; audit: number[] };
  model: string;
  principalId: string;
  trialsPerTask: number;
  incumbent: { effectiveConfigDigest: string; overlayDigest: string | null; generation: number };
  baseline: { dev: TaskCounts[]; holdout: TaskCounts[] };
  candidates: CandidateReport[];
  acceptedOverlayDigest: string | null;
  acceptedEffectiveConfigDigest: string | null;
  holdout: { digest: string; touchesThisCycle: number; priorCyclesFromStore: number | null; priorTouchesFromStore: number | null };
  audit: null | { status: 'scored' | 'inconclusive'; incumbentPasses?: number; candidatePasses?: number; regression?: boolean };
  digestAuthorization: { extraEnumFields: string[]; staticHintDigest: string | null; disclosureDestination: string };
  memory: { writesDisabled: true; readSnapshotDigest: string | null };
  decision: FinalDecision;
  decisionReason: string;
  admission: AdmissionTotals;
  proposerCalls: number;
  statement: string;
}

// ---------------------------------------------------------------- validation

function bad(message: string): never {
  throw new ImprovementCycleConfigError(message);
}

function checkIndices(name: string, v: unknown, n: number, required: boolean): number[] {
  if (v === undefined && !required) return [];
  if (!Array.isArray(v) || (required && v.length === 0)) bad('split.' + name + ' must be a non-empty array');
  const arr = v as unknown[];
  const seen = new Set<number>();
  for (const i of arr) {
    if (!isInt(i, 0, n - 1) || seen.has(i)) bad('split.' + name + ' has an invalid or duplicate index');
    seen.add(i as number);
  }
  return arr.slice() as number[];
}

function validate(config: ImprovementCycleConfig) {
  if (!config || typeof config !== 'object') bad('config is required');
  const p = config.principal;
  if (!p || typeof p.id !== 'string' || p.id.length === 0 || p.authenticated !== true) bad('authenticated principal is required');
  const tasks = config.suite && config.suite.tasks;
  if (!config.suite || typeof config.suite.id !== 'string' || !Array.isArray(tasks) || tasks.length === 0) bad('suite with tasks is required');
  if (tasks.length > 32) bad('suite exceeds 32 tasks');
  const ids = new Set<string>();
  for (const t of tasks) {
    if (!t || typeof t.id !== 'string' || t.id.length === 0 || ids.has(t.id)) bad('task id missing or duplicated');
    ids.add(t.id);
    const c = t.contract;
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || c.id.length === 0) bad('task ' + t.id + ' has a missing or malformed contract');
    if (c.digest !== undefined && typeof c.digest !== 'string') bad('task ' + t.id + ' has a malformed contract digest');
  }
  if (!config.split || typeof config.split !== 'object') bad('split is required');
  const dev = checkIndices('dev', config.split.dev, tasks.length, true);
  const holdout = checkIndices('holdout', config.split.holdout, tasks.length, true);
  const audit = checkIndices('audit', config.split.audit, tasks.length, false);
  const all = new Set<number>([...dev, ...holdout, ...audit]);
  if (all.size !== dev.length + holdout.length + audit.length) bad('dev, holdout and audit splits must be disjoint');
  if (!isInt(config.trialsPerTask, 1, 5)) bad('trialsPerTask must be 1-5');
  if (!isInt(config.maxCandidates, 1, 3)) bad('maxCandidates must be 1-3');
  if (!isInt(config.maxOverlayBytes, 1, 2000)) bad('maxOverlayBytes must be 1-2000');
  if (!isInt(config.maxGeneration, 1, 8)) bad('maxGeneration must be 1-8');
  const pr = config.proposer;
  if (!pr || typeof pr.propose !== 'function' || typeof pr.disclosureDestination !== 'string' || pr.disclosureDestination.length === 0) {
    bad('proposer with a disclosure destination is required');
  }
  if (typeof config.runTrial !== 'function') bad('runTrial is required');
  const caps = config.caps;
  if (!caps || !isInt(caps.maxModelCalls, 1, Number.MAX_SAFE_INTEGER)) bad('caps.maxModelCalls is required');
  if (caps.maxUsageUnits !== undefined && !(typeof caps.maxUsageUnits === 'number' && caps.maxUsageUnits > 0)) bad('caps.maxUsageUnits must be positive');
  if (caps.deadlineAtMs !== undefined && !(typeof caps.deadlineAtMs === 'number' && Number.isFinite(caps.deadlineAtMs))) bad('caps.deadlineAtMs must be a number');
  if (caps.perTrialMaxModelCalls !== undefined && !isInt(caps.perTrialMaxModelCalls, 1, Number.MAX_SAFE_INTEGER)) bad('caps.perTrialMaxModelCalls must be a positive integer');
  const inc = config.incumbent;
  if (!inc || typeof inc.configDigest !== 'string' || inc.configDigest.length === 0 || typeof inc.model !== 'string') bad('incumbent configuration is required');
  if (!Array.isArray(inc.toolNames) || inc.toolNames.some((t) => typeof t !== 'string')) bad('incumbent.toolNames must be strings');
  if (typeof inc.hasWorkspaceMutatingTool !== 'boolean' || typeof inc.workspaceMounted !== 'boolean') bad('incumbent workspace flags are required');
  let overlay: StrategyOverlay | null = null;
  if (inc.overlay !== 'none') {
    const o = inc.overlay;
    if (!o || typeof o !== 'object' || overlayTextProblem(o.text, config.maxOverlayBytes) !== null) bad('incumbent overlay must be a valid overlay or the explicit string none');
    if (sha256Hex(o.text) !== o.digest || !isInt(o.generation, 1, config.maxGeneration)) bad('incumbent overlay digest or generation is invalid');
    if (o.parentDigest !== null && typeof o.parentDigest !== 'string') bad('incumbent overlay parent is invalid');
    overlay = Object.freeze({ text: o.text, digest: o.digest, bytes: utf8Bytes(o.text), parentDigest: o.parentDigest, generation: o.generation });
  }
  const opt = config.digestOptIn || {};
  const outcomeKinds = opt.outcomeKindEnum === undefined ? DEFAULT_OUTCOME_KINDS.slice() : opt.outcomeKindEnum;
  if (!Array.isArray(outcomeKinds) || outcomeKinds.some((k) => typeof k !== 'string' || !TOKEN.test(k))) bad('digestOptIn.outcomeKindEnum must be enum tokens');
  const extraEnums: Record<string, string[]> = {};
  if (opt.extraEnums !== undefined) {
    if (!opt.extraEnums || typeof opt.extraEnums !== 'object') bad('digestOptIn.extraEnums is malformed');
    const fields = Object.keys(opt.extraEnums);
    if (fields.length > 8) bad('digestOptIn.extraEnums allows at most 8 fields');
    for (const f of fields) {
      const vals = opt.extraEnums[f];
      if (!TOKEN.test(f) || !Array.isArray(vals) || vals.length === 0 || vals.length > 16 || vals.some((x) => typeof x !== 'string' || !TOKEN.test(x))) {
        bad('digestOptIn.extraEnums.' + f + ' must list enum tokens');
      }
      extraEnums[f] = vals.slice();
    }
  }
  let staticHint: string | null = null;
  if (opt.staticHint !== undefined) {
    if (typeof opt.staticHint !== 'string' || !isWellFormed(opt.staticHint) || utf8Bytes(opt.staticHint) > 500) bad('digestOptIn.staticHint must be text of at most 500 bytes');
    staticHint = opt.staticHint;
  }
  if (config.memory !== undefined && (!config.memory || typeof config.memory.snapshotDigest !== 'string' || config.memory.snapshotDigest.length === 0)) {
    bad('memory.snapshotDigest must be a non-empty string');
  }
  const maxReportBytes = config.maxReportBytes === undefined ? 65536 : config.maxReportBytes;
  if (!isInt(maxReportBytes, 1, 1048576)) bad('maxReportBytes is invalid');
  const scored = dev.length + holdout.length + audit.length;
  const estimate = 3000 + scored * (1 + config.maxCandidates) * 170 + config.maxCandidates * 600;
  if (estimate > maxReportBytes) bad('report cannot fit its bound (' + estimate + ' > ' + maxReportBytes + ' bytes)');
  return { dev, holdout, audit, overlay, outcomeKinds: outcomeKinds.slice(), extraEnums, staticHint, maxReportBytes };
}

// ---------------------------------------------------------------- cycle

interface CleanSignals {
  gate: string | null;
  category: string;
  outcomeKinds: string[];
  tools: string[];
  steps: number;
  recoveryDispatches: number;
  recoveryRejects: number;
  extra: Record<string, string>;
}
interface TaskArm {
  task: number;
  statuses: TrialStatus[];
  signals: (CleanSignals | null)[];
}
interface ArmResult {
  tasks: TaskArm[];
  complete: boolean;
  passes: number;
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 1000000) : 0;
}

function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] || 0) + 1;
}

function sorted(rec: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(rec).sort()) out[k] = rec[k];
  return out;
}

function toCounts(arm: ArmResult): TaskCounts[] {
  return arm.tasks.map((t) => {
    const c: TaskCounts = { task: t.task, completed_pass: 0, completed_fail: 0, infrastructure_error: 0, not_run: 0 };
    for (const s of t.statuses) c[s]++;
    return c;
  });
}

function paired(inc: ArmResult, cand: ArmResult): PairedCounts {
  const out = { incumbentOnly: 0, candidateOnly: 0 };
  inc.tasks.forEach((t, i) => {
    t.statuses.forEach((s, j) => {
      const c = cand.tasks[i].statuses[j];
      if (s === 'completed_pass' && c === 'completed_fail') out.incumbentOnly++;
      if (s === 'completed_fail' && c === 'completed_pass') out.candidateOnly++;
    });
  });
  return out;
}

function taskPasses(t: TaskArm): number {
  return t.statuses.filter((s) => s === 'completed_pass').length;
}

function suiteDigestOf(config: ImprovementCycleConfig): string {
  return sha256Hex(
    canonical({
      id: config.suite.id,
      tasks: config.suite.tasks.map((t) => ({ id: t.id, contractId: t.contract.id, contractDigest: t.contract.digest === undefined ? null : t.contract.digest })),
    }),
  );
}

function effectiveDigest(configDigest: string, overlay: StrategyOverlay | null): string {
  return sha256Hex(canonical({ configDigest, overlayDigest: overlay ? overlay.digest : 'none' }));
}

export const DESCRIPTIVE_STATEMENT_PREFIX = 'Results are descriptive at ';

/**
 * Run one bounded improvement cycle. Throws ImprovementCycleConfigError before
 * any trial or proposer call on invalid configuration.
 */
export async function runImprovementCycle(config: ImprovementCycleConfig): Promise<ImprovementReport> {
  const v = validate(config);
  const inc = config.incumbent;
  const incumbentOverlay = v.overlay;
  const now = config.now || Date.now;
  const admission = new CycleAdmission(
    { maxModelCalls: config.caps.maxModelCalls, maxUsageUnits: config.caps.maxUsageUnits, deadlineAtMs: config.caps.deadlineAtMs },
    now,
    config.signal,
  );
  const suiteDigest = suiteDigestOf(config);
  const splitDigest = sha256Hex(canonical({ suiteDigest, dev: v.dev, holdout: v.holdout, audit: v.audit }));
  const holdoutDigest = sha256Hex(canonical({ suiteDigest, holdout: v.holdout }));
  const toolNames = Object.freeze(inc.toolNames.slice());
  const toolSet = new Set(toolNames);
  const kindSet = new Set(v.outcomeKinds);
  const memory = Object.freeze({ writesDisabled: true as const, readSnapshotDigest: config.memory ? config.memory.snapshotDigest : null });
  const store = config.persistence && config.persistence.store ? config.persistence.store : null;
  const env = { hasWorkspaceMutatingTool: inc.hasWorkspaceMutatingTool, workspaceMounted: inc.workspaceMounted };

  let prior: { cycles: number; touches: number } | null = null;
  if (store) prior = await store.holdoutReuse(config.principal, holdoutDigest);

  const report: ImprovementReport = {
    nonCitable: true,
    suite: { id: config.suite.id, digest: suiteDigest, tasks: config.suite.tasks.length },
    split: { digest: splitDigest, dev: v.dev, holdout: v.holdout, audit: v.audit },
    model: inc.model,
    principalId: config.principal.id,
    trialsPerTask: config.trialsPerTask,
    incumbent: {
      effectiveConfigDigest: effectiveDigest(inc.configDigest, incumbentOverlay),
      overlayDigest: incumbentOverlay ? incumbentOverlay.digest : null,
      generation: incumbentOverlay ? incumbentOverlay.generation : 0,
    },
    baseline: { dev: [], holdout: [] },
    candidates: [],
    acceptedOverlayDigest: null,
    acceptedEffectiveConfigDigest: null,
    holdout: { digest: holdoutDigest, touchesThisCycle: 0, priorCyclesFromStore: prior ? prior.cycles : null, priorTouchesFromStore: prior ? prior.touches : null },
    audit: null,
    digestAuthorization: {
      extraEnumFields: Object.keys(v.extraEnums).sort(),
      staticHintDigest: v.staticHint === null ? null : sha256Hex(v.staticHint),
      disclosureDestination: config.proposer.disclosureDestination,
    },
    memory,
    decision: 'rejected',
    decisionReason: 'no candidate accepted',
    admission: admission.totals,
    proposerCalls: 0,
    statement:
      DESCRIPTIVE_STATEMENT_PREFIX + config.trialsPerTask + ' trial(s) per task on the declared suite only; they are not statistical proof.',
  };

  const clean = (res: TrialResult): CleanSignals => {
    const s: TrialSignals = res.signals && typeof res.signals === 'object' ? res.signals : {};
    const cat = typeof s.nonPassCategory === 'string' && (NON_PASS_CATEGORIES as readonly string[]).indexOf(s.nonPassCategory) >= 0 ? s.nonPassCategory : 'task_failure';
    const list = (x: unknown, allowed: Set<string>) =>
      (Array.isArray(x) ? x.slice(0, 256) : []).map((e) => (typeof e === 'string' && allowed.has(e) ? e : 'other'));
    const extra: Record<string, string> = {};
    const raw = s.extraEnums && typeof s.extraEnums === 'object' ? s.extraEnums : {};
    for (const f of Object.keys(v.extraEnums)) {
      const val = (raw as Record<string, unknown>)[f];
      if (val === undefined) continue;
      extra[f] = typeof val === 'string' && v.extraEnums[f].indexOf(val) >= 0 ? val : 'other';
    }
    return {
      gate: res.outcome ? failedGate(res.outcome) : null,
      category: cat,
      outcomeKinds: list(s.outcomeKinds, kindSet),
      tools: list(s.toolNames, toolSet),
      steps: count(s.steps),
      recoveryDispatches: count(s.recoveryDispatches),
      recoveryRejects: count(s.recoveryRejects),
      extra,
    };
  };

  const runArm = async (arm: 'incumbent' | 'candidate', split: 'dev' | 'holdout' | 'audit', indices: number[], overlay: StrategyOverlay | null): Promise<ArmResult> => {
    if (split === 'holdout') report.holdout.touchesThisCycle++;
    const section = renderStrategyGuidanceSection(overlay);
    const tasks: TaskArm[] = [];
    for (const ti of indices) {
      const ta: TaskArm = { task: ti, statuses: [], signals: [] };
      for (let t = 0; t < config.trialsPerTask; t++) {
        if (admission.stopReason) {
          ta.statuses.push('not_run');
          ta.signals.push(null);
          continue;
        }
        const child = admission.child({ maxModelCalls: config.caps.perTrialMaxModelCalls });
        let status: TrialStatus;
        let sig: CleanSignals | null = null;
        try {
          const res = await config.runTrial(
            Object.freeze({
              task: config.suite.tasks[ti],
              taskIndex: ti,
              trialIndex: t,
              split,
              arm,
              overlay,
              strategyGuidanceSection: section,
              configDigest: inc.configDigest,
              toolNames,
              admission: child,
              memory,
            }),
          );
          child.close();
          if (child.cycleDenied || admission.stopReason) {
            status = 'not_run';
          } else {
            status = scoreTrial(res, env);
            if (status === 'completed_pass' || status === 'completed_fail') sig = clean(res);
          }
        } catch (e) {
          child.close();
          const cycleStop = (e instanceof AdmissionDeniedError && e.scope === 'cycle') || child.cycleDenied || admission.stopReason !== null;
          status = cycleStop ? 'not_run' : 'infrastructure_error';
        }
        ta.statuses.push(status);
        ta.signals.push(sig);
      }
      tasks.push(ta);
    }
    const complete = tasks.every((t) => t.statuses.every((s) => s === 'completed_pass' || s === 'completed_fail'));
    return { tasks, complete, passes: tasks.reduce((a, t) => a + taskPasses(t), 0) };
  };

  const stopDecision = (): FinalDecision => {
    const r = admission.stopReason;
    return r === 'model_call_cap' || r === 'usage_cap' || r === 'deadline' ? 'budget_exhausted' : 'inconclusive';
  };
  const stopText = (where: string): string => where + (admission.stopReason ? ': ' + admission.stopReason : ': infrastructure_error or not_run trial');

  const finish = async (decision: FinalDecision, reason: string): Promise<ImprovementReport> => {
    report.decision = decision;
    report.decisionReason = reason;
    if (suiteDigestOf(config) !== suiteDigest) {
      report.decision = 'inconclusive';
      report.decisionReason = 'suite or contracts mutated during the cycle';
    }
    if (store && report.holdout.touchesThisCycle > 0) {
      await store.recordHoldoutTouch(config.principal, holdoutDigest, report.holdout.touchesThisCycle);
    }
    report.admission = admission.totals;
    if (utf8Bytes(JSON.stringify(report)) > v.maxReportBytes) {
      throw new Error('improvement report exceeded its bound; decision-critical counts are never truncated');
    }
    return report;
  };

  // (1) Baseline.
  const baseDev = await runArm('incumbent', 'dev', v.dev, incumbentOverlay);
  report.baseline.dev = toCounts(baseDev);
  if (!baseDev.complete) return finish(stopDecision(), stopText('baseline dev incomplete'));
  const baseHold = await runArm('incumbent', 'holdout', v.holdout, incumbentOverlay);
  report.baseline.holdout = toCounts(baseHold);
  if (!baseHold.complete) return finish(stopDecision(), stopText('baseline holdout incomplete'));

  // (2) Diagnose: baseline dev only, allowlisted fields only.
  const digest: FailureDigest = {
    schema: 'failure_digest_v1',
    tasks: baseDev.tasks.map((t, opaque) => {
      const d: FailureDigestTask = {
        task: opaque, trials: t.statuses.length, passes: taskPasses(t), failedGates: {}, categories: {}, outcomeKinds: {}, tools: {},
        steps: 0, recoveryDispatches: 0, recoveryRejects: 0, extra: {},
      };
      t.signals.forEach((s, j) => {
        if (!s) return;
        d.steps += s.steps;
        d.recoveryDispatches += s.recoveryDispatches;
        d.recoveryRejects += s.recoveryRejects;
        for (const k of s.outcomeKinds) bump(d.outcomeKinds, k);
        for (const k of s.tools) bump(d.tools, k);
        for (const f of Object.keys(s.extra)) {
          d.extra[f] = d.extra[f] || {};
          bump(d.extra[f], s.extra[f]);
        }
        if (t.statuses[j] === 'completed_fail') {
          if (s.gate) bump(d.failedGates, s.gate);
          bump(d.categories, s.category);
        }
      });
      d.failedGates = sorted(d.failedGates);
      d.categories = sorted(d.categories);
      d.outcomeKinds = sorted(d.outcomeKinds);
      d.tools = sorted(d.tools);
      return d;
    }),
  };
  const request: ProposerRequest = deepFreeze({
    digest,
    incumbentOverlayText: incumbentOverlay ? incumbentOverlay.text : null,
    maxOverlayBytes: config.maxOverlayBytes,
    staticHint: v.staticHint,
  });

  const nextGeneration = report.incumbent.generation + 1;
  if (nextGeneration > config.maxGeneration) {
    report.candidates.push({
      index: 0, overlayDigest: null, bytes: null, generation: nextGeneration, parentDigest: report.incumbent.overlayDigest,
      effectiveConfigDigest: null, decision: 'rejected', reason: 'generation_exceeded',
    });
    return finish('rejected', 'generation above maxGeneration');
  }

  // (3)-(5) Propose, re-test, decide.
  let accepted: StrategyOverlay | null = null;
  for (let i = 0; i < config.maxCandidates && !accepted; i++) {
    const cand: CandidateReport = {
      index: i, overlayDigest: null, bytes: null, generation: nextGeneration, parentDigest: report.incumbent.overlayDigest,
      effectiveConfigDigest: null, decision: 'rejected', reason: '',
    };
    let ticket: AdmissionTicket;
    try {
      ticket = admission.reserve();
    } catch (e) {
      return finish(stopDecision(), stopText('proposer call not admitted'));
    }
    report.proposerCalls++;
    let out: unknown;
    let threw = false;
    try {
      out = await config.proposer.propose(request);
    } catch (e) {
      threw = true;
    }
    const usage = out !== null && typeof out === 'object' ? (out as { usageUnits?: unknown }).usageUnits : undefined;
    admission.settle(ticket, typeof usage === 'number' ? usage : undefined);
    report.candidates.push(cand);
    if (admission.stopReason) {
      cand.decision = 'not_scored';
      cand.reason = 'cycle_stopped';
      return finish(stopDecision(), stopText('stopped after proposer call'));
    }
    if (threw) {
      cand.reason = 'proposer_error';
      continue;
    }
    const text: unknown = typeof out === 'string' ? out : out !== null && typeof out === 'object' ? (out as { text?: unknown }).text : undefined;
    if (typeof text === 'string') cand.bytes = utf8Bytes(text);
    let overlay: StrategyOverlay;
    try {
      overlay = mintOverlay(text, incumbentOverlay, { maxOverlayBytes: config.maxOverlayBytes, maxGeneration: config.maxGeneration });
    } catch (e) {
      cand.reason = e instanceof OverlayRejectedError ? e.reason : 'malformed';
      continue;
    }
    cand.overlayDigest = overlay.digest;
    cand.effectiveConfigDigest = effectiveDigest(inc.configDigest, overlay);

    const dev = await runArm('candidate', 'dev', v.dev, overlay);
    cand.dev = toCounts(dev);
    if (!dev.complete) {
      cand.decision = 'not_scored';
      cand.reason = 'dev_incomplete';
      return finish(stopDecision(), stopText('candidate dev incomplete'));
    }
    cand.devPaired = paired(baseDev, dev);
    if (dev.passes <= baseDev.passes) {
      cand.reason = 'no_dev_gain';
      continue;
    }
    const hold = await runArm('candidate', 'holdout', v.holdout, overlay);
    cand.holdout = toCounts(hold);
    if (!hold.complete) {
      cand.decision = 'not_scored';
      cand.reason = 'holdout_incomplete';
      return finish(stopDecision(), stopText('candidate holdout incomplete'));
    }
    cand.holdoutPaired = paired(baseHold, hold);
    if (hold.tasks.some((t, k) => taskPasses(t) < taskPasses(baseHold.tasks[k]))) {
      cand.reason = 'holdout_task_regression';
      continue;
    }
    cand.decision = 'accepted';
    cand.reason = 'dev_gain_no_holdout_task_loss';
    accepted = overlay;
  }

  if (!accepted) return finish('rejected', 'no candidate accepted');
  report.acceptedOverlayDigest = accepted.digest;
  report.acceptedEffectiveConfigDigest = effectiveDigest(inc.configDigest, accepted);
  let reason = 'accepted on dev gain with no per-task holdout loss';

  // Optional audit split: scored once, never used for selection.
  if (v.audit.length > 0) {
    const a0 = await runArm('incumbent', 'audit', v.audit, incumbentOverlay);
    const a1 = a0.complete ? await runArm('candidate', 'audit', v.audit, accepted) : null;
    if (a1 && a1.complete) {
      const regression = a1.passes < a0.passes;
      report.audit = { status: 'scored', incumbentPasses: a0.passes, candidatePasses: a1.passes, regression };
      if (regression) reason += '; audit regression recorded';
    } else {
      report.audit = { status: 'inconclusive' };
      reason += '; audit inconclusive';
    }
  }

  // Persistence is separate from acceptance and needs host authorization of the exact bytes.
  const authorize = config.persistence && config.persistence.authorizeWrite;
  if (store && typeof authorize === 'function') {
    let ok = false;
    try {
      ok = (await authorize({ principal: config.principal, overlayDigest: accepted.digest, text: accepted.text })) === true;
    } catch (e) {
      ok = false;
    }
    if (ok) {
      await store.append(config.principal, accepted);
      return finish('kept', reason + '; persisted with host authorization (not activated)');
    }
    return finish('accepted_not_persisted', reason + '; write not authorized');
  }
  return finish('accepted_not_persisted', reason + '; no store or authorizer');
}
