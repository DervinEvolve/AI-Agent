/**
 * cap_edit_alternatives_67 - contract types and pure helpers.
 *
 * STATUS: BLOCKED SLICE. This file is the contract surface only. It does not
 * register tools, run a child loop, or freeze a workspace. See
 * docs/edit-alternatives-blocker.md for what is missing and why.
 *
 * This module deliberately imports nothing, so it cannot break or be broken
 * by other runtime modules.
 */

// ---------------------------------------------------------------------------
// Caps (inclusive)
// ---------------------------------------------------------------------------

export const ALTERNATIVES_CAPS = Object.freeze({
  maxSetsPerRun: Object.freeze({ default: 1, min: 1, max: 2 }),
  maxAlternatives: Object.freeze({ default: 2, min: 1, max: 2 }),
  maxSteps: Object.freeze({ default: 12, min: 1, max: 24 }),
  parentStepReserve: Object.freeze({ default: 4, min: 2, max: 8 }),
  childRecoveryAllowance: Object.freeze({ default: 1, min: 0, max: 2 }),
  alternativesRecoveryBudget: Object.freeze({ default: 2, min: 0, max: 4 }),
  maxSnapshotBytes: Object.freeze({ default: 64 * 1024 * 1024, min: 1, max: 1024 * 1024 * 1024 }),
  maxSnapshotFiles: Object.freeze({ default: 5000, min: 1, max: 5000 }),
  checkTimeoutMs: Object.freeze({ default: 60_000, min: 1, max: 300_000 }),
  teardownReserveMs: Object.freeze({ default: 10_000, min: 1, max: 30_000 }),
  taskMaxBytes: 4096,
  changedPathsMaxItems: 32,
  changedPathMaxBytes: 256,
  citationsMaxItems: 16,
  citationDescriptorMaxBytes: 512,
  idMaxBytes: 128,
  transcriptMaxBytes: 8 * 1024,
  diffMaxBytes: 256 * 1024,
});

export type RangedCapName =
  | 'maxSetsPerRun'
  | 'maxAlternatives'
  | 'maxSteps'
  | 'parentStepReserve'
  | 'childRecoveryAllowance'
  | 'alternativesRecoveryBudget'
  | 'maxSnapshotBytes'
  | 'maxSnapshotFiles'
  | 'checkTimeoutMs'
  | 'teardownReserveMs';

const RANGED_CAP_NAMES: readonly RangedCapName[] = [
  'maxSetsPerRun',
  'maxAlternatives',
  'maxSteps',
  'parentStepReserve',
  'childRecoveryAllowance',
  'alternativesRecoveryBudget',
  'maxSnapshotBytes',
  'maxSnapshotFiles',
  'checkTimeoutMs',
  'teardownReserveMs',
];

export type ResolvedAlternativesCaps = Record<RangedCapName, number>;

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

export const ALTERNATIVES_REASONS = Object.freeze({
  alternatives_open: 'alternatives_open',
  alternatives_blocked: 'alternatives_blocked',
  alternatives_unavailable: 'alternatives_unavailable',
  alternative_budget_exceeded: 'alternative_budget_exceeded',
  snapshot_too_large: 'snapshot_too_large',
  snapshot_owned: 'snapshot_owned',
  publication_unresolved: 'publication_unresolved',
  not_eligible: 'not_eligible',
  digest_mismatch: 'digest_mismatch',
  base_moved: 'base_moved',
  config_invalid: 'config_invalid',
  no_open_set: 'no_open_set',
  attempt_unsettled: 'attempt_unsettled',
} as const);

export type AlternativesReason = keyof typeof ALTERNATIVES_REASONS;

// ---------------------------------------------------------------------------
// Port, config and record types
// ---------------------------------------------------------------------------

export interface BaseRef {
  base_generation: number;
  base_digest: string;
}

export interface WorkspaceScope {
  alt_id: string;
  snapshot_digest: string;
}

export type DiffEntryKind = 'added' | 'deleted' | 'modified' | 'renamed' | 'type_changed' | 'mode_changed';
export type DiffEntryType = 'file' | 'dir' | 'symlink' | 'hardlink' | 'special';

export interface DiffEntry {
  kind: DiffEntryKind;
  path: string;
  /** Source path of a rename. */
  from_path?: string;
  /** Entry type after the change. */
  entry_type?: DiffEntryType;
  bytes?: number;
}

