export type ValidationStatus = "validated" | "tainted" | "unverifiable" | "evaluated" | "inherited_uncertainty";

export interface UncertaintyEvidence {
  id?: string;
  valid?: boolean;
  tainted?: boolean;
  fresh?: boolean;
}

export interface ConsistencyBackend {
  consistencyScore?: (input: AssessUncertaintyInput) => number;
}

export interface AssessUncertaintyInput {
  prior_confidence: number;
  valid_evidence_count?: number;
  required_evidence_count?: number;
  consistency_score?: number;
  source_tainted?: boolean;
  evidence?: UncertaintyEvidence[];
}

export interface AssessUncertaintyResult {
  evidence_completeness: number;
  consistency_score: number;
  calibrated_confidence: number;
  tainted: boolean;
  validation_status: ValidationStatus;
  source_reliability_ceiling: number;
}

export interface CalibrateConfidenceInput {
  prior_confidence: number;
  ece?: number;
  historical_ece?: number;
  evidence_freshness?: "fresh" | "stale";
  stale_but_usable?: boolean;
  fresh_evidence?: boolean;
  unresolved_contradictions?: boolean;
  source_tainted?: boolean;
}

export interface CalibrateConfidenceResult {
  calibrated_confidence: number;
  historical_factor: number;
  freshness_factor: number;
  contradiction_factor: number;
  source_reliability_ceiling: number;
  validation_status: ValidationStatus;
}

export interface DependencyConfidence {
  id?: string;
  calibrated_confidence: number;
}

export interface PropagateUncertaintyInput {
  dependencies: DependencyConfidence[];
  local_step_confidence: number;
  low_confidence_dependency_threshold?: number;
}

export interface PropagateUncertaintyResult {
  downstream_confidence: number;
  cascading_risk: number;
  inherited_uncertainty: boolean;
  low_confidence_dependency_threshold: number;
  low_confidence_dependencies: DependencyConfidence[];
  validation_status: ValidationStatus;
}

export interface CalibrationObservation {
  predicted_confidence?: number;
  confidence?: number;
  outcome?: number | boolean;
  actual?: number | boolean;
}

export interface CalibrationBin {
  index: number;
  lower_bound: number;
  upper_bound: number;
  count: number;
  mean_confidence: number;
  accuracy: number;
  ece_contribution: number;
}

export interface CalibrationMetricsResult {
  status: "evaluated" | "unverifiable";
  sample_count: number;
  brier_score: number | null;
  ece: number | null;
  bins: CalibrationBin[];
}

export const cap_uncertainty_quantification_and_calibration_23 = {
  id: "cap_uncertainty_quantification_and_calibration_23",
  implementation: {
    id: "cap_uncertainty_deterministic_metrics_24",
    modifies: "cap_uncertainty_quantification_and_calibration_23",
    description:
      "Specify deterministic uncertainty-calibrator calculations so CI can validate confidence, taint propagation, cascading risk, and calibration metrics without model calls or ambiguous heuristic outputs.",
  },
} as const;

const DEFAULT_REQUIRED_EVIDENCE_COUNT = 1;
const DEFAULT_CONSISTENCY_SCORE = 0.5;
const TAINTED_SOURCE_RELIABILITY_CEILING = 0.65;
const UNTAINTED_SOURCE_RELIABILITY_CEILING = 1;
const DEFAULT_ECE_BINS = 10;
const LOW_CONFIDENCE_DEPENDENCY_THRESHOLD = 0.7;

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, finiteNumber(value, 0)));
}

function requiredEvidenceCount(value: unknown): number {
  const count = finiteNumber(value, DEFAULT_REQUIRED_EVIDENCE_COUNT);
  return count > 0 ? count : DEFAULT_REQUIRED_EVIDENCE_COUNT;
}

function validEvidenceCount(input: AssessUncertaintyInput): number {
  if (typeof input.valid_evidence_count === "number" && Number.isFinite(input.valid_evidence_count)) {
    return Math.max(0, input.valid_evidence_count);
  }

  return (input.evidence ?? []).filter((item) => item.valid !== false).length;
}

function isTainted(input: { source_tainted?: boolean; evidence?: UncertaintyEvidence[] }): boolean {
  return Boolean(input.source_tainted) || Boolean(input.evidence?.some((item) => item.tainted));
}

function sourceReliabilityCeiling(tainted: boolean): number {
  return tainted ? TAINTED_SOURCE_RELIABILITY_CEILING : UNTAINTED_SOURCE_RELIABILITY_CEILING;
}

export function assessUncertainty(
  input: AssessUncertaintyInput,
  backend: ConsistencyBackend = {},
): AssessUncertaintyResult {
  const evidenceCompleteness = clamp01(
    validEvidenceCount(input) / requiredEvidenceCount(input.required_evidence_count),
  );
  const backendConsistency = backend.consistencyScore?.(input);
  const consistencyScore = clamp01(
    backendConsistency ?? input.consistency_score ?? DEFAULT_CONSISTENCY_SCORE,
  );
  const tainted = isTainted(input);
  const ceiling = sourceReliabilityCeiling(tainted);
  const calibratedConfidence = clamp01(
    clamp01(input.prior_confidence) *
      (0.6 * evidenceCompleteness + 0.4 * consistencyScore) *
      ceiling,
  );

  return {
    evidence_completeness: evidenceCompleteness,
    consistency_score: consistencyScore,
    calibrated_confidence: calibratedConfidence,
    tainted,
    validation_status: tainted ? "tainted" : evidenceCompleteness > 0 ? "validated" : "unverifiable",
    source_reliability_ceiling: ceiling,
  };
}

