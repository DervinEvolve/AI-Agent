/**
 * cap_durable_runs_mount_41 — single-host durable execution mount.
 *
 * Stage A: ownership, append-only RFC 8785 hash-chained journal, digest-named
 * blobs, atomic checkpoints, configuration binding, budget accounting, crash
 * resume. Stage B (ask_user) is not registered here.
 *
 * Executable resume is unavailable unless ownership can be enforced. A leftover
 * lock blocks resume. Lock age, mtime, and PID never imply cessation.
 *
 * Node fs does not supply FileHandle.lock / flock (nodejs/node#54446). This
 * module does not claim a process-lifetime kernel lock. Initial ownership uses
 * exclusive-create ('wx'). Crash takeover requires a supervisor attestation
 * bound to this run and the exact prior generation.
 *
 * Restoration continues the same logical run. Completed dispatches are never
 * replayed. Unsettled intents stay unknown. Effects after a crash before
 * settlement are quarantined and never rewritten as started=false.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export const DURABLE_RUNS_MOUNT_ID = "cap_durable_runs_mount_41" as const;
export const JOURNAL_FORMAT_VERSION = 1 as const;
export const MAX_JOURNAL_RECORDS = 8192;
export const DEFAULT_MAX_STORE_BYTES = 32 * 1024 * 1024;
export const MIN_STORE_BYTES = 1 * 1024 * 1024;
export const MAX_STORE_BYTES = 64 * 1024 * 1024;
export const MAX_BLOB_BYTES = 512 * 1024;
export const MAX_RECORD_BYTES = 64 * 1024;
export const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;
export const ARGUMENT_PREVIEW_CODE_POINTS = 80;
export const RESERVED_TERMINAL_BYTES = 48 * 1024;

export type DurableRunPhase =
  | "idle"
  | "owned"
  | "running"
  | "paused"
  | "completed"
  | "blocked"
  | "quarantined";

export type JournalRecordKind =
  | "genesis"
  | "checkpoint_ref"
  | "dispatch_intent"
  | "settlement"
  | "inference_intent"
  | "inference_settlement"
  | "transition"
  | "clarification_suspended"
  | "clarification_answered"
  | "terminal"
  | "ownership";

export interface SupervisorAttestation {
  readonly runId: string;
  readonly principalId: string;
  readonly priorGeneration: number;
  readonly priorOwnerCeased: true;
  readonly supervisorId: string;
  /** Host binds this token to the exact prior generation. Unbound booleans are refused. */
  readonly attestationToken: string;
}

export interface DurableRunBudgetCaps {
  readonly absoluteDeadlineMs: number;
  readonly maxSteps: number;
  readonly maxTurns: number;
  readonly maxClarifications: number;
  readonly usageCap: number | null;
}

export interface DurableRunManifest {
  readonly version: typeof JOURNAL_FORMAT_VERSION;
  readonly runId: string;
  readonly principalId: string;
  readonly taskDigest: string;
  readonly contractDigest: string;
  readonly verifierIdentity: string;
  readonly toolNames: readonly string[];
  readonly toolSchemaDigest: string;
  readonly implementationIdentities: Readonly<Record<string, string>>;
  readonly resourceIdentities: Readonly<Record<string, string>>;
  readonly budgetCaps: DurableRunBudgetCaps;
  readonly mountConfigDigest: string;
  readonly createdAtMs: number;
}

export interface JournalRecord {
  readonly v: typeof JOURNAL_FORMAT_VERSION;
  readonly seq: number;
  readonly kind: JournalRecordKind;
  readonly runId: string;
  readonly principalId: string;
  readonly generation: number;
  readonly prev: string;
  readonly payloadDigest: string;
  readonly atMs: number;
}

export interface DispatchIntentPayload {
  readonly callId: string;
  readonly toolName: string;
  readonly argumentsDigest: string;
  readonly idempotent: boolean;
  readonly stepAdmission: number;
  readonly turnAdmission: number;
}

export interface SettlementPayload {
  readonly callId: string;
  readonly toolName: string;
  readonly resultDigest: string;
  readonly started: true;
  readonly status: "ok" | "error" | "unknown";
  readonly transitionDigest: string;
}

export interface InferenceIntentPayload {
  readonly inferenceId: string;
  readonly turnAdmission: number;
  readonly usageCapActive: boolean;
}

export interface InferenceSettlementPayload {
  readonly inferenceId: string;
  readonly responseDigest: string | null;
  readonly usage: number | "usage_unknown";
  readonly transitionDigest: string;
}

export interface TransitionPayload {
  readonly name: string;
  readonly beforeDigest: string;
  readonly afterDigest: string;
  readonly externalEffects: "disabled";
}

export interface UsageAdmission {
  readonly steps: number;
  readonly turns: number;
  readonly clarifications: number;
  readonly usage: number;
  readonly usageUnknown: boolean;
}

export interface QuarantineEntry {
  readonly callId: string;
  readonly toolName: string;
  readonly reason: "unsettled_dispatch" | "unsettled_inference" | "descendant_unknown" | "evidence_unavailable";
  readonly resourceIds: readonly string[];
}

export interface RestorableRuntimeState {
  readonly phase: DurableRunPhase;
  readonly nextCallSeq: number;
  readonly reservedCallIds: readonly string[];
  readonly admissions: UsageAdmission;
  readonly deadlineMs: number;
  readonly deadlineExtendedForClarification: boolean;
  readonly suspendedClarification: {
    readonly callId: string;
    readonly questionDigest: string;
    readonly suspendedAtMs: number;
    readonly intervalMs: number;
  } | null;
  readonly quarantine: readonly QuarantineEntry[];
  readonly planDigest: string | null;
  readonly rejectionCount: number;
  readonly recoveryAllowance: number;
  readonly exposureRecordDigests: readonly string[];
  readonly transcriptGroupDigests: readonly string[];
  readonly compactionDigest: string | null;
  readonly terminal: { readonly status: string; readonly digest: string } | null;
  readonly observations: readonly {
    readonly callId: string;
    readonly toolName: string;
    readonly resultDigest: string;
    readonly exposureDigest: string | null;
  }[];
  readonly notice: string;
}

export interface CheckpointBody {
  readonly v: typeof JOURNAL_FORMAT_VERSION;
  readonly runId: string;
  readonly principalId: string;
  readonly generation: number;
  readonly journalPrefixSeq: number;
  readonly journalPrefixDigest: string;
  readonly state: RestorableRuntimeState;
  readonly manifestDigest: string;
}

