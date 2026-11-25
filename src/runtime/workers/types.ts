/**
 * Host-frozen contracts for run-scoped async depth-1 workers.
 * Caps are inclusive. Implementation and tests must import these exports.
 */

export const WORKER_STATES = [
  "running",
  "paused",
  "completed",
  "failed",
  "step_limit",
  "deadline",
  "cancelled",
] as const;

export type WorkerState = (typeof WORKER_STATES)[number];

export const WORKER_REASON = {
  WORKER_BUDGET_EXCEEDED: "worker_budget_exceeded",
  DELEGATION_IN_FLIGHT: "delegation_in_flight",
  WORKER_FAMILY_BLOCKED: "worker_family_blocked",
  PARENT_SLOT_OPEN: "parent_slot_open",
  RUN_WIDE_UNKNOWN: "run_wide_unknown",
  SPAWN_UNRESOLVED: "spawn_unresolved",
  CAP_REFUSAL: "cap_refusal",
  POLICY_REFUSAL: "policy_refusal",
  NOT_STARTED: "not_started",
  UNKNOWN: "unknown",
  STARTED: "started",
  STOPPED: "stopped",
  TEARDOWN_UNCONFIRMED: "teardown_unconfirmed",
  CLEANUP_CONFIRMED: "cleanup_confirmed",
  INCOMPATIBLE_COMOUNT: "incompatible_comount",
  STARTUP_REJECTED: "startup_rejected",
  ALREADY_STOPPED: "already_stopped",
  USAGE_UNKNOWN: "usage_unknown",
  ASK_TIER: "ask_tier",
  DENY_TIER: "deny_tier",
  TOOL_INELIGIBLE: "tool_ineligible",
} as const;

export type WorkerReasonCode = (typeof WORKER_REASON)[keyof typeof WORKER_REASON];

export const TASK_MIN_BYTES = 1;
export const TASK_MAX_BYTES = 4096;
export const WAIT_MS_MIN = 0;
export const WAIT_MS_MAX = 10_000;
export const WAIT_MS_DEFAULT = 0;

export const POLL_OUTPUT_MAX_BYTES = 8192;

export const REPORT_PAGE_MIN_BYTES = 256;
export const REPORT_PAGE_MAX_BYTES = 8192;
export const REPORT_PAGE_DEFAULT_BYTES = 8192;

/** Every frozen item must be pageable at REPORT_PAGE_MIN_BYTES. */
export const REPORT_ITEM_TEXT_MAX_BYTES = 48;
export const REPORT_CITATION_ID_MAX_BYTES = 24;
export const REPORT_TOOL_NAME_MAX_BYTES = 24;
export const REPORT_MAX_CITATIONS_PER_ITEM = 2;
export const REPORT_SPLIT_MARKER = "[utf8-split]";

export const CONCURRENT_WORKERS_DEFAULT = 2;
export const CONCURRENT_WORKERS_HARD_MAX = 4;
export const SPAWN_ATTEMPTS_DEFAULT = 4;
export const SPAWN_ATTEMPTS_HARD_MAX = 4;
export const WORKER_MAX_STEPS_DEFAULT = 12;
export const WORKER_MAX_STEPS_MIN = 1;
export const WORKER_MAX_STEPS_MAX = 32;
export const PARENT_STEP_RESERVE_DEFAULT = 4;
export const PARENT_STEP_RESERVE_MIN = 2;
export const PARENT_STEP_RESERVE_MAX = 8;
export const MAX_CONCURRENT_INFERENCE_DEFAULT = 1;
export const MAX_CONCURRENT_INFERENCE_HARD_MAX = 2;
export const WORKER_RECOVERY_BUDGET_DEFAULT = 4;
export const WORKER_RECOVERY_BUDGET_MIN = 0;
export const WORKER_RECOVERY_BUDGET_MAX = 8;
export const RECOVERY_SUB_ALLOWANCE_DEFAULT = 1;
export const RECOVERY_SUB_ALLOWANCE_MIN = 0;
export const RECOVERY_SUB_ALLOWANCE_MAX = 2;
export const TEARDOWN_RESERVE_DEFAULT_MS = 10_000;
export const TEARDOWN_RESERVE_HARD_MAX_MS = 30_000;
export const WORKER_QUIET_POLL_LIMIT_DEFAULT = 6;
export const WORKER_QUIET_POLL_LIMIT_MIN = 3;
export const WORKER_QUIET_POLL_LIMIT_MAX = 12;
export const NORMAL_POLL_REPEAT_THRESHOLD = 3;

export const EVIDENCE_SHAPE_WORKER_POLL = 3 as const;

export interface CitationDescriptor {
  child_call_id: string;
  tool_name: string;
}

export interface ReportItem {
  index: number;
  text: string;
  citations: CitationDescriptor[];
  split_marker?: string;
}

export interface ReportPage {
  offset: number;
  limit: number;
  items: ReportItem[];
  next_offset: number;
  has_more: boolean;
  citation_elided_count: number;
  byte_length: number;
}

export interface WorkerLimits {
  max_steps: number;
  recovery_sub_allowance: number;
  reserved_steps: number;
}