export type PublicationRecord =
  | { state: 'none' }
  | { state: 'prepared'; alt_id: string; digest: string; expected_base: BaseRef }
  | { state: 'published'; alt_id: string; digest: string; new_generation: number }
  | { state: 'not_published' }
  | { state: 'unresolved'; alt_id?: string; digest?: string };

export type PortFailure = { ok: false; reason: AlternativesReason | string };

/** Injected by the host. The port mints alt_id and owns every snapshot. */
export interface AlternativesPort {
  baseRef(): Promise<BaseRef>;
  snapshot(base: BaseRef): Promise<{ ok: true; alt_id: string } | PortFailure>;
  seal(alt_id: string): Promise<{ ok: true } | PortFailure>;
  digest(alt_id: string): Promise<string>;
  diff(alt_id: string): Promise<{ entries: DiffEntry[]; unified: string; truncated: boolean }>;
  publish(expectedBase: BaseRef, digest: string): Promise<{ ok: true; new_generation: number } | PortFailure>;
  discard(alt_id: string): Promise<{ ok: boolean; cleanup_confirmed: boolean; reason?: string }>;
  publicationRecord(set_id: string): Promise<PublicationRecord>;
}

export interface AlternativesConfig {
  /** Default false. */
  enabled: boolean;
  port?: AlternativesPort;
  /** Opaque host binding for the pinned check; the harness lives outside every snapshot. */
  checkBinding?: { manifest_digest: string };
  minExpectedChecks?: number;
  protectedPaths?: readonly string[];
  childAllowlist?: readonly string[];
  caps?: Partial<ResolvedAlternativesCaps>;
}

export type ScoreStatus = 'passed' | 'failed' | 'no_tests' | 'infra_error';

export interface AttemptScore {
  status: ScoreStatus;
  passed_count: number;
  failed_count: number;
}

export interface ChildCitationDescriptor {
  child_call_id: string;
  tool: string;
  success: boolean;
  workspace_scope: WorkspaceScope;
}

export type ChildOutcome = 'completed' | 'failed' | 'timeout' | 'cancelled' | 'unknown';

/** Full, unbounded attempt report (what the ObservationStore would hold). */
export interface AttemptReport {
  sealed: boolean;
  alt_id: string;
  child_outcome: ChildOutcome;
  snapshot_digest: string;
  check_manifest_digest: string;
  changed_bytes: number;
  changed_paths: readonly string[];
  protected_path_modified: boolean;
  unsafe_entry: boolean;
  tainted: boolean;
  unresolved_unknown?: boolean;
  score: AttemptScore;
  child_citations: readonly ChildCitationDescriptor[];
  cleanup_confirmed: boolean;
}

/** Bounded transcript view, at most ALTERNATIVES_CAPS.transcriptMaxBytes serialized. */
export interface AttemptSealedResult {
  ok: boolean;
  sealed: boolean;
  alt_id: string;
  child_outcome: ChildOutcome;
  snapshot_digest: string;
  check_manifest_digest: string;
  changed_path_count: number;
  changed_bytes: number;
  changed_paths: string[];
  elided_count: number;
  protected_path_modified: boolean;
  unsafe_entry: boolean;
  tainted: boolean;
  score: AttemptScore;
  eligible: boolean;
  child_citations: ChildCitationDescriptor[];
  citation_elided_count: number;
  cleanup_confirmed: boolean;
}

export interface AttemptRefusal {
  ok: false;
  started: false;
  reason: AlternativesReason;
}

export type AttemptResult = AttemptSealedResult | AttemptRefusal;

export interface AttemptRecord {
  alt_id: string;
  call_id: string;
  reasoning_state: 'running' | 'terminal' | 'unknown';
  pending_operations: number;
  sealed: boolean;
  tainted: boolean;
  cleanup_confirmed: boolean;
  reserved_steps: number;
  used_steps: number;
  result?: AttemptSealedResult;
}

export interface AlternativeSetState {
  set_id: string;
  status: 'open' | 'closed';
  base: BaseRef;
  attempts: AttemptRecord[];
  publication: PublicationRecord;
}

// ---------------------------------------------------------------------------
// UTF-8 helpers
// ---------------------------------------------------------------------------

function codePointUtf8Length(cp: number): number {
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3; // includes lone surrogates, encoded as U+FFFD
  return 4;
}