export interface OwnershipLockFile {
  readonly v: typeof JOURNAL_FORMAT_VERSION;
  readonly runId: string;
  readonly principalId: string;
  readonly generation: number;
  readonly ownerId: string;
  readonly acquiredAtMs: number;
  /** Exclusive-create marker. Not a kernel flock. Age must not be treated as cessation. */
  readonly method: "exclusive-create";
}

export interface DurableRunStore {
  readonly root: string;
  readonly principalId: string;
}

export interface DurableRunsHostOption {
  readonly enabled: boolean;
  readonly principalId: string;
  readonly store: DurableRunStore;
  readonly runId?: string;
  readonly resume?: boolean;
  readonly maxClarifications?: number;
  readonly maxStoreBytes?: number;
  /** Stage B only. Presence without a channel is ignored for registration. */
  readonly clarificationChannel?: unknown;
  readonly resumeReply?: unknown;
}

export interface DirectoryFsyncSupport {
  readonly supported: boolean;
  readonly detail: string;
}

export interface DurableRunNotice {
  readonly unresolved: readonly { readonly callId: string; readonly toolName: string; readonly status: "unknown" }[];
  readonly unavailableResources: readonly string[];
  readonly usageGaps: readonly string[];
  readonly argumentPreviews: readonly { readonly callId: string; readonly preview: string; readonly untrusted: true }[];
  readonly text: string;
}

export class DurableRunsError extends Error {
  readonly code: string;
  readonly fields: readonly string[];
  constructor(code: string, message: string, fields: readonly string[] = []) {
    super(message);
    this.name = "DurableRunsError";
    this.code = code;
    this.fields = fields;
  }
}

const HOST_OPTION_KEYS = new Set([
  "enabled",
  "principalId",
  "store",
  "runId",
  "resume",
  "maxClarifications",
  "maxStoreBytes",
  "clarificationChannel",
  "resumeReply",
]);

const STORE_KEYS = new Set(["root", "principalId"]);

export function inspectDirectoryFsyncSupport(): DirectoryFsyncSupport {
  // node:fs fsyncSync on a directory fd is platform-dependent. Production mount
  // must not be enabled until the host reports support. We probe once.
  const probe = join(process.cwd(), ".durable-fsync-probe-" + randomBytes(4).toString("hex"));
  try {
    mkdirSync(probe, { recursive: true });
    const fd = openSync(probe, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(fd);
      return { supported: true, detail: "directory fsync succeeded on probe" };
    } finally {
      closeSync(fd);
      try {
        rmdirSync(probe);
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    try {
      rmdirSync(probe);
    } catch {
      /* ignore */
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      supported: false,
      detail: `directory fsync unsupported or failed: ${message}. Production durableRuns mount must stay unavailable until the host reports support.`,
    };
  }
}

/** node:fs has no FileHandle.lock. Documented so callers do not invent one. */
export function kernelLockAvailable(): false {
  return false;
}

export function canonicalize(value: unknown): string {
  return rfc8785(value);
}

export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

export function digestBytes(bytes: Buffer | string): string {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return createHash("sha256").update(buf).digest("hex");
}

function rfc8785(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DurableRunsError("noncanonical", "non-finite number in canonical JSON");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((item) => rfc8785(item)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      "{" +
      keys
        .map((key) => JSON.stringify(key) + ":" + rfc8785(obj[key]))
        .join(",") +
      "}"
    );
  }
  throw new DurableRunsError("noncanonical", "unsupported value in canonical JSON");
}

function assertSafeId(id: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new DurableRunsError("unsafe_id", `unsafe ${field}`, [field]);
  }
}

function assertInsideRoot(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
    throw new DurableRunsError("unsafe_path", "path escapes storage root", ["root"]);
  }
  // Reject symlinks along the path.
  let cursor = resolvedRoot;
  const rel = resolved.slice(resolvedRoot.length).split(sep).filter(Boolean);
  if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
    throw new DurableRunsError("unsafe_path", "symlink in storage root", ["root"]);
  }
  for (const part of rel) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new DurableRunsError("unsafe_path", "symlink in storage path", ["root"]);
    }
  }
  return resolved;
}

export function parseDurableRunsOption(raw: unknown): DurableRunsHostOption | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new DurableRunsError("malformed_config", "durableRuns must be an object", ["durableRuns"]);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!HOST_OPTION_KEYS.has(key)) {
      throw new DurableRunsError("unknown_key", `unknown durableRuns key ${key}`, [key]);
    }
  }
  if (typeof obj.enabled !== "boolean") {
    throw new DurableRunsError("malformed_config", "enabled must be boolean", ["enabled"]);
  }
  if (!obj.enabled) {
    return {
      enabled: false,
      principalId: typeof obj.principalId === "string" ? obj.principalId : "",
      store: { root: "", principalId: "" },
    };
  }
  if (typeof obj.principalId !== "string" || obj.principalId.length === 0) {
    throw new DurableRunsError("malformed_config", "principalId required", ["principalId"]);
  }
  assertSafeId(obj.principalId, "principalId");
  if (typeof obj.store !== "object" || obj.store === null || Array.isArray(obj.store)) {
    throw new DurableRunsError("malformed_config", "store required", ["store"]);
  }
  const store = obj.store as Record<string, unknown>;
  for (const key of Object.keys(store)) {
    if (!STORE_KEYS.has(key)) {
      throw new DurableRunsError("unknown_key", `unknown store key ${key}`, [key]);
    }
  }
  if (typeof store.root !== "string" || store.root.length === 0) {
    throw new DurableRunsError("malformed_config", "store.root required", ["store.root"]);
  }
  if (store.principalId !== obj.principalId) {
    throw new DurableRunsError("principal_mismatch", "store principal must match", ["principalId"]);
  }
  let maxClarifications = 2;
  if (obj.maxClarifications !== undefined) {
    if (
      typeof obj.maxClarifications !== "number" ||
      !Number.isInteger(obj.maxClarifications) ||
      obj.maxClarifications < 1 ||
      obj.maxClarifications > 3
    ) {
      throw new DurableRunsError("malformed_config", "maxClarifications must be 1..3", ["maxClarifications"]);
    }
    maxClarifications = obj.maxClarifications;
  }
  let maxStoreBytes = DEFAULT_MAX_STORE_BYTES;
  if (obj.maxStoreBytes !== undefined) {
    if (
      typeof obj.maxStoreBytes !== "number" ||
      !Number.isInteger(obj.maxStoreBytes) ||
      obj.maxStoreBytes < MIN_STORE_BYTES ||
      obj.maxStoreBytes > MAX_STORE_BYTES
    ) {
      throw new DurableRunsError("malformed_config", "maxStoreBytes out of range", ["maxStoreBytes"]);
    }
    maxStoreBytes = obj.maxStoreBytes;
  }
  if (obj.runId !== undefined) {
    if (typeof obj.runId !== "string") {
      throw new DurableRunsError("malformed_config", "runId must be string", ["runId"]);
    }
    assertSafeId(obj.runId, "runId");
  }
  if (obj.resume !== undefined && typeof obj.resume !== "boolean") {
    throw new DurableRunsError("malformed_config", "resume must be boolean", ["resume"]);
  }
  return {
    enabled: true,
    principalId: obj.principalId,
    store: { root: store.root, principalId: obj.principalId },
    runId: typeof obj.runId === "string" ? obj.runId : undefined,
    resume: obj.resume === true,
    maxClarifications,
    maxStoreBytes,
    clarificationChannel: obj.clarificationChannel,
    resumeReply: obj.resumeReply,
  };
}