export interface SpawnReconciliationRecord {
  attempt_id: string;
  worker_id: string | null;
  reconciliation_status: "pending" | "started" | "not_started" | "stopped" | "unknown";
  fenced: boolean;
  replayed: false;
}

export interface WorkerRecord {
  worker_id: string;
  attempt_id: string;
  task: string;
  state: WorkerState;
  child_step_index: number;
  reconciliation_status: SpawnReconciliationRecord["reconciliation_status"];
  generation: number;
  cleanup_confirmed: boolean;
  outcome_unknown: boolean;
  usage_unknown: boolean;
  terminal: boolean;
  started_at: number;
  limits: WorkerLimits;
  allowed_tools: string[];
  unresolved_operations: string[];
  report_frozen: boolean;
}

export interface WorkerConfig {
  enabled: boolean;
  principalId: string;
  allowlist: string[];
  maxConcurrentWorkers?: number;
  maxSpawnAttempts?: number;
  defaultMaxSteps?: number;
  parentStepReserve?: number;
  maxConcurrentInference?: number;
  workerRecoveryBudget?: number;
  recoverySubAllowance?: number;
  teardownReserveMs?: number;
  workerQuietPollLimit?: number;
  sharedStepPool?: number;
  durableRun?: boolean;
  interactiveSession?: boolean;
  workspaceTrials?: boolean;
  guiControl?: boolean;
  toolDiscovery?: boolean;
  jobsMounted?: boolean;
  jobsReserveCompatible?: boolean;
  compositionMounted?: boolean;
  delegationActive?: boolean;
}

export interface FrozenWorkerConfig {
  enabled: boolean;
  principalId: string;
  allowlist: readonly string[];
  maxConcurrentWorkers: number;
  maxSpawnAttempts: number;
  defaultMaxSteps: number;
  parentStepReserve: number;
  maxConcurrentInference: number;
  workerRecoveryBudget: number;
  recoverySubAllowance: number;
  teardownReserveMs: number;
  workerQuietPollLimit: number;
  sharedStepPool: number;
  durableRun: boolean;
  interactiveSession: boolean;
  workspaceTrials: boolean;
  guiControl: boolean;
  toolDiscovery: boolean;
  jobsMounted: boolean;
  jobsReserveCompatible: boolean;
}

export interface SharedReserveBucket {
  claimed: boolean;
  reserveMs: number;
  owner: string | null;
  subtractedFromDeadline: boolean;
}

export interface ClockPort {
  now(): number;
  wait(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface InferencePermitPort {
  acquire(signal?: AbortSignal): Promise<InferencePermitLease>;
  release(lease: InferencePermitLease): void;
  inFlight(): number;
  peak(): number;
  queued(): number;
}

export interface InferencePermitLease {
  id: number;
  released: boolean;
}

export interface UsageAdmission {
  admit(): { ok: true } | { ok: false; usageUnknown: boolean };
  settle(authoritative: boolean): void;
  unknownOutstanding(): number;
}

export interface EligibleTool {
  name: string;
  readOnly: boolean;
  idempotent: boolean;
  concurrentSafe: boolean;
  tier?: "ask" | "deny" | "allow";
  kind: "workspace_read" | "workspace_list" | "code_index" | "observation_recall" | "other";
  execute(args: unknown, ctx: { signal: AbortSignal; workerId: string }): Promise<{
    ok: boolean;
    output?: unknown;
    outcome?: "ok" | "error" | "unknown";
    cleanupConfirmed?: boolean;
    callId?: string;
  }>;
}

export interface ToolRegistryPort {
  get(name: string): EligibleTool | undefined;
  list(): EligibleTool[];
}

export interface InferenceRequest {
  workerId: string;
  generation: number;
  prompt: string;
  role: "parent" | "worker" | "delegation" | "review" | "router_fallback";
}

export interface InferenceResponse {
  text: string;
  toolName?: string;
  toolArgs?: unknown;
  final?: boolean;
  providerError?: string;
  status?: number;
  usageKnown?: boolean;
}

export interface InferenceAdapter {
  complete(req: InferenceRequest, signal: AbortSignal): Promise<InferenceResponse>;
}

/** Internal start/cancel/snapshot seam. Production invokes the real child factory. */
export interface WorkerPort {
  start(workerId: string): void;
  cancel(workerId: string): void;
  snapshot(workerId: string): WorkerRecord | undefined;
}

export interface ChildStartContext {
  workerId: string;
  attemptId: string;
  generation: number;
  task: string;
  maxSteps: number;
  signal: AbortSignal;
}

export interface ChildLoopFactory {
  (ctx: ChildStartContext): { started: true } | { started: false; reason: string };
}

export interface ParentLedgerView {
  openSlot: boolean;
  unresolvedUnknown: boolean;
  recoveryDebits: number;
  cumulativeExpenditure: number;
}

export interface WorkerToolSchema {
  name: "spawn_agent" | "poll_agent" | "stop_agent";
  idempotent: boolean;
  concurrentSafe: false;
  description: string;
}