export function utf8ByteLength(text: string): number {
  let n = 0;
  for (const ch of text) n += codePointUtf8Length(ch.codePointAt(0) ?? 0);
  return n;
}

/**
 * Longest prefix of `text` whose UTF-8 encoding is at most `maxBytes`, never
 * splitting a code point (so never a surrogate pair either).
 */
export function truncateUtf8Bytes(
  text: string,
  maxBytes: number,
): { text: string; bytes: number; truncated: boolean } {
  const budget = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
  let bytes = 0;
  let units = 0;
  for (const ch of text) {
    const len = codePointUtf8Length(ch.codePointAt(0) ?? 0);
    if (bytes + len > budget) {
      return { text: text.slice(0, units), bytes, truncated: true };
    }
    bytes += len;
    units += ch.length;
  }
  return { text, bytes, truncated: false };
}

/** attempt_alternative.task must be 1..4096 UTF-8 bytes. */
export function isValidTask(task: unknown): task is string {
  if (typeof task !== 'string') return false;
  const n = utf8ByteLength(task);
  return n >= 1 && n <= ALTERNATIVES_CAPS.taskMaxBytes;
}

// ---------------------------------------------------------------------------
// Protected paths
// ---------------------------------------------------------------------------

/**
 * Normalises a workspace-relative path into components. Backslashes are
 * separators, empty and '.' components are dropped, and '..' is resolved.
 * Returns null when the path escapes the workspace root.
 */
export function normalizePathComponents(path: string): string[] | null {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out;
}

/**
 * True when `path` is, or is inside, any protected path. Matching is by path
 * component, not string prefix. Fails closed: a path that escapes the root,
 * or an unparseable protected entry, counts as a match.
 */
export function matchProtectedPath(path: string, protectedPaths: readonly string[]): boolean {
  const target = normalizePathComponents(path);
  if (target === null) return true;
  for (const entry of protectedPaths) {
    const prot = normalizePathComponents(entry);
    if (prot === null) return true;
    if (prot.length > target.length) continue;
    let all = true;
    for (let i = 0; i < prot.length; i++) {
      if (prot[i] !== target[i]) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/**
 * Classifies a port diff. Both ends of a rename are checked against the
 * protected paths. Any symlink, hardlink or special entry is unsafe.
 */
export function classifyDiff(
  entries: readonly DiffEntry[],
  protectedPaths: readonly string[],
): { protected_path_modified: boolean; unsafe_entry: boolean } {
  let protectedHit = false;
  let unsafe = false;
  for (const e of entries) {
    if (matchProtectedPath(e.path, protectedPaths)) protectedHit = true;
    if (e.from_path !== undefined && matchProtectedPath(e.from_path, protectedPaths)) protectedHit = true;
    if (e.entry_type === 'symlink' || e.entry_type === 'hardlink' || e.entry_type === 'special') unsafe = true;
  }
  return { protected_path_modified: protectedHit, unsafe_entry: unsafe };
}

// ---------------------------------------------------------------------------
// Scoring, eligibility, ranking
// ---------------------------------------------------------------------------

/** Zero executed checks, or fewer than minExpectedChecks, is no_tests and never a pass. */
export function classifyScore(input: {
  passed_count: number;
  failed_count: number;
  minExpectedChecks?: number;
  infra_error?: boolean;
}): AttemptScore {
  const passed_count = Math.max(0, Math.floor(input.passed_count));
  const failed_count = Math.max(0, Math.floor(input.failed_count));
  const executed = passed_count + failed_count;
  const min = Math.max(1, Math.floor(input.minExpectedChecks ?? 1));
  let status: ScoreStatus;
  if (input.infra_error) status = 'infra_error';
  else if (executed === 0 || executed < min) status = 'no_tests';
  else if (failed_count > 0) status = 'failed';
  else status = 'passed';
  return { status, passed_count, failed_count };
}

export function computeEligibility(a: {
  sealed: boolean;
  tainted: boolean;
  score: { status: ScoreStatus };
  protected_path_modified: boolean;
  unsafe_entry: boolean;
  unresolved_unknown?: boolean;
}): boolean {
  return (
    a.sealed === true &&
    a.tainted === false &&
    a.score.status === 'passed' &&
    a.protected_path_modified === false &&
    a.unsafe_entry === false &&
    a.unresolved_unknown !== true
  );
}

export interface RankableAlternative {
  alt_id: string;
  eligible: boolean;
  changed_bytes: number;
  score: { failed_count: number };
}

/**
 * Advisory rank: eligible first, fewer failed, fewer changed_bytes, earlier
 * alt_id (code-unit order, locale independent). Returns a new array.
 */
export function rankAlternatives<T extends RankableAlternative>(alternatives: readonly T[]): T[] {
  return [...alternatives].sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.score.failed_count !== b.score.failed_count) return a.score.failed_count - b.score.failed_count;
    if (a.changed_bytes !== b.changed_bytes) return a.changed_bytes - b.changed_bytes;
    if (a.alt_id < b.alt_id) return -1;
    if (a.alt_id > b.alt_id) return 1;
    return 0;
  });
}