export function mintRunId(): string {
  return "run_" + randomBytes(12).toString("hex");
}

export function mintOwnerId(): string {
  return "own_" + randomBytes(8).toString("hex");
}

function emptyState(deadlineMs: number): RestorableRuntimeState {
  return {
    phase: "owned",
    nextCallSeq: 1,
    reservedCallIds: [],
    admissions: { steps: 0, turns: 0, clarifications: 0, usage: 0, usageUnknown: false },
    deadlineMs,
    deadlineExtendedForClarification: false,
    suspendedClarification: null,
    quarantine: [],
    planDigest: null,
    rejectionCount: 0,
    recoveryAllowance: 0,
    exposureRecordDigests: [],
    transcriptGroupDigests: [],
    compactionDigest: null,
    terminal: null,
    observations: [],
    notice: "",
  };
}

export interface OpenedDurableRun {
  readonly runId: string;
  readonly principalId: string;
  readonly generation: number;
  readonly ownerId: string;
  readonly manifest: DurableRunManifest;
  readonly state: RestorableRuntimeState;
  readonly journalTipDigest: string;
  readonly journalSeq: number;
  readonly executableResume: boolean;
  readonly ownershipEnforced: boolean;
  readonly directoryFsync: DirectoryFsyncSupport;
  readonly notice: DurableRunNotice;
  readonly productionMountAvailable: boolean;
}

export class DurableRunSession {
  private readonly option: DurableRunsHostOption;
  private readonly runDir: string;
  private readonly maxStoreBytes: number;
  private generation: number;
  private ownerId: string;
  private manifest: DurableRunManifest;
  private state: RestorableRuntimeState;
  private records: JournalRecord[] = [];
  private tip = "0".repeat(64);
  private closed = false;
  private readonly directoryFsync: DirectoryFsyncSupport;
  private readonly productionMountAvailable: boolean;
  private executableResume: boolean;

  private constructor(
    option: DurableRunsHostOption,
    runDir: string,
    generation: number,
    ownerId: string,
    manifest: DurableRunManifest,
    state: RestorableRuntimeState,
    records: JournalRecord[],
    tip: string,
    directoryFsync: DirectoryFsyncSupport,
    executableResume: boolean,
  ) {
    this.option = option;
    this.runDir = runDir;
    this.maxStoreBytes = option.maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES;
    this.generation = generation;
    this.ownerId = ownerId;
    this.manifest = manifest;
    this.state = state;
    this.records = records;
    this.tip = tip;
    this.directoryFsync = directoryFsync;
    this.productionMountAvailable = directoryFsync.supported && executableResume;
    this.executableResume = executableResume;
  }

  static open(args: {
    option: unknown;
    manifestInput: Omit<DurableRunManifest, "version" | "createdAtMs" | "runId" | "principalId"> &
      Partial<Pick<DurableRunManifest, "runId">>;
    nowMs: number;
    attestation?: SupervisorAttestation;
    requireDirectoryFsync?: boolean;
  }): DurableRunSession {
    const option = parseDurableRunsOption(args.option);
    if (!option || !option.enabled) {
      throw new DurableRunsError("disabled", "durable runs disabled");
    }
    const fsync = inspectDirectoryFsyncSupport();
    if (args.requireDirectoryFsync && !fsync.supported) {
      throw new DurableRunsError(
        "directory_fsync_unsupported",
        fsync.detail,
        ["directoryFsync"],
      );
    }
    const root = assertInsideRoot(option.store.root, option.store.root);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const runId = option.runId ?? args.manifestInput.runId ?? mintRunId();
    assertSafeId(runId, "runId");
    const runDir = assertInsideRoot(root, join(root, option.principalId, runId));
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(runDir, "blobs"), { recursive: true, mode: 0o700 });
    mkdirSync(join(runDir, "tmp"), { recursive: true, mode: 0o700 });

    const manifest: DurableRunManifest = {
      version: JOURNAL_FORMAT_VERSION,
      runId,
      principalId: option.principalId,
      taskDigest: args.manifestInput.taskDigest,
      contractDigest: args.manifestInput.contractDigest,
      verifierIdentity: args.manifestInput.verifierIdentity,
      toolNames: [...args.manifestInput.toolNames],
      toolSchemaDigest: args.manifestInput.toolSchemaDigest,
      implementationIdentities: { ...args.manifestInput.implementationIdentities },
      resourceIdentities: { ...args.manifestInput.resourceIdentities },
      budgetCaps: args.manifestInput.budgetCaps,
      mountConfigDigest: args.manifestInput.mountConfigDigest,
      createdAtMs: args.nowMs,
    };

    const journalPath = join(runDir, "journal.jsonl");
    const lockPath = join(runDir, "owner.lock");
    const existing = existsSync(journalPath);

    if (!existing && !option.resume) {
      const ownerId = mintOwnerId();
      exclusiveCreateLock(lockPath, {
        v: JOURNAL_FORMAT_VERSION,
        runId,
        principalId: option.principalId,
        generation: 1,
        ownerId,
        acquiredAtMs: args.nowMs,
        method: "exclusive-create",
      });
      const session = new DurableRunSession(
        option,
        runDir,
        1,
        ownerId,
        manifest,
        emptyState(manifest.budgetCaps.absoluteDeadlineMs),
        [],
        "0".repeat(64),
        fsync,
        true,
      );
      session.writeBlob(digestOf(manifest), manifest);
      session.appendRecord("genesis", { manifestDigest: digestOf(manifest) }, args.nowMs);
      session.checkpoint(args.nowMs);
      return session;
    }

    if (!existing) {
      throw new DurableRunsError("missing_run", "resume requested but no journal", ["runId"]);
    }

