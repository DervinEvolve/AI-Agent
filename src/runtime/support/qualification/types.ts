import { createHash } from 'node:crypto';

export type SupportLabel = 'supported' | 'contradicted' | 'insufficient';
export type QualificationCategory = SupportLabel | 'compound' | 'instruction-bearing';
export type PredictedKey = SupportLabel | 'error';

export interface SupportPair {
  premise: string;
  claim: string;
}

export interface QualificationPair extends SupportPair {
  id: string;
  category: QualificationCategory;
  gold: SupportLabel;
}

export interface QualificationSuite {
  pairs: QualificationPair[];
}

export interface ClaimSupportConfig {
  endpoint?: string;
  model?: string;
  system_prompt: string;
  api_key?: string;
  max_tokens?: number;
  max_response_chars?: number;
  timeout_ms?: number;
}

export interface ClaimSupportReport {
  pair: SupportPair;
  raw: string;
  error?: 'transport_error';
}

export interface SupportChecker {
  check(pair: SupportPair): Promise<ClaimSupportReport | null>;
}

export interface QualificationThresholds {
  false_accept_rate: number;
  false_reject_rate: number;
  error_rate: number;
}

export interface QualificationConfig {
  endpoint_origin: string;
  model_id: string;
  adapter_id: string;
  system_prompt_digest: string;
  parser_version: string;
  resolver_version: string;
  suite_digest: string;
  thresholds: QualificationThresholds;
  training_set_hashes?: string[];
  system_prompt?: string;
  api_key?: string;
  max_tokens?: number;
  max_response_chars?: number;
  timeout_ms?: number;
}

export type ConfusionCounts = Record<PredictedKey, Record<SupportLabel, number>>;

export const QUALIFICATION_REASON_CODES = {
  SUITE_TOO_SMALL: 'suite_too_small',
  MISSING_CATEGORY: 'missing_category',
  TRAINING_OVERLAP: 'training_overlap',
  DIGEST_MISMATCH: 'digest_mismatch',
  INCOMPLETE_RUN: 'incomplete_run',
  TRIVIAL_BASELINE_FAIL: 'trivial_baseline_fail',
  THRESHOLD_FAIL: 'threshold_fail',
  PASS: 'pass',
  MISSING_RECORD: 'missing_record',
  NOT_PASS: 'not_pass',
  EXPIRED: 'expired',
  SCRIPTED_FIXTURE: 'scripted_fixture',
  ORIGIN_MISMATCH: 'origin_mismatch',
  MODEL_MISMATCH: 'model_mismatch',
  ADAPTER_MISMATCH: 'adapter_mismatch',
  PROMPT_DIGEST_MISMATCH: 'prompt_digest_mismatch',
  PARSER_VERSION_MISMATCH: 'parser_version_mismatch',
  RESOLVER_VERSION_MISMATCH: 'resolver_version_mismatch',
  SUITE_DIGEST_MISMATCH: 'suite_digest_mismatch',
  THRESHOLD_MISMATCH: 'threshold_mismatch',
} as const;

export type QualificationReasonCode =
  (typeof QUALIFICATION_REASON_CODES)[keyof typeof QUALIFICATION_REASON_CODES];

export interface QualificationRecord {
  endpoint_origin: string;
  model_id: string;
  adapter_id: string;
  system_prompt_digest: string;
  parser_version: string;
  resolver_version: string;
  suite_digest: string;
  confusion: ConfusionCounts;
  false_accept_rate: number | null;
  false_reject_rate: number | null;
  error_rate: number | null;
  thresholds: QualificationThresholds;
  pass: boolean;
  status: 'pass' | 'fail' | 'blocked' | 'partial';
  reason_code: QualificationReasonCode;
  overlap_count: number;
  completed_pairs: number;
  total_pairs: number;
  timestamp: string;
  record_digest?: string;
}

export type QualificationRecordBase = Omit<QualificationRecord, 'record_digest'>;

export interface QualificationIdentity {
  endpoint_origin: string;
  model_id: string;
  adapter_id: string;
  system_prompt_digest: string;
  parser_version: string;
  resolver_version: string;
  suite_digest: string;
  thresholds: QualificationThresholds;
}

