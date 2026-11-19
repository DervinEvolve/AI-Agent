/**
 * Fail-closed admission reporting for cap_eval_harness_27.
 * This module does not run or grade trials. A blocked report is not a score.
 * No credentials, endpoint strings, transcripts or arbitrary diagnostics enter
 * the report. Integrating the actual runtime runner remains required.
 */
export const BASELINE_TASK_IDS = Object.freeze([
  'arithmetic_evidence',
  'dependent_lookup',
  'known_failure_repair',
  'truncated_observation_recall',
  'untrusted_instruction',
  'bounded_absence',
] as const);

export type BaselineMode = 'scripted' | 'localhost_fixture' | 'live';
export type BlockedReason =
  | 'harness_unavailable'
  | 'adapter_unavailable'
  | 'wire_features_unavailable'
  | 'credentials_unavailable'
  | 'validator_shape_unavailable'
  | 'exposure_tracking_unavailable';

export interface BaselineAdmission {
  mode: BaselineMode;
  /** Explicit host capability checks, not inferred from candidate answers. */
  harnessAvailable: boolean;
  adapterAvailable: boolean;
  wireFeaturesAvailable: boolean;
  directCitationsAvailable: boolean;
  exposureTrackingAvailable: boolean;
  /** Used only for admission; never copied into any result. */
  credential?: string;
}

export interface BlockedTaskRecord {
  task_id: typeof BASELINE_TASK_IDS[number];
  contract_verdict: 'unverifiable';
  runtime_outcome: null;
  status: 'infrastructure_error';
  bounded_reason_codes: BlockedReason[];
  dispatch_attempts: null;
  decode_rejects: null;
  model_calls: null;
  reported_usage_or_null: null;
  usage_complete: false;
  elapsed_ms: null;
}

export interface BlockedBaselineReport {
  schema_version: 'eval-baseline-blocked/1';
  suite_sha256: null;
  code_revision: null;
  configuration_digest: null;
  mode: BaselineMode;
  provider_model_if_live: 'google/gemini-3.8-flash' | null;
  execution: 'blocked';
  score_available: false;
  actual_cost: null;
  diagnostic_truncation: false;
  aggregation: {
    passes: 0;
    denominator: 6;
    attempted: 0;
    categories: {
      passed: 0;
      failed: 0;
      unverifiable: 0;
      infrastructure_error: 6;
      not_run: 0;
    };
  };
  tasks: BlockedTaskRecord[];
  interpretation: string;
}

/** Pure preflight: does not construct an adapter or open a socket. */
export function baselineAdmissionFailures(input: BaselineAdmission): BlockedReason[] {
  if (!['scripted', 'localhost_fixture', 'live'].includes(input.mode)) {
    throw new TypeError('Unsupported baseline mode');
  }
  const reasons: BlockedReason[] = [];
  // Credential admission precedes any possible transport admission.
  if (input.mode === 'live' &&
      (typeof input.credential !== 'string' || input.credential.trim().length === 0)) {
    reasons.push('credentials_unavailable');
  }
  if (input.harnessAvailable !== true) reasons.push('harness_unavailable');
  if (input.adapterAvailable !== true) reasons.push('adapter_unavailable');
  if (input.wireFeaturesAvailable !== true) reasons.push('wire_features_unavailable');
  if (input.directCitationsAvailable !== true) reasons.push('validator_shape_unavailable');
  if (input.exposureTrackingAvailable !== true) reasons.push('exposure_tracking_unavailable');
  return reasons;
}

/**
 * Returns null when preflight alone found no blocker. Null is NOT permission
 * to claim completion: the integrated runner must still enforce all limits,
 * evidence/lifecycle gates and host contracts.
 *
 * Identity digests are deliberately null: a blocked-only implementation has
 * no inspected, frozen executable suite and must not manufacture its identity.
 */
export function createBlockedBaselineReport(input: BaselineAdmission): BlockedBaselineReport | null {
  const reasons = baselineAdmissionFailures(input);
  if (reasons.length === 0) return null;
  return {
    schema_version: 'eval-baseline-blocked/1',
    suite_sha256: null,
    code_revision: null,
    configuration_digest: null,
    mode: input.mode,
    provider_model_if_live: input.mode === 'live' ? 'google/gemini-3.8-flash' : null,
    execution: 'blocked',
    score_available: false,
    actual_cost: null,
    diagnostic_truncation: false,
    aggregation: {
      passes: 0,
      denominator: 6,
      attempted: 0,
      categories: { passed: 0, failed: 0, unverifiable: 0, infrastructure_error: 6, not_run: 0 },
    },
    tasks: BASELINE_TASK_IDS.map(task_id => ({
      task_id,
      contract_verdict: 'unverifiable',
      runtime_outcome: null,
      status: 'infrastructure_error',
      bounded_reason_codes: [...reasons],
      dispatch_attempts: null,
      decode_rejects: null,
      model_calls: null,
      reported_usage_or_null: null,
      usage_complete: false,
      elapsed_ms: null,
    })),
    interpretation: 'Blocked admission, not a model score. This is a single-configuration diagnostic slice; paired comparisons, replicated trials and statistical improvement claims are unavailable. Scripted and localhost fixtures test orchestration, not model competence.',
  };
}

/** Serialize only freshly constructed, bounded host fields, never caller reports. */
export function serializeBlockedBaselineReport(input: BaselineAdmission): string | null {
  const report = createBlockedBaselineReport(input);
  if (report === null) return null;
  const json = JSON.stringify(report);
  // All emitted fields are fixed ASCII constants; UTF-8 byte length equals
  // string length. Check that invariant as well as the report byte cap.
  if (/[^\x00-\x7f]/.test(json) || json.length > 64 * 1024) {
    throw new RangeError('Blocked baseline report exceeds serialization bounds');
  }
  return json;
}