    const loaded = loadJournal(runDir, option.principalId, runId);
    const storedManifest = loaded.manifest;
    assertManifestCompatible(storedManifest, manifest);

    const lock = readLock(lockPath);
    if (!lock) {
      throw new DurableRunsError("ownership_unavailable", "missing ownership record blocks resume", ["owner.lock"]);
    }
    if (lock.runId !== runId || lock.principalId !== option.principalId) {
      throw new DurableRunsError("principal_mismatch", "lock principal/run mismatch", ["principalId", "runId"]);
    }

    let generation = lock.generation;
    let ownerId = lock.ownerId;
    let executable = false;

    if (args.attestation) {
      const att = args.attestation;
      if (att.runId !== runId || att.principalId !== option.principalId) {
        throw new DurableRunsError("attestation_rejected", "attestation not bound to this run", ["runId", "principalId"]);
      }
      if (att.priorGeneration !== lock.generation) {
        throw new DurableRunsError(
          "attestation_rejected",
          "attestation must bind the exact previous owner generation",
          ["priorGeneration"],
        );
      }
      if (att.priorOwnerCeased !== true || typeof att.attestationToken !== "string" || att.attestationToken.length < 8) {
        throw new DurableRunsError("attestation_rejected", "unbound or incomplete supervisor attestation", ["attestationToken"]);
      }
      if (typeof att.supervisorId !== "string" || att.supervisorId.length === 0) {
        throw new DurableRunsError("attestation_rejected", "supervisorId required", ["supervisorId"]);
      }
      // Serialize takeover: exclusive rename of lock to lock.taking then replace.
      const taking = lockPath + ".taking";
      try {
        exclusiveCreateLock(taking, { ...lock, method: "exclusive-create" });
      } catch {
        throw new DurableRunsError(
          "takeover_conflict",
          "concurrent takeover cannot both succeed",
          ["owner.lock"],
        );
      }
      generation = lock.generation + 1;
      ownerId = mintOwnerId();
      const next: OwnershipLockFile = {
        v: JOURNAL_FORMAT_VERSION,
        runId,
        principalId: option.principalId,
        generation,
        ownerId,
        acquiredAtMs: args.nowMs,
        method: "exclusive-create",
      };
      atomicWrite(runDir, lockPath, Buffer.from(canonicalize(next), "utf8"));
      try {
        unlinkSync(taking);
      } catch {
        /* winner already published lock */
      }
      executable = true;
    } else if (option.resume) {
      // Leftover lock blocks resume. Do not infer cessation from age, mtime, or PID.
      throw new DurableRunsError(
        "leftover_lock",
        "leftover ownership lock blocks resume without supervisor attestation bound to the exact prior generation",
        ["owner.lock"],
      );
    } else {
      throw new DurableRunsError("run_exists", "run already exists", ["runId"]);
    }

