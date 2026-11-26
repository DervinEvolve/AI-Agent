export type CommitmentKind = 'decision' | 'open_question';

export type CommitmentStatus = 'active' | 'superseded' | 'answered' | 'abandoned';

export type CommitmentResolution = 'answered' | 'abandoned';

export interface CommitmentRefInput {
  call_id: string;
  detail?: string;
}

export interface CommitmentRef {
  logical_run_id: string;
  turn_id: string | number;
  call_id: string;
  outcome: string;
  detail?: string;
}

export interface CommitmentEntry {
  id: string;
  kind: CommitmentKind;
  summary: string;
  status: CommitmentStatus;
  refs: CommitmentRef[];
  created_at_seq: number;
  created_turn_id: string | number;
  supersedes_id?: string;
  superseded_by_id?: string;
  resolved_at_seq?: number;
  resolution?: CommitmentResolution;
  resolution_summary?: string;
  resolution_refs?: CommitmentRef[];
}

export type BoardEvent =
  | {
      seq: number;
      type: 'created';
      call_id: string;
      logical_run_id: string;
      turn_id: string | number;
      commitment_id: string;
      timestamp: number;
      kind: CommitmentKind;
      summary: string;
      refs: CommitmentRef[];
      supersedes_id?: string;
    }
  | {
      seq: number;
      type: 'superseded';
      call_id: string;
      logical_run_id: string;
      turn_id: string | number;
      commitment_id: string;
      timestamp: number;
      superseded_by_id: string;
    }
  | {
      seq: number;
      type: 'resolved';
      call_id: string;
      logical_run_id: string;
      turn_id: string | number;
      commitment_id: string;
      timestamp: number;
      resolution: CommitmentResolution;
      summary: string;
      refs: CommitmentRef[];
    };

export interface CommitmentBoardConfig {
  enabled: boolean;
  maxActiveEntries: number;
  maxCreations: number;
  maxTotalEvents: number;
  maxSummaryBytes: number;
  maxRefDetailBytes: number;
  maxRefsPerEntry: number;
  maxRenderedBytes: number;
}

export const COMMITMENT_BOARD_DEFAULTS = {
  enabled: false,
  maxActiveEntries: 16,
  maxCreations: 64,
  maxTotalEvents: 128,
  maxSummaryBytes: 256,
  maxRefDetailBytes: 64,
  maxRefsPerEntry: 4,
  maxRenderedBytes: 4096,
} as const;

export const COMMITMENT_BOARD_HARD_CAPS = {
  maxActiveEntries: 32,
  maxCreations: 128,
  maxTotalEvents: 256,
  maxSummaryBytes: 512,
  maxRefDetailBytes: 128,
  maxRefsPerEntry: 8,
  maxRenderedBytes: 8192,
} as const;

export const DEFAULT_COMMITMENT_BOARD_CONFIG: CommitmentBoardConfig = {
  ...COMMITMENT_BOARD_DEFAULTS,
};

export const COMMITMENT_BOARD_FULL = 'commitment_board_full' as const;
export const COMMITMENT_NOT_FOUND = 'commitment_not_found' as const;
export const COMMITMENT_NOT_ACTIVE = 'commitment_not_active' as const;
export const COMMITMENT_INVALID_TRANSITION = 'commitment_invalid_transition' as const;
export const COMMITMENT_REF_NOT_OBSERVED = 'commitment_ref_not_observed' as const;
export const COMMITMENT_INVALID_INPUT = 'commitment_invalid_input' as const;
export const COMMITMENT_ABORTED = 'commitment_aborted' as const;

export const COMMITMENT_REASON_CODES = {
  BOARD_FULL: COMMITMENT_BOARD_FULL,
  NOT_FOUND: COMMITMENT_NOT_FOUND,
  NOT_ACTIVE: COMMITMENT_NOT_ACTIVE,
  INVALID_TRANSITION: COMMITMENT_INVALID_TRANSITION,
  REF_NOT_OBSERVED: COMMITMENT_REF_NOT_OBSERVED,
  INVALID_INPUT: COMMITMENT_INVALID_INPUT,
  ABORTED: COMMITMENT_ABORTED,
} as const;

export type CommitmentReasonCode =
  (typeof COMMITMENT_REASON_CODES)[keyof typeof COMMITMENT_REASON_CODES];

export interface ObservationRecord {
  logical_run_id: string;
  turn_id: string | number;
  call_id: string;
  tool_name: string;
  started: boolean;
  outcome: string;
}

export interface ObservationLookup {
  getByCallId(callId: string, logicalRunId: string): ObservationRecord | undefined;
}
