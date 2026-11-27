// Types and caps for verifier-guided task repair (cap_verifier_repair_78).

export const HARD_MAX_REPAIR_ROUNDS = 2;
export const DEFAULT_MAX_REPAIR_ROUNDS = 1;
export const DEFAULT_VERIFIER_RESERVE_SHARE = 0.2;
export const MIN_VERIFIER_RESERVE_SHARE = 0.1;
export const DEFAULT_MAX_FEEDBACK_BYTES = 1024;
export const HARD_MAX_FEEDBACK_BYTES = 4096;
export const DEFAULT_MAX_RECORD_BYTES = 4096;

export type VerifierKind = 'deterministic' | 'model_backed';

export interface Budget {
  steps: number;
  attempts: number;
  tokens: number;
  cost: number;
}

export interface PerCheck extends Budget {
  timeoutMs: number;
}

export interface CriterionSpec {
  exposed: boolean;
  diagnostic_template: string;
}

export interface RepairConfig {
  enabled: boolean;
  maxRepairRounds: number;
  verifierKind: VerifierKind;
  perCheck: PerCheck;
  verifierReserveShare: number;
  maxFeedbackBytes: number;
  maxRecordBytes: number;
  criteria: Record<string, CriterionSpec>;
}

export type VerdictKind =
  | 'pass'
  | 'fail'
  | 'unverifiable'
  | 'infrastructure_error'
  | 'abort';

export interface VerdictBinding {
  candidateDigest: string;
  workspaceGeneration: number;
  contractDigest: string;
}

export type RepairReason =
  | 'repair_no_candidate'
  | 'repair_rounds_exhausted'
  | 'repair_reserve_unavailable'
  | 'repair_not_eligible'
  | 'repair_citation_failure';

export interface RepairFeedback {
  entries: { criterion_id: string; passed: false; diagnostic: string }[];
  unexposedFailedCount: number;
  omittedCount: number;
  roundsUsed: number;
  maxRounds: number;
}

export interface RepairRecord {
  run_id: string;
  round: number;
  binding: VerdictBinding;
  verdict: VerdictKind | 'none';
  failedExposedIds: string[];
  unexposedFailedCount: number;
  usage: Budget | null;
  outcome: string;
  stale: boolean;
}