    const replayed = replayPrefix(loaded.records, loaded.blobs, storedManifest);
    const session = new DurableRunSession(
      option,
      runDir,
      generation,
      ownerId,
      storedManifest,
      replayed.state,
      loaded.records,
      loaded.tip,
      fsync,
      executable,
    );
    if (executable) {
      session.appendRecord(
        "ownership",
        {
          generation,
          ownerId,
          priorGeneration: generation - 1,
          supervisorId: args.attestation?.supervisorId,
          attestationBound: true,
          dishonestHostAttestationOutsideGuarantee: true,
        },
        args.nowMs,
      );
    }
    return session;
  }

  get snapshot(): OpenedDurableRun {
    return {
      runId: this.manifest.runId,
      principalId: this.manifest.principalId,
      generation: this.generation,
      ownerId: this.ownerId,
      manifest: this.manifest,
      state: this.state,
      journalTipDigest: this.tip,
      journalSeq: this.records.length,
      executableResume: this.executableResume,
      ownershipEnforced: true,
      directoryFsync: this.directoryFsync,
      notice: this.renderNotice(),
      productionMountAvailable: this.productionMountAvailable && this.executableResume,
    };
  }

  assertWritableGeneration(generation: number): void {
    if (this.closed) throw new DurableRunsError("closed", "session closed");
    if (generation !== this.generation) {
      throw new DurableRunsError("stale_generation", "stale ownership generation refused", ["generation"]);
    }
  }

  deadlineExpired(nowMs: number): boolean {
    return nowMs > this.state.deadlineMs;
  }

  /**
   * Reserve admission and storage, publish arguments blob, append dispatch_intent.
   * Does not invoke the tool. Caller must not retry a completed or unknown call.
   */
  beginDispatch(args: {
    generation: number;
    callId: string;
    toolName: string;
    toolArguments: unknown;
    idempotent: boolean;
    nowMs: number;
  }): { started: false; code: "store_full" | "deadline" | "unknown_blocks" | "call_id_collision" } | { started: true; argumentsDigest: string } {
    this.assertWritableGeneration(args.generation);
    if (!this.executableResume && this.records.some((r) => r.kind !== "genesis")) {
      throw new DurableRunsError("resume_unavailable", "executable resume unavailable");
    }
    if (this.deadlineExpired(args.nowMs)) {
      return { started: false, code: "deadline" };
    }
    if (this.state.admissions.usageUnknown) {
      return { started: false, code: "unknown_blocks" };
    }
    if (this.state.quarantine.some((q) => q.reason === "unsettled_dispatch" || q.reason === "unsettled_inference")) {
      return { started: false, code: "unknown_blocks" };
    }
    if (this.state.reservedCallIds.includes(args.callId) || this.state.observations.some((o) => o.callId === args.callId)) {
      return { started: false, code: "call_id_collision" };
    }
    if (this.state.admissions.steps >= this.manifest.budgetCaps.maxSteps) {
      return { started: false, code: "store_full" };
    }
    const projected = this.bytesUsed() + RESERVED_TERMINAL_BYTES + MAX_RECORD_BYTES + MAX_BLOB_BYTES;
    if (this.records.length >= MAX_JOURNAL_RECORDS || projected > this.maxStoreBytes) {
      return { started: false, code: "store_full" };
    }
    const argumentsDigest = this.writeBlob(digestOf(args.toolArguments), args.toolArguments);
    const nextAdmissions: UsageAdmission = {
      ...this.state.admissions,
      steps: this.state.admissions.steps + 1,
    };
    const payload: DispatchIntentPayload = {
      callId: args.callId,
      toolName: args.toolName,
      argumentsDigest,
      idempotent: args.idempotent,
      stepAdmission: nextAdmissions.steps,
      turnAdmission: nextAdmissions.turns,
    };
    this.state = {
      ...this.state,
      admissions: nextAdmissions,
      reservedCallIds: [...this.state.reservedCallIds, args.callId],
      phase: "running",
    };
    this.appendRecord("dispatch_intent", payload, args.nowMs);
    return { started: true, argumentsDigest };
  }

  /**
   * After an actual effect, settlement failure must not rewrite started=false.
   * Missing result blob prevents executable resume (evidence_unavailable).
   */
  settleDispatch(args: {
    generation: number;
    callId: string;
    toolName: string;
    result: unknown;
    status: "ok" | "error" | "unknown";
    transition: unknown;
    nowMs: number;
    exposure?: unknown;
  }): { started: true; settled: boolean; code?: "evidence_unavailable" } {
    this.assertWritableGeneration(args.generation);
    const intent = this.findIntent(args.callId);
    if (!intent) {
      throw new DurableRunsError("unknown_call", "no dispatch intent for call", ["callId"]);
    }
    if (this.findSettlement(args.callId)) {
      return { started: true, settled: true };
    }
    let resultDigest: string;
    let transitionDigest: string;
    try {
      resultDigest = this.writeBlob(digestOf(args.result), args.result);
      transitionDigest = this.writeBlob(digestOf(args.transition), args.transition);
    } catch {
      this.quarantineUnsettled(args.callId, args.toolName, "evidence_unavailable");
      this.state = { ...this.state, phase: "quarantined" };
      return { started: true, settled: false, code: "evidence_unavailable" };
    }
    const payload: SettlementPayload = {
      callId: args.callId,
      toolName: args.toolName,
      resultDigest,
      started: true,
      status: args.status,
      transitionDigest,
    };
    try {
      this.appendRecord("settlement", payload, args.nowMs);
    } catch {
      this.quarantineUnsettled(args.callId, args.toolName, "evidence_unavailable");
      return { started: true, settled: false, code: "evidence_unavailable" };
    }
    const exposureDigest = args.exposure === undefined ? null : this.writeBlob(digestOf(args.exposure), args.exposure);
    this.state = {
      ...this.state,
      observations: [
        ...this.state.observations,
        { callId: args.callId, toolName: args.toolName, resultDigest, exposureDigest },
      ],
      exposureRecordDigests: exposureDigest
        ? [...this.state.exposureRecordDigests, exposureDigest]
        : this.state.exposureRecordDigests,
    };
    return { started: true, settled: true };
  }

  /**
   * Crash recovery classification: intents without settlement become unknown.
   * Never replay. Never rewrite as started=false.
   */
  classifyUnsettled(): readonly QuarantineEntry[] {
    return this.state.quarantine;
  }

  beginInference(args: {
    generation: number;
    inferenceId: string;
    nowMs: number;
    usageCapActive: boolean;
  }): { admitted: false; code: "deadline" | "unknown_usage" | "store_full" } | { admitted: true } {
    this.assertWritableGeneration(args.generation);
    if (this.deadlineExpired(args.nowMs)) return { admitted: false, code: "deadline" };
    if (this.state.admissions.usageUnknown && args.usageCapActive) {
      return { admitted: false, code: "unknown_usage" };
    }
    if (this.state.admissions.turns >= this.manifest.budgetCaps.maxTurns) {
      return { admitted: false, code: "store_full" };
    }
    if (this.records.length >= MAX_JOURNAL_RECORDS || this.bytesUsed() + RESERVED_TERMINAL_BYTES > this.maxStoreBytes) {
      return { admitted: false, code: "store_full" };
    }
    const payload: InferenceIntentPayload = {
      inferenceId: args.inferenceId,
      turnAdmission: this.state.admissions.turns + 1,
      usageCapActive: args.usageCapActive,
    };
    this.state = {
      ...this.state,
      admissions: { ...this.state.admissions, turns: this.state.admissions.turns + 1 },
      phase: "running",
    };
    this.appendRecord("inference_intent", payload, args.nowMs);
    return { admitted: true };
  }

  settleInference(args: {
    generation: number;
    inferenceId: string;
    response: unknown | null;
    usage: number | "usage_unknown";
    transition: unknown;
    nowMs: number;
  }): void {
    this.assertWritableGeneration(args.generation);
    const responseDigest = args.response === null ? null : this.writeBlob(digestOf(args.response), args.response);
    const transitionDigest = this.writeBlob(digestOf(args.transition), args.transition);
    const payload: InferenceSettlementPayload = {
      inferenceId: args.inferenceId,
      responseDigest,
      usage: args.usage,
      transitionDigest,
    };
    const usageUnknown = args.usage === "usage_unknown";
    this.state = {
      ...this.state,
      admissions: {
        ...this.state.admissions,
        usage: usageUnknown ? this.state.admissions.usage : this.state.admissions.usage + args.usage,
        usageUnknown: this.state.admissions.usageUnknown || usageUnknown,
      },
    };
    this.appendRecord("inference_settlement", payload, args.nowMs);
  }

  /**
   * Replay a runtime transition with external effects disabled.
   * Does not fork a second execution loop; caller supplies the already-computed after-state digest.
   */
  recordTransition(args: {
    generation: number;
    name: string;
    before: unknown;
    after: unknown;
    nowMs: number;
    patch?: Partial<RestorableRuntimeState>;
  }): void {
    this.assertWritableGeneration(args.generation);
    const payload: TransitionPayload = {
      name: args.name,
      beforeDigest: digestOf(args.before),
      afterDigest: digestOf(args.after),
      externalEffects: "disabled",
    };
    this.appendRecord("transition", payload, args.nowMs);
    if (args.patch) {
      this.state = { ...this.state, ...args.patch };
    }
  }

  /**
   * Extend absolute deadline by a committed clarification suspension interval exactly once.
   * A reply alone does not extend time.
   */
  commitClarificationResume(args: {
    generation: number;
    suspensionIntervalMs: number;
    nowMs: number;
  }): void {
    this.assertWritableGeneration(args.generation);
    if (this.state.deadlineExtendedForClarification) {
      throw new DurableRunsError("deadline_reset_forbidden", "repeated resume cannot reset or extend time again", [
        "absoluteDeadlineMs",
      ]);
    }
    if (!this.state.suspendedClarification) {
      throw new DurableRunsError("no_suspension", "no committed clarification suspension", ["suspendedClarification"]);
    }
    if (args.suspensionIntervalMs !== this.state.suspendedClarification.intervalMs) {
      throw new DurableRunsError("suspension_mismatch", "interval must match committed suspension", [
        "suspensionIntervalMs",
      ]);
    }
    this.state = {
      ...this.state,
      deadlineMs: this.state.deadlineMs + args.suspensionIntervalMs,
      deadlineExtendedForClarification: true,
      phase: "running",
      suspendedClarification: null,
    };
    this.appendRecord(
      "clarification_answered",
      {
        intervalMs: args.suspensionIntervalMs,
        deadlineMs: this.state.deadlineMs,
        extendedOnce: true,
      },
      args.nowMs,
    );
  }

  markDescendantsUnknown(args: { generation: number; callId: string; toolName: string; nowMs: number }): void {
    this.assertWritableGeneration(args.generation);
    this.quarantineUnsettled(args.callId, args.toolName, "descendant_unknown");
    this.appendRecord(
      "transition",
      {
        name: "descendant_unknown",
        beforeDigest: digestOf({ callId: args.callId }),
        afterDigest: digestOf({ callId: args.callId, status: "unknown" }),
        externalEffects: "disabled" as const,
      },
      args.nowMs,
    );
  }

  checkpoint(nowMs: number): string {
    const body: CheckpointBody = {
      v: JOURNAL_FORMAT_VERSION,
      runId: this.manifest.runId,
      principalId: this.manifest.principalId,
      generation: this.generation,
      journalPrefixSeq: this.records.length,
      journalPrefixDigest: this.tip,
      state: this.state,
      manifestDigest: digestOf(this.manifest),
    };
    const raw = Buffer.from(canonicalize(body), "utf8");
    if (raw.byteLength > MAX_CHECKPOINT_BYTES) {
      throw new DurableRunsError("oversized", "checkpoint exceeds limit", ["checkpoint"]);
    }
    const path = join(this.runDir, "checkpoint.json");
    atomicWrite(this.runDir, path, raw);
    this.appendRecord("checkpoint_ref", { journalPrefixSeq: body.journalPrefixSeq, journalPrefixDigest: this.tip }, nowMs);
    return digestBytes(raw);
  }

  renderNotice(): DurableRunNotice {
    const unresolved = this.state.quarantine.map((q) => ({
      callId: q.callId,
      toolName: q.toolName,
      status: "unknown" as const,
    }));
    const unavailableResources = this.state.quarantine.flatMap((q) => [...q.resourceIds]);
    const usageGaps = this.state.admissions.usageUnknown ? ["usage_unknown"] : [];
    const argumentPreviews = this.state.observations.slice(0, 8).map((obs) => ({
      callId: obs.callId,
      preview: previewUntrusted(obs.toolName), previewUntrusted,
      untrusted: true as const,
    }));
    // fix previews properly below — rewritten in method body after helper
    const text = [
      "runtime-authored resume notice",
      `unresolved=${unresolved.length}`,
      `unavailable_resources=${unavailableResources.length}`,
      `usage_gaps=${usageGaps.join(",") || "none"}`,
      "Resume is not authoritative reconciliation of interrupted effects.",
      "Argument previews are untrusted data.",
    ].join(" ");
    return {
      unresolved,
      unavailableResources,
      usageGaps,
      argumentPreviews: this.state.quarantine.slice(0, 8).map((q) => ({
        callId: q.callId,
        preview: previewUntrusted(q.toolName + ":" + q.reason),
        untrusted: true as const,
      })),
      text,
    };
  }

  close(): void {
    this.closed = true;
  }

  private findIntent(callId: string): boolean {
    return this.records.some((r) => r.kind === "dispatch_intent" && this.payloadMentions(r, callId));
  }

  private findSettlement(callId: string): boolean {
    return this.records.some((r) => r.kind === "settlement" && this.payloadMentions(r, callId));
  }

  private payloadMentions(record: JournalRecord, callId: string): boolean {
    const blob = readBlobFile(this.runDir, record.payloadDigest);
    if (!blob) return false;
    try {
      const parsed = JSON.parse(blob.toString("utf8")) as { callId?: string };
      return parsed.callId === callId;
    } catch {
      return false;
    }
  }

  private quarantineUnsettled(
    callId: string,
    toolName: string,
    reason: QuarantineEntry["reason"],
  ): void {
    if (this.state.quarantine.some((q) => q.callId === callId && q.reason === reason)) return;
    this.state = {
      ...this.state,
      phase: "quarantined",
      quarantine: [
        ...this.state.quarantine,
        { callId, toolName, reason, resourceIds: [toolName] },
      ],
    };
  }

  private writeBlob(expectedDigest: string, value: unknown): string {
    const raw = Buffer.from(canonicalize(value), "utf8");
    if (raw.byteLength > MAX_BLOB_BYTES) {
      throw new DurableRunsError("oversized", "blob exceeds limit", ["blob"]);
    }
    const digest = digestBytes(raw);
    if (digest !== expectedDigest) {
      throw new DurableRunsError("digest_mismatch", "blob digest mismatch", ["blob"]);
    }
    const path = join(this.runDir, "blobs", digest);
    if (!existsSync(path)) {
      atomicWrite(this.runDir, path, raw);
    }
    return digest;
  }

  private appendRecord(kind: JournalRecordKind, payload: unknown, atMs: number): void {
    if (this.records.length >= MAX_JOURNAL_RECORDS) {
      throw new DurableRunsError("store_full", "journal record cap", ["journal"]);
    }
    const payloadDigest = this.writeBlob(digestOf(payload), payload);
    const record: JournalRecord = {
      v: JOURNAL_FORMAT_VERSION,
      seq: this.records.length + 1,
      kind,
      runId: this.manifest.runId,
      principalId: this.manifest.principalId,
      generation: this.generation,
      prev: this.tip,
      payloadDigest,
      atMs,
    };
    const line = Buffer.from(canonicalize(record) + "\n", "utf8");
    if (line.byteLength > MAX_RECORD_BYTES) {
      throw new DurableRunsError("oversized", "record exceeds limit", ["journal"]);
    }
    const journalPath = join(this.runDir, "journal.jsonl");
    const fd = openSync(journalPath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o600);
    try {
      const { writeSync } = require("node:fs") as typeof import("node:fs");
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (this.directoryFsync.supported) {
      fsyncDirectory(this.runDir);
    }
    this.tip = digestBytes(canonicalize(record));
    this.records.push(record);
  }

  private bytesUsed(): number {
    return directoryBytes(this.runDir);
  }
}