// ---------------------------------------------------------------------------
// Bounded transcript view
// ---------------------------------------------------------------------------

function clampId(value: string): string {
  return truncateUtf8Bytes(String(value), ALTERNATIVES_CAPS.idMaxBytes).text;
}

/**
 * Builds the transcript view of an attempt report.
 *
 * The per-field caps do not imply the total cap (32 paths x 256 bytes is
 * already 8192), so a total byte budget is enforced on the serialized JSON.
 * Deterministic drop order: the last changed path first, until none remain,
 * then the last citation descriptor. Citations are never cut mid-descriptor;
 * an oversized one is elided whole. Paths longer than the per-path cap are
 * shortened on a code-point boundary. The full report stays in the store.
 */
export function boundAttemptResult(report: AttemptReport): AttemptSealedResult {
  const caps = ALTERNATIVES_CAPS;
  const changed_paths = report.changed_paths
    .slice(0, caps.changedPathsMaxItems)
    .map((p) => truncateUtf8Bytes(p, caps.changedPathMaxBytes).text);

  const child_citations: ChildCitationDescriptor[] = [];
  for (const c of report.child_citations) {
    if (child_citations.length >= caps.citationsMaxItems) break;
    const d: ChildCitationDescriptor = {
      child_call_id: c.child_call_id,
      tool: c.tool,
      success: c.success === true,
      workspace_scope: {
        alt_id: c.workspace_scope.alt_id,
        snapshot_digest: c.workspace_scope.snapshot_digest,
      },
    };
    if (utf8ByteLength(JSON.stringify(d)) <= caps.citationDescriptorMaxBytes) child_citations.push(d);
  }

  const score: AttemptScore = {
    status: report.score.status,
    passed_count: report.score.passed_count,
    failed_count: report.score.failed_count,
  };
  const eligible = computeEligibility(report);

  const view: AttemptSealedResult = {
    ok: report.sealed === true,
    sealed: report.sealed === true,
    alt_id: clampId(report.alt_id),
    child_outcome: report.child_outcome,
    snapshot_digest: clampId(report.snapshot_digest),
    check_manifest_digest: clampId(report.check_manifest_digest),
    changed_path_count: report.changed_paths.length,
    changed_bytes: report.changed_bytes,
    changed_paths,
    elided_count: report.changed_paths.length - changed_paths.length,
    protected_path_modified: report.protected_path_modified,
    unsafe_entry: report.unsafe_entry,
    tainted: report.tainted,
    score,
    eligible,
    child_citations,
    citation_elided_count: report.child_citations.length - child_citations.length,
    cleanup_confirmed: report.cleanup_confirmed,
  };

  while (utf8ByteLength(JSON.stringify(view)) > caps.transcriptMaxBytes) {
    if (view.changed_paths.length > 0) {
      view.changed_paths.pop();
      view.elided_count += 1;
    } else if (view.child_citations.length > 0) {
      view.child_citations.pop();
      view.citation_elided_count += 1;
    } else {
      throw new Error('attempt result fixed fields exceed the transcript cap');
    }
  }
  return view;
}

// ---------------------------------------------------------------------------
// Publication record helpers
// ---------------------------------------------------------------------------

/** After a select timeout the outcome is read from the port record only. */
export function reconcilePublication(record: PublicationRecord): 'published' | 'not_published' | 'unresolved' {
  if (record.state === 'published') return 'published';
  if (record.state === 'not_published') return 'not_published';
  return 'unresolved';
}