export interface QualificationVerificationResult {
  ok: boolean;
  reason_code: QualificationReasonCode;
  reason: string;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function normalizePairHash(premise: string, claim: string): string {
  const normalized = `${normalizeText(premise)}\n${normalizeText(claim)}`;
  return createHash('sha256').update(normalized).digest('hex');
}

export function computeSuiteDigest(suite: QualificationSuite): string {
  const payload = suite.pairs.map((pair) => ({
    id: pair.id,
    category: pair.category,
    gold: pair.gold,
    premise: normalizeText(pair.premise),
    claim: normalizeText(pair.claim),
  }));
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function parseSupportLabel(
  raw: unknown,
  maxResponseChars = 64,
): SupportLabel | 'checker_error' {
  if (typeof raw !== 'string') return 'checker_error';
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > maxResponseChars) return 'checker_error';
  if (trimmed === 'supported') return 'supported';
  if (trimmed === 'contradicted') return 'contradicted';
  if (trimmed === 'insufficient') return 'insufficient';
  return 'checker_error';
}

export function createSupportChecker(config: ClaimSupportConfig): SupportChecker {
  const endpoint = (config.endpoint ?? 'http://127.0.0.1:9').replace(/\/$/, '');
  const model = config.model ?? 'checker';
  const systemPrompt = config.system_prompt;
  const maxTokens = config.max_tokens ?? 16;
  const timeoutMs = config.timeout_ms ?? 5000;

  return {
    async check(pair: SupportPair): Promise<ClaimSupportReport> {
      const body = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: JSON.stringify({ premise: pair.premise, claim: pair.claim }),
          },
        ],
        max_tokens: maxTokens,
        temperature: 0,
      };

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (config.api_key) {
        headers.Authorization = `Bearer ${config.api_key}`;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${endpoint}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          return { pair, raw: '', error: 'transport_error' };
        }
        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: unknown } }>;
        };
        const raw = data?.choices?.[0]?.message?.content;
        return {
          pair,
          raw: typeof raw === 'string' ? raw : '',
        };
      } catch {
        return { pair, raw: '', error: 'transport_error' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function emptyConfusion(): ConfusionCounts {
  return {
    supported: { supported: 0, contradicted: 0, insufficient: 0 },
    contradicted: { supported: 0, contradicted: 0, insufficient: 0 },
    insufficient: { supported: 0, contradicted: 0, insufficient: 0 },
    error: { supported: 0, contradicted: 0, insufficient: 0 },
  };
}

function blockedRecord(
  config: QualificationConfig,
  suite: QualificationSuite,
  reason: QualificationReasonCode,
  overlapCount = 0,
): QualificationRecordBase {
  return {
    endpoint_origin: config.endpoint_origin,
    model_id: config.model_id,
    adapter_id: config.adapter_id,
    system_prompt_digest: config.system_prompt_digest,
    parser_version: config.parser_version,
    resolver_version: config.resolver_version,
    suite_digest: config.suite_digest,
    confusion: emptyConfusion(),
    false_accept_rate: null,
    false_reject_rate: null,
    error_rate: null,
    thresholds: { ...config.thresholds },
    pass: false,
    status: 'blocked',
    reason_code: reason,
    overlap_count: overlapCount,
    completed_pairs: 0,
    total_pairs: suite.pairs.length,
    timestamp: new Date().toISOString(),
  };
}

function partialRecord(
  config: QualificationConfig,
  suite: QualificationSuite,
  completedPairs: number,
): QualificationRecordBase {
  return {
    endpoint_origin: config.endpoint_origin,
    model_id: config.model_id,
    adapter_id: config.adapter_id,
    system_prompt_digest: config.system_prompt_digest,
    parser_version: config.parser_version,
    resolver_version: config.resolver_version,
    suite_digest: config.suite_digest,
    confusion: emptyConfusion(),
    false_accept_rate: null,
    false_reject_rate: null,
    error_rate: null,
    thresholds: { ...config.thresholds },
    pass: false,
    status: 'partial',
    reason_code: QUALIFICATION_REASON_CODES.INCOMPLETE_RUN,
    overlap_count: 0,
    completed_pairs: completedPairs,
    total_pairs: suite.pairs.length,
    timestamp: new Date().toISOString(),
  };
}

export async function qualify(
  suite: QualificationSuite,
  config: QualificationConfig,
  client?: SupportChecker,
): Promise<QualificationRecord> {
  const frozenThresholds: QualificationThresholds = { ...config.thresholds };
  Object.freeze(frozenThresholds);

  const effectiveClient =
    client ??
    createSupportChecker({
      endpoint: config.endpoint_origin,
      model: config.model_id,
      system_prompt: config.system_prompt ?? '',
      api_key: config.api_key,
      max_tokens: config.max_tokens,
      max_response_chars: config.max_response_chars,
      timeout_ms: config.timeout_ms,
    });

  const computedSuiteDigest = computeSuiteDigest(suite);
  if (computedSuiteDigest !== config.suite_digest) {
    const base = blockedRecord(
      config,
      suite,
      QUALIFICATION_REASON_CODES.DIGEST_MISMATCH,
      0,
    );
    const digest = computeRecordDigest(base);
    return { ...base, record_digest: digest };
  }

  if (suite.pairs.length < 15) {
    const base = blockedRecord(
      config,
      suite,
      QUALIFICATION_REASON_CODES.SUITE_TOO_SMALL,
      0,
    );
    const digest = computeRecordDigest(base);
    return { ...base, record_digest: digest };
  }

  const categoryCounts: Record<QualificationCategory, number> = {
    supported: 0,
    contradicted: 0,
    insufficient: 0,
    compound: 0,
    'instruction-bearing': 0,
  };
  for (const pair of suite.pairs) {
    categoryCounts[pair.category] += 1;
  }
  const categoryMinimums: Array<[QualificationCategory, number]> = [
    ['supported', 3],
    ['contradicted', 3],
    ['insufficient', 3],
    ['compound', 1],
    ['instruction-bearing', 1],
  ];
  for (const [category, minimum] of categoryMinimums) {
    if (categoryCounts[category] < minimum) {
      const base = blockedRecord(
        config,
        suite,
        QUALIFICATION_REASON_CODES.MISSING_CATEGORY,
        0,
      );
      const digest = computeRecordDigest(base);
      return { ...base, record_digest: digest };
    }
  }

  const trainingHashes = new Set(config.training_set_hashes ?? []);
  let overlapCount = 0;
  for (const pair of suite.pairs) {
    const hash = normalizePairHash(pair.premise, pair.claim);
    if (trainingHashes.has(hash)) overlapCount += 1;
  }
  if (overlapCount > 0) {
    const base = blockedRecord(
      config,
      suite,
      QUALIFICATION_REASON_CODES.TRAINING_OVERLAP,
      overlapCount,
    );
    const digest = computeRecordDigest(base);
    return { ...base, record_digest: digest };
  }

  const reports: Array<ClaimSupportReport | null> = [];
  for (const pair of suite.pairs) {
    const report = await effectiveClient.check(pair);
    reports.push(report);
  }

  const total = suite.pairs.length;
  const completed = reports.filter((report) => report !== null).length;
  if (completed < total) {
    const base = partialRecord(config, suite, completed);
    const digest = computeRecordDigest(base);
    return { ...base, record_digest: digest };
  }

  const confusion = emptyConfusion();
  const predictedLabels = new Set<PredictedKey>();
  const maxResponseChars = config.max_response_chars ?? 64;

  for (let index = 0; index < total; index += 1) {
    const report = reports[index] as ClaimSupportReport;
    const pair = suite.pairs[index];
    let predicted: PredictedKey;
    if (report.error === 'transport_error') {
      predicted = 'error';
    } else {
      const parsed = parseSupportLabel(report.raw, maxResponseChars);
      predicted = parsed === 'checker_error' ? 'error' : parsed;
    }
    predictedLabels.add(predicted);
    confusion[predicted][pair.gold] += 1;
  }

  const supportedTotal = suite.pairs.filter((pair) => pair.gold === 'supported').length;
  const nonSupportedTotal = total - supportedTotal;

  const falseAccept =
    nonSupportedTotal === 0
      ? 0
      : (confusion.supported.contradicted + confusion.supported.insufficient) /
        nonSupportedTotal;
  const falseReject =
    supportedTotal === 0
      ? 0
      : (confusion.contradicted.supported +
          confusion.insufficient.supported +
          confusion.error.supported) /
        supportedTotal;
  const errorCount =
    confusion.error.supported +
    confusion.error.contradicted +
    confusion.error.insufficient;
  const errorRate = total === 0 ? 0 : errorCount / total;

  const trivialBaseline = predictedLabels.size === 1;
  const ratesOk =
    falseAccept <= frozenThresholds.false_accept_rate &&
    falseReject <= frozenThresholds.false_reject_rate &&
    errorRate <= frozenThresholds.error_rate;

  let status: QualificationRecord['status'];
  let reasonCode: QualificationReasonCode;
  let pass: boolean;

  if (trivialBaseline) {
    status = 'fail';
    reasonCode = QUALIFICATION_REASON_CODES.TRIVIAL_BASELINE_FAIL;
    pass = false;
  } else if (!ratesOk) {
    status = 'fail';
    reasonCode = QUALIFICATION_REASON_CODES.THRESHOLD_FAIL;
    pass = false;
  } else {
    status = 'pass';
    reasonCode = QUALIFICATION_REASON_CODES.PASS;
    pass = true;
  }

  const base: QualificationRecordBase = {
    endpoint_origin: config.endpoint_origin,
    model_id: config.model_id,
    adapter_id: config.adapter_id,
    system_prompt_digest: config.system_prompt_digest,
    parser_version: config.parser_version,
    resolver_version: config.resolver_version,
    suite_digest: config.suite_digest,
    confusion,
    false_accept_rate: falseAccept,
    false_reject_rate: falseReject,
    error_rate: errorRate,
    thresholds: frozenThresholds,
    pass,
    status,
    reason_code: reasonCode,
    overlap_count: overlapCount,
    completed_pairs: completed,
    total_pairs: total,
    timestamp: new Date().toISOString(),
  };

  const digest = computeRecordDigest(base);
  return { ...base, record_digest: digest };
}

export function computeRecordDigest(record: QualificationRecordBase | QualificationRecord): string {
  const { record_digest: _recordDigest, ...rest } = record as QualificationRecord;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

export function isLocalhostOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '::1'
    );
  } catch {
    return false;
  }
}

