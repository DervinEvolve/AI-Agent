import {
  IncompatibleCoMountFeature,
  SYNTHESIS_ASSERTION_EXIT_CODE,
  SynthesisStartupContext,
  TEST_SYNTHESIS_CAPS,
  TestSynthesisConfig,
} from './types';

const INCOMPATIBLE_FEATURES: readonly IncompatibleCoMountFeature[] = [
  'durableRuns',
  'sessions',
  'composition',
  'parallelDispatch',
  'asyncWorkers',
  'modelRouter',
  'adaptiveEffort',
  'semanticCompaction',
  'deliberation',
  'triggers',
  'verifierRepair',
  'workspaceTrials',
  'editAlternatives',
  'backgroundJobs',
  'sandboxEgress',
];

function clampInt(value: number | undefined, def: number, hardMax: number): number {
  if (value === undefined) return def;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid integer config value: ${value}`);
  }
  return Math.min(value, hardMax);
}

export function resolveTestSynthesisConfig(
  partial?: Partial<TestSynthesisConfig>,
): Readonly<TestSynthesisConfig> {
  const enabled = partial?.enabled ?? false;
  const attemptShare = partial?.attemptShare ?? TEST_SYNTHESIS_CAPS.attemptShare.default;
  if (
    typeof attemptShare !== 'number' ||
    !Number.isFinite(attemptShare) ||
    attemptShare <= TEST_SYNTHESIS_CAPS.attemptShare.minExclusive ||
    attemptShare > TEST_SYNTHESIS_CAPS.attemptShare.maxInclusive
  ) {
    throw new Error(
      `TestSynthesisConfig.attemptShare must be in (0, ${TEST_SYNTHESIS_CAPS.attemptShare.maxInclusive}], got ${attemptShare}`,
    );
  }

  const unreconciledPolicy = partial?.unreconciledPolicy ?? 'incomplete';
  if (unreconciledPolicy !== 'incomplete' && unreconciledPolicy !== 'warn') {
    throw new Error(`Invalid unreconciledPolicy: ${String(unreconciledPolicy)}`);
  }

  return Object.freeze({
    enabled,
    maxSynthesisRounds: clampInt(
      partial?.maxSynthesisRounds,
      TEST_SYNTHESIS_CAPS.maxSynthesisRounds.default,
      TEST_SYNTHESIS_CAPS.maxSynthesisRounds.hard,
    ),
    maxChecksPerRound: clampInt(
      partial?.maxChecksPerRound,
      TEST_SYNTHESIS_CAPS.maxChecksPerRound.default,
      TEST_SYNTHESIS_CAPS.maxChecksPerRound.hard,
    ),
    maxCheckBytes: clampInt(
      partial?.maxCheckBytes,
      TEST_SYNTHESIS_CAPS.maxCheckBytes.default,
      TEST_SYNTHESIS_CAPS.maxCheckBytes.hard,
    ),
    maxCheckOutputBytes: clampInt(
      partial?.maxCheckOutputBytes,
      TEST_SYNTHESIS_CAPS.maxCheckOutputBytes.default,
      TEST_SYNTHESIS_CAPS.maxCheckOutputBytes.hard,
    ),
    maxFeedbackBytes: clampInt(
      partial?.maxFeedbackBytes,
      TEST_SYNTHESIS_CAPS.maxFeedbackBytes.default,
      TEST_SYNTHESIS_CAPS.maxFeedbackBytes.hard,
    ),
    maxRecordBytes: clampInt(
      partial?.maxRecordBytes,
      TEST_SYNTHESIS_CAPS.maxRecordBytes.default,
      TEST_SYNTHESIS_CAPS.maxRecordBytes.hard,
    ),
    checkTimeoutMs: clampInt(
      partial?.checkTimeoutMs,
      TEST_SYNTHESIS_CAPS.checkTimeoutMs.default,
      TEST_SYNTHESIS_CAPS.checkTimeoutMs.hard,
    ),
    attemptShare,
    unreconciledPolicy,
    assertionExitCode: SYNTHESIS_ASSERTION_EXIT_CODE,
  });
}

export function validateTestSynthesisStartup(
  config: Readonly<TestSynthesisConfig>,
  ctx: SynthesisStartupContext,
): void {
  if (!config.enabled) {
    return;
  }
  if (!ctx.hasRunCodeTool) {
    throw new Error('TestSynthesis requires a registered run_code tool');
  }
  if (!ctx.hasFiniteBudgets) {
    throw new Error(
      'TestSynthesis requires finite step, attempt, token, cost and deadline budgets under shared admission',
    );
  }
  for (const feature of INCOMPATIBLE_FEATURES) {
    if (ctx.coMountedFeatures[feature]) {
      throw new Error(`TestSynthesis cannot be co-mounted with ${feature}`);
    }
  }
}
