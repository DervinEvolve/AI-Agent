export const SYNTHESIS_ASSERTION_EXIT_CODE = 86 as const;

export const TEST_SYNTHESIS_CAPS = {
  maxSynthesisRounds: { default: 1, hard: 2 },
  maxChecksPerRound: { default: 4, hard: 8 },
  maxCheckBytes: { default: 8192, hard: 32768 },
  maxCheckOutputBytes: { default: 4096, hard: 16384 },
  maxFeedbackBytes: { default: 1024, hard: 4096 },
  maxRecordBytes: { default: 4096, hard: 16384 },
  checkTimeoutMs: { default: 5000, hard: 30000 },
  attemptShare: { default: 0.25, minExclusive: 0, maxInclusive: 0.5 },
  maxHypothesisBytes: 240,
  maxRationaleBytes: 240,
} as const;

export const SYNTHESIS_REASON_CODES = {
  REJECTED: 'synthesis_rejected',
  USAGE_UNKNOWN: 'synthesis_usage_unknown',
  CHECK_UNKNOWN: 'synthesis_check_unknown',
  BLOCKED: 'synthesis_blocked',
  NO_CANDIDATE: 'synthesis_no_candidate',
  CHECKS_FAILED: 'synthesis_checks_failed',
  CHECKS_FAILED_WARN: 'synthesis_checks_failed_warn',
  PASSED: 'synthesis_passed',
  INCONCLUSIVE: 'synthesis_inconclusive',
  SKIPPED: 'synthesis_skipped',
} as const;

export type SynthesisReasonCode =
  (typeof SYNTHESIS_REASON_CODES)[keyof typeof SYNTHESIS_REASON_CODES];

export type UnreconciledPolicy = 'incomplete' | 'warn';

export interface TestSynthesisConfig {
  enabled: boolean;
  maxSynthesisRounds: number;
  maxChecksPerRound: number;
  maxCheckBytes: number;
  maxCheckOutputBytes: number;
  maxFeedbackBytes: number;
  maxRecordBytes: number;
  checkTimeoutMs: number;
  attemptShare: number;
  unreconciledPolicy: UnreconciledPolicy;
  assertionExitCode: number;
}

export type SynthesisCheckKind = 'property' | 'differential';

export interface SynthesisCheckSpec {
  id: string;
  kind: SynthesisCheckKind;
  hypothesis: string;
  code: string;
}

export interface SynthesisModelOutput {
  checks: SynthesisCheckSpec[];
  rationale?: string;
}

export type SynthesisCheckOutcome =
  | 'pass'
  | 'check_failed'
  | 'check_error'
  | 'blocked'
  | 'unknown';

export interface SynthesisCheckResult {
  id: string;
  kind: SynthesisCheckKind;
  call_id: string;
  origin: 'synthesis';
  outcome: SynthesisCheckOutcome;
  exitCode?: number;
  output: string;
  truncated: boolean;
  durationMs: number;
  citable: false;
}

export interface SynthesisFeedbackItem {
  id: string;
  hypothesis: string;
  output: string;
  truncated: boolean;
}

export interface SynthesisFeedback {
  round: number;
  label: 'UNTRUSTED_SYNTHESIS_FEEDBACK';
  items: SynthesisFeedbackItem[];
  rendered: string;
  byteLength: number;
}

export interface SynthesisUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
}

export interface TestSynthesisRecord {
  run_id: string;
  round: number;
  candidate_digest: string;
  checks_run: number;
  passed: number;
  failed: number;
  errored: number;
  outcome: SynthesisReasonCode;
  usage?: SynthesisUsage;
  instruction_digest: string;
}

export interface SynthesisStartupContext {
  hasRunCodeTool: boolean;
  hasFiniteBudgets: boolean;
  coMountedFeatures: Partial<Record<IncompatibleCoMountFeature, boolean>>;
}

export type IncompatibleCoMountFeature =
  | 'durableRuns'
  | 'sessions'
  | 'composition'
  | 'parallelDispatch'
  | 'asyncWorkers'
  | 'modelRouter'
  | 'adaptiveEffort'
  | 'semanticCompaction'
  | 'deliberation'
  | 'triggers'
  | 'verifierRepair'
  | 'workspaceTrials'
  | 'editAlternatives'
  | 'backgroundJobs'
  | 'sandboxEgress';