function previewUntrusted(text: string): string {
  const chars = Array.from(text);
  const sliced = chars.slice(0, ARGUMENT_PREVIEW_CODE_POINTS).join("");
  return sliced;
}

function exclusiveCreateLock(path: string, body: OwnershipLockFile): void {
  const raw = Buffer.from(canonicalize(body), "utf8");
  let fd: number;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new DurableRunsError("lock_held", "ownership already held; leftover lock blocks a second owner", [
        "owner.lock",
      ]);
    }
    throw err;
  }
  try {
    const { writeSync } = require("node:fs") as typeof import("node:fs");
    writeSync(fd, raw);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function atomicWrite(dir: string, finalPath: string, raw: Buffer): void {
  const tmp = join(dir, "tmp", "pub-" + randomBytes(8).toString("hex"));
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    const { writeSync } = require("node:fs") as typeof import("node:fs");
    writeSync(fd, raw);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, finalPath);
  fsyncDirectory(dir);
}

function fsyncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Caller must have reported unsupported directory fsync before enabling production mount.
  }
}

function readLock(path: string): OwnershipLockFile | null {
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink()) {
    throw new DurableRunsError("unsafe_path", "lock path is a symlink", ["owner.lock"]);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as OwnershipLockFile;
  if (parsed.method !== "exclusive-create") {
    throw new DurableRunsError("unsafe_ownership", "unexpected lock method", ["owner.lock"]);
  }
  return parsed;
}