/** prepared and unresolved keep the quarantine and block abandon, completion and a clean cancel. */
export function isPublicationUnresolved(record: PublicationRecord): boolean {
  return record.state === 'prepared' || record.state === 'unresolved';
}

/** parent_unchanged may be reported only for these states. */
export function parentUnchanged(record: PublicationRecord): boolean {
  return record.state === 'none' || record.state === 'not_published';
}

/**
 * A snapshot named by a prepared, published or unresolved record may not be
 * discarded. An unresolved record that names no snapshot protects all of them.
 */
export function discardRefusal(record: PublicationRecord, alt_id: string): 'snapshot_owned' | null {
  if (record.state === 'prepared' || record.state === 'published') {
    return record.alt_id === alt_id ? ALTERNATIVES_REASONS.snapshot_owned : null;
  }
  if (record.state === 'unresolved') {
    return record.alt_id === undefined || record.alt_id === alt_id ? ALTERNATIVES_REASONS.snapshot_owned : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Caps resolution, reservation and startup checks
// ---------------------------------------------------------------------------

/** Out-of-range values are rejected, not clamped. */
export function resolveAlternativesCaps(
  overrides: Partial<ResolvedAlternativesCaps> = {},
):
  | { ok: true; caps: ResolvedAlternativesCaps }
  | { ok: false; reason: 'config_invalid'; field: RangedCapName } {
  const caps = {} as ResolvedAlternativesCaps;
  for (const name of RANGED_CAP_NAMES) {
    const range = ALTERNATIVES_CAPS[name];
    const value = overrides[name] ?? range.default;
    if (!Number.isInteger(value) || value < range.min || value > range.max) {
      return { ok: false, reason: ALTERNATIVES_REASONS.config_invalid, field: name };
    }
    caps[name] = value;
  }
  return { ok: true, caps };
}

/**
 * Pure reservation decision for one attempt. `parentStepsRemaining` is the
 * parent's remaining step budget after the wrapper's own step is charged.
 * A refusal holds nothing.
 */
export function planAttemptReservation(input: {
  parentStepsRemaining: number;
  recoveryPoolRemaining: number;
  requestedMaxSteps?: number;
  caps: ResolvedAlternativesCaps;
}):
  | { ok: true; reserved_steps: number; reserved_allowance: number }
  | { ok: false; started: false; reason: 'alternative_budget_exceeded' | 'config_invalid' } {
  const range = ALTERNATIVES_CAPS.maxSteps;
  const steps = input.requestedMaxSteps ?? input.caps.maxSteps;
  if (!Number.isInteger(steps) || steps < range.min || steps > range.max) {
    return { ok: false, started: false, reason: ALTERNATIVES_REASONS.config_invalid };
  }
  const allowance = input.caps.childRecoveryAllowance;
  if (
    input.parentStepsRemaining - steps < input.caps.parentStepReserve ||
    input.recoveryPoolRemaining < allowance
  ) {
    return { ok: false, started: false, reason: ALTERNATIVES_REASONS.alternative_budget_exceeded };
  }
  return { ok: true, reserved_steps: steps, reserved_allowance: allowance };
}

export interface AlternativesHostProfile {
  durableRun?: boolean;
  interactiveSession?: boolean;
  workspaceTrials?: boolean;
  backgroundJobs?: boolean;
  asyncWorkers?: boolean;
  toolPrograms?: boolean;
  toolDiscovery?: boolean;
  guiControl?: boolean;
  /** Anything other than 'none' (or undefined) is rejected. */
  egressProfile?: string;
  isolatedCheckBackend?: boolean;
}

/** Startup co-mount rejections. An empty list means alternatives may be mounted. */
export function startupRejections(profile: AlternativesHostProfile): string[] {
  const out: string[] = [];
  if (profile.durableRun) out.push('durable_run');
  if (profile.interactiveSession) out.push('interactive_session');
  if (profile.workspaceTrials) out.push('workspace_trials');
  if (profile.backgroundJobs) out.push('background_jobs');
  if (profile.asyncWorkers) out.push('async_workers');
  if (profile.toolPrograms) out.push('tool_programs');
  if (profile.toolDiscovery) out.push('tool_discovery');
  if (profile.guiControl) out.push('gui_control');
  if (profile.egressProfile !== undefined && profile.egressProfile !== 'none') out.push('egress_profile');
  if (profile.isolatedCheckBackend !== true) out.push('isolated_check_backend_missing');
  return out;
}
