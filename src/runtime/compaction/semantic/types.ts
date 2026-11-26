export const SEMANTIC_COMPACTION_HARD_CAPS = Object.freeze({
  summaryMaxBytes: 8192,
  summarizerInputMaxBytes: 65536,
  maxSummariesPerRun: 32,
  maxRetainedSummaries: 8,
  summarizerInferenceShare: 0.5,
});

export interface SemanticCompactionConfig {
  enabled: boolean;
  summaryMaxBytes: number;
  summarizerInputMaxBytes: number;
  maxSummariesPerRun: number;
  maxRetainedSummaries: number;
  summarizerInferenceShare: number;
  summarizerTimeoutMs: number;
}

export type SemanticReasonCode =
  | 'disabled'
  | 'cap_reached'
  | 'admission_refused'
  | 'summary_failed'
  | 'summary_rejected'
  | 'timeout';

export interface SummaryRecord {
  generation: number;
  text: string;
  byteSize: number;
  coveredCallIds: string[];
  elidedCount: number;
  summarizer_is_primary_model: boolean;
  untrusted: true;
  citable: false;
  exposing: false;
}

export const MAX_COVERED_CALL_IDS = 32;

export const DEFAULT_SEMANTIC_COMPACTION_CONFIG: SemanticCompactionConfig = Object.freeze({
  enabled: false,
  summaryMaxBytes: 2048,
  summarizerInputMaxBytes: 16384,
  maxSummariesPerRun: 8,
  maxRetainedSummaries: 4,
  summarizerInferenceShare: 0.2,
  summarizerTimeoutMs: 10000,
});

export function resolveSemanticConfig(
  partial: Partial<SemanticCompactionConfig> = {},
): SemanticCompactionConfig {
  const c = { ...DEFAULT_SEMANTIC_COMPACTION_CONFIG, ...partial };
  const H = SEMANTIC_COMPACTION_HARD_CAPS;
  const chk = (name: string, v: number, max: number) => {
    if (!Number.isFinite(v) || v <= 0 || v > max) throw new Error(`invalid ${name}`);
  };
  chk('summaryMaxBytes', c.summaryMaxBytes, H.summaryMaxBytes);
  chk('summarizerInputMaxBytes', c.summarizerInputMaxBytes, H.summarizerInputMaxBytes);
  chk('maxSummariesPerRun', c.maxSummariesPerRun, H.maxSummariesPerRun);
  chk('maxRetainedSummaries', c.maxRetainedSummaries, H.maxRetainedSummaries);
  chk('summarizerInferenceShare', c.summarizerInferenceShare, H.summarizerInferenceShare);
  chk('summarizerTimeoutMs', c.summarizerTimeoutMs, 600000);
  return Object.freeze(c);
}
