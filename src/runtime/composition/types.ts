export const COMPOSITION_CAPS = {
  ENVELOPE_VERSION: 1,
  MIN_DRAIN_DEADLINE_MS: 50,
  MAX_DRAIN_DEADLINE_MS: 30_000,
  MIN_TEARDOWN_RESERVE_MS: 50,
  MAX_TEARDOWN_RESERVE_MS: 30_000,
  MAX_BATCH_MEMBERS: 64,
} as const;

export const COMPOSITION_REASON_CODES = {
  NOT_STARTED_NO_INTENT: 'not_started_no_intent',
  OUTCOME_UNKNOWN_UNSETTLED: 'outcome_unknown_unsettled',
  JOB_FAMILY_BLOCKED: 'job_family_blocked',
  TEARDOWN_UNCONFIRMED: 'teardown_unconfirmed',
  TEARDOWN_RESERVE_EXPIRED: 'teardown_reserve_expired',
  INVALID_DRAIN_DEADLINE: 'invalid_drain_deadline',
  INVALID_TEARDOWN_RESERVE: 'invalid_teardown_reserve',
  DURABLE_REQUIRES_JOURNAL_STORE: 'durable_requires_journal_store',
  INCOMPATIBLE_SUBSYSTEM_COMOUNT: 'incompatible_subsystem_comount',
  CONSUMED_APPROVAL_REUSE_BLOCKED: 'consumed_approval_reuse_blocked',
  UNKNOWN_OUTCOME_BLOCKS_RETIREMENT: 'unknown_outcome_blocks_retirement',
} as const;

export type CompositionReasonCode =
  (typeof COMPOSITION_REASON_CODES)[keyof typeof COMPOSITION_REASON_CODES];

export type ComposedTurnState =
  | 'idle'
  | 'dispatching'
  | 'settling'
  | 'committing'
  | 'reconciling'
  | 'compacting'
  | 'terminal_fenced'
  | 'aborted'
  | 'teardown_unconfirmed';

export interface BatchMemberJournalRecord {
  call_id: string;
  provider_call_id?: string;
  tool_name: string;
  args_digest: string;
  intent_journaled_at?: number;
  settled_at?: number;
  status: 'pending_intent' | 'intent_journaled' | 'settled' | 'unknown' | 'not_started';
  started: boolean;
  outcome?: 'success' | 'failure' | 'unknown' | 'not_started';
  result_digest?: string;
  reason_code?: CompositionReasonCode;
}

export interface RecoverySlotState {
  intent_id: string;
  origin_call_id: string;
  remaining: number;
  cumulative_expenditure: number;
  unknown_outcomes: string[];
  retired?: boolean;
}

export interface UsageAdmissionRecord {
  call_id: string;
  usage_unknown: boolean;
  tokens?: number;
}

export interface WorkspaceQuarantineState {
  quarantined: boolean;
  reason?: string;
}

export interface ComposedJobRecord {
  job_id: string;
  run_id: string;
  status: 'running' | 'completed' | 'failed' | 'lost' | 'removed';
  cleanup_confirmed?: boolean;
}

export interface CheckpointEnvelope {
  version: number;
  run_id: string;
  principal: string;
  turn_index: number;
  active_turn_state: ComposedTurnState;
  batch_members: BatchMemberJournalRecord[];
  recovery_slot: RecoverySlotState | null;
  usage_admissions: UsageAdmissionRecord[];
  workspace_quarantine: WorkspaceQuarantineState;
  consumed_approval_digests: string[];
  observation_call_ids: string[];
  job_records: ComposedJobRecord[];
  teardown_unconfirmed: boolean;
}

export interface CompositionParticipant {
  id: string;
  onBatchSettled?: (envelope: CheckpointEnvelope) => Promise<void> | void;
  onTurnBoundary?: (envelope: CheckpointEnvelope) => Promise<void> | void;
  onAbort?: (envelope: CheckpointEnvelope) => Promise<void> | void;
}

export interface ComposedJobPort {
  listContainersByRunId(runId: string): Promise<Array<{ job_id: string; run_id: string; state: string }>>;
  removeContainersByRunId(runId: string): Promise<boolean>;
}

export interface JournalEntry {
  seq: number;
  run_id: string;
  timestamp: number;
  type:
    | 'dispatch_intent'
    | 'batch_settled'
    | 'recovery_slot_updated'
    | 'approval_consumed'
    | 'job_recorded'
    | 'job_cleanup_confirmed'
    | 'turn_state_changed'
    | 'teardown_unconfirmed';
  payload: Record<string, unknown>;
}

export interface JournalStore {
  append(entry: Omit<JournalEntry, 'seq'>): Promise<JournalEntry> | JournalEntry;
  readAll(runId: string): Promise<JournalEntry[]> | JournalEntry[];
  persistView?(envelope: CheckpointEnvelope): Promise<void> | void;
  readView?(runId: string): Promise<CheckpointEnvelope | null> | CheckpointEnvelope | null;
}

export interface CompositionConfig {
  enabled?: boolean;
  durable?: boolean;
  journalStore?: JournalStore;
  sessionMode?: boolean;
  parallelDispatch?: boolean;
  backgroundJobs?: boolean;
  eventStreamAbort?: boolean;
  drainDeadlineMs?: number;
  teardownReserveMs?: number;
  // Incompatible subsystems that remain startup-rejected with durable or session mode
  modelRouter?: boolean;
  workspaceTrials?: boolean;
  pixelBrowserControl?: boolean;
  sandboxEgress?: boolean;
  toolPrograms?: boolean;
  toolDiscovery?: boolean;
}

export interface ResumeNotice {
  run_id: string;
  turn_index: number;
  active_turn_state: ComposedTurnState;
  reason_codes: CompositionReasonCode[];
  unknown_call_ids: string[];
  job_family_blocked: boolean;
}
