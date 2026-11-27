import {
  DELIBERATION_CAPS as CAPS,
  DeliberationConfig,
  DeliberationConfigError,
} from './types';

/** Capabilities that cannot be mounted together with deliberation. */
export const REJECTED_CO_MOUNTS: readonly string[] = Object.freeze([
  'durable_runs',
  'sessions',
  'composition',
  'model_router',
  'adaptive_effort',
  'semantic_compaction',
  'parallel_dispatch',
  'async_workers',
  'claim_support',
]);

export interface DeliberationStartupEnv {
  /** Names actually registered in the tool registry. */
  registeredTools: readonly string[];
  /** Run-wide inference-attempt limit B enforced by shared admission. */
  attemptLimit: number | undefined;
  /** Names of other mounted capabilities (see REJECTED_CO_MOUNTS, 'self_review'). */
  mounted?: readonly string[];
  /** Child runtimes never get deliberation. */
  isChild?: boolean;
}

function disabled(): Readonly<DeliberationConfig> {
  return Object.freeze({
    enabled: false,
    deliberateTools: Object.freeze([]) as readonly string[],
    deliberateFinalAnswer: false,
    deliberationAttemptShare: CAPS.attemptShareDefault,
    maxDeliberatedTurns: CAPS.maxDeliberatedTurnsDefault,
    maxCritiqueBytes: CAPS.maxCritiqueBytesDefault,
    maxRecordBytes: CAPS.maxRecordBytesDefault,
  });
}

function intIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/**
 * Validates and freezes the host configuration at startup. Disabled (the
 * default) performs no checks and changes nothing about the runtime.
 */
export function resolveDeliberationConfig(
  input: Partial<DeliberationConfig> | undefined,
  env: DeliberationStartupEnv,
): Readonly<DeliberationConfig> {
  if (!input || input.enabled !== true || env.isChild === true) return disabled();

  const share = input.deliberationAttemptShare ?? CAPS.attemptShareDefault;
  if (typeof share !== 'number' || !Number.isFinite(share) || share <= 0 || share > CAPS.attemptShareMax) {
    throw new DeliberationConfigError('bad_share', 'deliberationAttemptShare must be > 0 and <= 0.5');
  }
  const maxTurns = input.maxDeliberatedTurns ?? CAPS.maxDeliberatedTurnsDefault;
  if (!intIn(maxTurns, 1, CAPS.maxDeliberatedTurnsHard)) {
    throw new DeliberationConfigError('bad_max_turns', `maxDeliberatedTurns must be an integer in 1..${CAPS.maxDeliberatedTurnsHard}`);
  }
  const critiqueBytes = input.maxCritiqueBytes ?? CAPS.maxCritiqueBytesDefault;
  if (!intIn(critiqueBytes, CAPS.maxCritiqueBytesMin, CAPS.maxCritiqueBytesHard)) {
    throw new DeliberationConfigError('bad_critique_bytes', `maxCritiqueBytes must be an integer in ${CAPS.maxCritiqueBytesMin}..${CAPS.maxCritiqueBytesHard}`);
  }
  const recordBytes = input.maxRecordBytes ?? CAPS.maxRecordBytesDefault;
  if (!intIn(recordBytes, CAPS.maxRecordBytesMin, CAPS.maxRecordBytesHard)) {
    throw new DeliberationConfigError('bad_record_bytes', `maxRecordBytes must be an integer in ${CAPS.maxRecordBytesMin}..${CAPS.maxRecordBytesHard}`);
  }

  const registered = new Set(env.registeredTools);
  const tools: string[] = [];
  for (const t of input.deliberateTools ?? []) {
    if (typeof t !== 'string' || !registered.has(t)) {
      throw new DeliberationConfigError('unregistered_tool', `deliberateTools entry is not a registered tool name: ${String(t)}`);
    }
    if (!tools.includes(t)) tools.push(t);
  }

  const B = env.attemptLimit;
  if (typeof B !== 'number' || !Number.isFinite(B) || !Number.isInteger(B) || B <= 0) {
    throw new DeliberationConfigError('no_attempt_limit', 'a finite run-wide inference-attempt limit is required');
  }
  if (Math.floor(B * share) < CAPS.attemptsPerRound) {
    throw new DeliberationConfigError('share_too_small', 'floor(B*share) leaves fewer than 2 deliberation attempts');
  }

  const mounted = new Set(env.mounted ?? []);
  for (const name of REJECTED_CO_MOUNTS) {
    if (mounted.has(name)) {
      throw new DeliberationConfigError('co_mount_rejected', `deliberation cannot be mounted with ${name}`);
    }
  }
  const finalAnswer = input.deliberateFinalAnswer === true;
  if (finalAnswer && mounted.has('self_review')) {
    throw new DeliberationConfigError('self_review_conflict', 'deliberateFinalAnswer cannot be combined with self_review');
  }

  return Object.freeze({
    enabled: true,
    deliberateTools: Object.freeze(tools) as readonly string[],
    deliberateFinalAnswer: finalAnswer,
    deliberationAttemptShare: share,
    maxDeliberatedTurns: maxTurns,
    maxCritiqueBytes: critiqueBytes,
    maxRecordBytes: recordBytes,
  });
}