export function calibrateConfidence(input: CalibrateConfidenceInput): CalibrateConfidenceResult {
  const ece = clamp01(input.ece ?? input.historical_ece ?? 0);
  const historicalFactor = 1 - Math.min(ece, 0.5);
  const stale =
    input.evidence_freshness === "stale" ||
    input.stale_but_usable === true ||
    input.fresh_evidence === false;
  const freshnessFactor = stale ? 0.75 : 1;
  const contradictionFactor = input.unresolved_contradictions ? 0.5 : 1;
  const ceiling = sourceReliabilityCeiling(Boolean(input.source_tainted));
  const calibratedConfidence = clamp01(
    clamp01(input.prior_confidence) *
      historicalFactor *
      freshnessFactor *
      contradictionFactor *
      ceiling,
  );

  return {
    calibrated_confidence: calibratedConfidence,
    historical_factor: historicalFactor,
    freshness_factor: freshnessFactor,
    contradiction_factor: contradictionFactor,
    source_reliability_ceiling: ceiling,
    validation_status: input.source_tainted ? "tainted" : "validated",
  };
}

export function propagateUncertainty(input: PropagateUncertaintyInput): PropagateUncertaintyResult {
  const threshold = clamp01(
    input.low_confidence_dependency_threshold ?? LOW_CONFIDENCE_DEPENDENCY_THRESHOLD,
  );
  const dependencies = input.dependencies ?? [];
  const dependencyConfidences = dependencies.map((dependency) =>
    clamp01(dependency.calibrated_confidence),
  );
  const minimumParentConfidence =
    dependencyConfidences.length === 0 ? 1 : Math.min(...dependencyConfidences);
  const downstreamConfidence = clamp01(
    minimumParentConfidence * clamp01(input.local_step_confidence),
  );
  const lowConfidenceDependencies = dependencies.filter(
    (dependency) => clamp01(dependency.calibrated_confidence) < threshold,
  );
  const inheritedUncertainty = lowConfidenceDependencies.length > 0;

  return {
    downstream_confidence: downstreamConfidence,
    cascading_risk: clamp01(1 - downstreamConfidence),
    inherited_uncertainty: inheritedUncertainty,
    low_confidence_dependency_threshold: threshold,
    low_confidence_dependencies: lowConfidenceDependencies,
    validation_status: inheritedUncertainty ? "inherited_uncertainty" : "validated",
  };
}

function observationOutcome(observation: CalibrationObservation): number {
  const value = observation.outcome ?? observation.actual ?? 0;
  return typeof value === "boolean" ? (value ? 1 : 0) : clamp01(value);
}

function observationConfidence(observation: CalibrationObservation): number {
  return clamp01(observation.predicted_confidence ?? observation.confidence ?? 0);
}

function binCount(value: unknown): number {
  const count = Math.floor(finiteNumber(value, DEFAULT_ECE_BINS));
  return count > 0 ? count : DEFAULT_ECE_BINS;
}

export function evaluateCalibrationMetrics(
  observations: CalibrationObservation[],
  bins = DEFAULT_ECE_BINS,
): CalibrationMetricsResult {
  const totalCount = observations.length;
  const count = binCount(bins);

  if (totalCount === 0) {
    return {
      status: "unverifiable",
      sample_count: 0,
      brier_score: null,
      ece: null,
      bins: [],
    };
  }

  const calibrationBins: CalibrationBin[] = Array.from({ length: count }, (_, index) => ({
    index,
    lower_bound: index / count,
    upper_bound: (index + 1) / count,
    count: 0,
    mean_confidence: 0,
    accuracy: 0,
    ece_contribution: 0,
  }));
  const confidenceSums = Array.from({ length: count }, () => 0);
  const outcomeSums = Array.from({ length: count }, () => 0);

  let squaredErrorSum = 0;

  for (const observation of observations) {
    const confidence = observationConfidence(observation);
    const outcome = observationOutcome(observation);
    squaredErrorSum += (confidence - outcome) ** 2;

    const index = Math.min(count - 1, Math.floor(confidence * count));
    calibrationBins[index].count += 1;
    confidenceSums[index] += confidence;
    outcomeSums[index] += outcome;
  }

  let ece = 0;
  for (const bin of calibrationBins) {
    if (bin.count === 0) {
      continue;
    }

    bin.mean_confidence = confidenceSums[bin.index] / bin.count;
    bin.accuracy = outcomeSums[bin.index] / bin.count;
    bin.ece_contribution = (bin.count / totalCount) * Math.abs(bin.mean_confidence - bin.accuracy);
    ece += bin.ece_contribution;
  }

  return {
    status: "evaluated",
    sample_count: totalCount,
    brier_score: squaredErrorSum / totalCount,
    ece,
    bins: calibrationBins,
  };
}

export const assess_uncertainty = assessUncertainty;
export const calibrate_confidence = calibrateConfidence;
export const propagate_uncertainty = propagateUncertainty;
export const evaluate_calibration_metrics = evaluateCalibrationMetrics;