function verificationFailure(
  reasonCode: QualificationReasonCode,
  reason: string,
): QualificationVerificationResult {
  return { ok: false, reason_code: reasonCode, reason };
}

export function verifyQualificationRecord(
  record: QualificationRecord | null | undefined,
  expected: QualificationIdentity,
  options: { now?: number; max_age_ms?: number } = {},
): QualificationVerificationResult {
  if (!record) {
    return verificationFailure(
      QUALIFICATION_REASON_CODES.MISSING_RECORD,
      'no qualification record is present',
    );
  }

  if (isLocalhostOrigin(expected.endpoint_origin)) {
    return verificationFailure(
      QUALIFICATION_REASON_CODES.SCRIPTED_FIXTURE,
      'scripted/localhost fixtures never satisfy production startup',
    );
  }

  if (!record.pass || record.status !== 'pass') {
    return verificationFailure(
      QUALIFICATION_REASON_CODES.NOT_PASS,
      'recorded qualification did not pass',
    );
  }

  if (!record.record_digest) {
    return verificationFailure(
      QUALIFICATION_REASON_CODES.DIGEST_MISMATCH,
      'record has no integrity digest',
    );
  }

  const expectedDigest = computeRecordDigest(record);
  if (expectedDigest !== record.record_digest) {
    return verificationFailure(
      QUALIFICATION_REASON_CODES.DIGEST_MISMATCH,
      'record integrity digest does not match contents',
    );
  }

  if (record.endpoint_origin !== expected.endpoint_origin) {
    return verificationFailure(
      QUALIFICATION_REASON_CODES.ORIGIN_MISMATCH,
      'endpoint origin mismatch',
    );
  }
  if (record.model_id !== expected.model_id) {
    return verificationFailure(
      QUALIFICATION_REASON_CODES.MODEL_MISMATCH,
      'model id mismatch',
    );
  }
  if (record.adapter_id !== expected.adapter_id) {
    return verificationFailure(
      QUALIFICATION_REASON_CODES.ADAPTER_MISMATCH,
      'adapter id mismatch',
    );
  }
  if (record.system_prompt_digest !== expected.system_prompt_digest) {
    return verificationFailure(
      QUALIFICATION_REASON_CODES.PROMPT_DIGEST_MISMATCH,
      'system prompt digest mismatch',
    );
  }
  if (record.parser_version !== expected.parser_version) {
    return verificationFailure(
      QUALIFICATION_REASON_CODES.PARSER_VERSION_MISMATCH,
      'parser version mismatch',
    );
  }
  if (record.resolver_version !== expected.resolver_version) {
    return verificationFailure(
      QUALIFICATION_REASON_CODES.RESOLVER_VERSION_MISMATCH,
      'resolver version mismatch',
    );
  }
  if (record.suite_digest !== expected.suite_digest) {
    return verificationFailure(
      QUALIFICATION_REASON_CODES.SUITE_DIGEST_MISMATCH,
      'suite digest mismatch',
    );
  }
  if (
    record.thresholds.false_accept_rate !== expected.thresholds.false_accept_rate ||
    record.thresholds.false_reject_rate !== expected.thresholds.false_reject_rate ||
    record.thresholds.error_rate !== expected.thresholds.error_rate
  ) {
    return verificationFailure(
      QUALIFICATION_REASON_CODES.THRESHOLD_MISMATCH,
      'frozen thresholds mismatch',
    );
  }

  const now = options.now ?? Date.now();
  const maxAgeMs = options.max_age_ms ?? 7 * 24 * 60 * 60 * 1000;
  const timestamp = Date.parse(record.timestamp);
  if (!Number.isFinite(timestamp) || now - timestamp > maxAgeMs) {
    return verificationFailure(
      QUALIFICATION_REASON_CODES.EXPIRED,
      'qualification record is expired',
    );
  }

  return {
    ok: true,
    reason_code: QUALIFICATION_REASON_CODES.PASS,
    reason: 'recorded qualification matches all required identities and digests',
  };
}