interface LoadedJournal {
  records: JournalRecord[];
  tip: string;
  manifest: DurableRunManifest;
  blobs: Map<string, Buffer>;
}

function loadJournal(runDir: string, principalId: string, runId: string): LoadedJournal {
  const journalPath = join(runDir, "journal.jsonl");
  if (lstatSync(journalPath).isSymbolicLink()) {
    throw new DurableRunsError("unsafe_path", "journal is a symlink", ["journal"]);
  }
  const raw = readFileSync(journalPath);
  const text = raw.toString("utf8");
  if (text.length > 0 && !text.endsWith("\n")) {
    throw new DurableRunsError("torn_tail", "torn journal tail; no silent truncation", ["journal"]);
  }
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length > MAX_JOURNAL_RECORDS) {
    throw new DurableRunsError("oversized", "too many journal records", ["journal"]);
  }
  const blobs = new Map<string, Buffer>();
  const blobDir = join(runDir, "blobs");
  if (existsSync(blobDir)) {
    for (const name of readdirSync(blobDir)) {
      if (!/^[a-f0-9]{64}$/.test(name)) {
        throw new DurableRunsError("unsafe_path", "unexpected blob name", ["blobs"]);
      }
      const p = join(blobDir, name);
      if (lstatSync(p).isSymbolicLink()) {
        throw new DurableRunsError("unsafe_path", "blob symlink", ["blobs"]);
      }
      const buf = readFileSync(p);
      if (digestBytes(buf) !== name) {
        throw new DurableRunsError("corrupt_blob", "blob digest mismatch", ["blobs"]);
      }
      blobs.set(name, buf);
    }
  }
  const records: JournalRecord[] = [];
  let prev = "0".repeat(64);
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
      throw new DurableRunsError("oversized", "record exceeds limit", ["journal"]);
    }
    let parsed: JournalRecord;
    try {
      parsed = JSON.parse(line) as JournalRecord;
    } catch {
      throw new DurableRunsError("torn_tail", "noncanonical journal line", ["journal"]);
    }
    const again = canonicalize(parsed);
    if (again !== line) {
      throw new DurableRunsError("noncanonical", "journal record is not RFC 8785", ["journal"]);
    }
    if (parsed.v !== JOURNAL_FORMAT_VERSION || parsed.runId !== runId || parsed.principalId !== principalId) {
      throw new DurableRunsError("principal_mismatch", "journal identity mismatch", ["runId", "principalId"]);
    }
    if (parsed.seq !== records.length + 1 || parsed.prev !== prev) {
      throw new DurableRunsError("chain_break", "journal chain break", ["prev", "seq"]);
    }
    if (!blobs.has(parsed.payloadDigest)) {
      throw new DurableRunsError("evidence_unavailable", "missing payload blob", ["payloadDigest"]);
    }
    prev = digestBytes(line);
    records.push(parsed);
  }
  const genesis = records[0];
  if (!genesis || genesis.kind !== "genesis") {
    throw new DurableRunsError("chain_break", "missing genesis", ["journal"]);
  }
  const genesisPayload = JSON.parse(blobs.get(genesis.payloadDigest)!.toString("utf8")) as {
    manifestDigest: string;
  };
  const manifestBlob = blobs.get(genesisPayload.manifestDigest);
  if (!manifestBlob) {
    throw new DurableRunsError("evidence_unavailable", "missing manifest blob", ["manifest"]);
  }
  if (digestBytes(manifestBlob) !== genesisPayload.manifestDigest) {
    throw new DurableRunsError("corrupt_blob", "manifest blob corrupt", ["manifest"]);
  }
  const manifest = JSON.parse(manifestBlob.toString("utf8")) as DurableRunManifest;
  if (manifest.runId !== runId || manifest.principalId !== principalId) {
    throw new DurableRunsError("principal_mismatch", "manifest identity mismatch", ["runId", "principalId"]);
  }
  validateSettlements(records, blobs);
  return { records, tip: prev, manifest, blobs };
}

function validateSettlements(records: JournalRecord[], blobs: Map<string, Buffer>): void {
  for (const record of records) {
    if (record.kind !== "settlement" && record.kind !== "inference_settlement") continue;
    const payloadRaw = blobs.get(record.payloadDigest);
    if (!payloadRaw) {
      throw new DurableRunsError("evidence_unavailable", "settlement payload missing", ["payloadDigest"]);
    }
    const payload = JSON.parse(payloadRaw.toString("utf8")) as {
      resultDigest?: string;
      responseDigest?: string | null;
      transitionDigest?: string;
    };
    const needed = [payload.resultDigest, payload.transitionDigest, payload.responseDigest].filter(
      (d): d is string => typeof d === "string",
    );
    for (const digest of needed) {
      const blob = blobs.get(digest);
      if (!blob || digestBytes(blob) !== digest) {
        throw new DurableRunsError(
          "evidence_unavailable",
          "settlement referenced blob missing or corrupt; refusing executable resume",
          ["blob"],
        );
      }
    }
  }
}

function assertManifestCompatible(stored: DurableRunManifest, incoming: DurableRunManifest): void {
  const fields: string[] = [];
  if (stored.taskDigest !== incoming.taskDigest) fields.push("taskDigest");
  if (stored.contractDigest !== incoming.contractDigest) fields.push("contractDigest");
  if (stored.verifierIdentity !== incoming.verifierIdentity) fields.push("verifierIdentity");
  if (stored.toolSchemaDigest !== incoming.toolSchemaDigest) fields.push("toolSchemaDigest");
  if (canonicalize(stored.toolNames) !== canonicalize(incoming.toolNames)) fields.push("toolNames");
  if (canonicalize(stored.budgetCaps) !== canonicalize(incoming.budgetCaps)) fields.push("budgetCaps");
  if (stored.mountConfigDigest !== incoming.mountConfigDigest) fields.push("mountConfigDigest");
  if (canonicalize(stored.implementationIdentities) !== canonicalize(incoming.implementationIdentities)) {
    fields.push("implementationIdentities");
  }
  if (canonicalize(stored.resourceIdentities) !== canonicalize(incoming.resourceIdentities)) {
    fields.push("resourceIdentities");
  }
  if (fields.length > 0) {
    throw new DurableRunsError(
      "config_changed",
      `resume rejected changed configuration fields: ${fields.join(",")}`,
      fields,
    );
  }
}

function replayPrefix(
  records: JournalRecord[],
  blobs: Map<string, Buffer>,
  manifest: DurableRunManifest,
): { state: RestorableRuntimeState } {
  let state = emptyState(manifest.budgetCaps.absoluteDeadlineMs);
  const settled = new Set<string>();
  const inferenceSettled = new Set<string>();
  const intents: { callId: string; toolName: string }[] = [];
  const inferenceIntents: string[] = [];

  for (const record of records) {
    const payload = JSON.parse(blobs.get(record.payloadDigest)!.toString("utf8")) as Record<string, unknown>;
    if (record.kind === "checkpoint_ref") {
      // Checkpoint is a prefix hint. Later records still replay once. Equality with tip is not required.
      continue;
    }
    if (record.kind === "dispatch_intent") {
      const callId = String(payload.callId);
      intents.push({ callId, toolName: String(payload.toolName) });
      state = {
        ...state,
        reservedCallIds: state.reservedCallIds.includes(callId)
          ? state.reservedCallIds
          : [...state.reservedCallIds, callId],
        admissions: {
          ...state.admissions,
          steps: Math.max(state.admissions.steps, Number(payload.stepAdmission) || state.admissions.steps),
        },
        nextCallSeq: state.nextCallSeq + 1,
      };
    } else if (record.kind === "settlement") {
      const callId = String(payload.callId);
      settled.add(callId);
      const resultDigest = String(payload.resultDigest);
      state = {
        ...state,
        observations: [
          ...state.observations,
          {
            callId,
            toolName: String(payload.toolName),
            resultDigest,
            exposureDigest: null,
          },
        ],
      };
    } else if (record.kind === "inference_intent") {
      inferenceIntents.push(String(payload.inferenceId));
      state = {
        ...state,
        admissions: {
          ...state.admissions,
          turns: Math.max(state.admissions.turns, Number(payload.turnAdmission) || state.admissions.turns),
        },
      };
    } else if (record.kind === "inference_settlement") {
      inferenceSettled.add(String(payload.inferenceId));
      const usage = payload.usage;
      state = {
        ...state,
        admissions: {
          ...state.admissions,
          usage:
            usage === "usage_unknown"
              ? state.admissions.usage
              : state.admissions.usage + (typeof usage === "number" ? usage : 0),
          usageUnknown: state.admissions.usageUnknown || usage === "usage_unknown",
        },
      };
    } else if (record.kind === "clarification_suspended") {
      state = {
        ...state,
        phase: "paused",
        suspendedClarification: {
          callId: String(payload.callId),
          questionDigest: String(payload.questionDigest),
          suspendedAtMs: Number(payload.suspendedAtMs),
          intervalMs: Number(payload.intervalMs),
        },
        admissions: {
          ...state.admissions,
          clarifications: state.admissions.clarifications + 1,
        },
      };
    } else if (record.kind === "clarification_answered") {
      state = {
        ...state,
        phase: "running",
        deadlineMs: Number(payload.deadlineMs) || state.deadlineMs,
        deadlineExtendedForClarification: true,
        suspendedClarification: null,
      };
    } else if (record.kind === "terminal") {
      state = {
        ...state,
        phase: "completed",
        terminal: { status: String(payload.status ?? "done"), digest: record.payloadDigest },
      };
    }
  }

  const quarantine = [...state.quarantine];
  for (const intent of intents) {
    if (!settled.has(intent.callId)) {
      quarantine.push({
        callId: intent.callId,
        toolName: intent.toolName,
        reason: "unsettled_dispatch",
        resourceIds: [intent.toolName],
      });
    }
  }
  for (const inferenceId of inferenceIntents) {
    if (!inferenceSettled.has(inferenceId)) {
      quarantine.push({
        callId: inferenceId,
        toolName: "adapter",
        reason: "unsettled_inference",
        resourceIds: ["adapter"],
      });
      if (manifest.budgetCaps.usageCap !== null) {
        state = {
          ...state,
          admissions: { ...state.admissions, usageUnknown: true },
        };
      }
    }
  }
  if (quarantine.length > 0) {
    state = { ...state, phase: "quarantined", quarantine };
  }
  return { state };
}

function readBlobFile(runDir: string, digest: string): Buffer | null {
  const path = join(runDir, "blobs", digest);
  if (!existsSync(path)) return null;
  return readFileSync(path);
}

function directoryBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) total += directoryBytes(p);
    else total += st.size;
  }
  return total;
}

/** Absent/disabled config writes nothing and does not alter call counts. */
export function durableRunsInactive(option: unknown): boolean {
  if (option === undefined || option === null) return true;
  const parsed = parseDurableRunsOption(option);
  return !parsed || !parsed.enabled;
}

export function allocateCallId(state: RestorableRuntimeState, prefix = "call"): { callId: string; state: RestorableRuntimeState } {
  let seq = state.nextCallSeq;
  let callId = `${prefix}_${seq}`;
  const reserved = new Set(state.reservedCallIds);
  while (reserved.has(callId)) {
    seq += 1;
    callId = `${prefix}_${seq}`;
  }
  return {
    callId,
    state: {
      ...state,
      nextCallSeq: seq + 1,
      reservedCallIds: [...state.reservedCallIds, callId],
    },
  };
}

/**
 * Stage A production mount stays unavailable when directory fsync is unsupported
 * or ownership cannot be enforced. Storage utilities may still be constructed
 * by tests that pass requireDirectoryFsync: false.
 */
export function productionMountAvailable(fsync: DirectoryFsyncSupport, ownershipEnforced: boolean): boolean {
  return fsync.supported && ownershipEnforced;
}
