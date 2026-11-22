/** Pure resource checks. This module neither admits requests nor opens connections. */
export type ImprovementResourceBlockReason =
  | 'invalid_resource_descriptor'
  | 'capacity_unknown'
  | 'request_capacity'
  | 'spending_capacity'
  | 'deadline_capacity'
  | 'cancelled';

export interface ImprovementResourceDescriptor {
  taskCount: number;
  perTrialModelCallCap: number;
  remainingEndpointRequests?: number;
  remainingCycleRequests?: number;
  /** Host-pinned upper bound, including the proposer and rendered tool schemas. */
  maximumInputTokensPerRequest?: number;
  maximumCompletionTokensPerRequest: number;
  endpointCompletionTokenCeiling: number;
  /** Integer microcurrency units per million tokens. Never inferred from model names. */
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  remainingEndpointMicrocurrency?: number;
  remainingCycleMicrocurrency?: number;
  remainingDailyMicrocurrency?: number;
  /** Bound including transport timeout and local processing for each request. */
  maximumMillisecondsPerRequest?: number;
  cycleDeadline: number;
  credentialExpiry: number;
  now: number;
  cancelled?: boolean;
}

export type ImprovementResourcePreflight =
  | { kind: 'blocked'; reason: ImprovementResourceBlockReason }
  | {
      kind: 'bounded';
      requestEnvelope: number;
      microcurrencyEnvelope: number;
      millisecondsEnvelope: number;
    };

const natural = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const positive = (value: unknown): value is number => natural(value) && value > 0;

/**
 * One candidate, one trial per task, both arms, plus one proposer request.
 * A successful check is NOT an admission or an affordability guarantee unless
 * the caller enforces these host bounds through the cycle admission parent.
 * Recheck current capacity before every send; never replay uncertain sends.
 */
export function preflightImprovementResources(
  descriptor: Readonly<ImprovementResourceDescriptor>,
): ImprovementResourcePreflight {
  const blocked = (reason: ImprovementResourceBlockReason): ImprovementResourcePreflight => ({ kind: 'blocked', reason });
  if (descriptor.cancelled) return blocked('cancelled');
  const d = descriptor;
  if (!positive(d.taskCount) || !positive(d.perTrialModelCallCap) ||
      !positive(d.maximumCompletionTokensPerRequest) || !positive(d.endpointCompletionTokenCeiling) ||
      d.maximumCompletionTokensPerRequest > d.endpointCompletionTokenCeiling ||
      !natural(d.now) || !natural(d.cycleDeadline) || !natural(d.credentialExpiry)) {
    return blocked('invalid_resource_descriptor');
  }
  const optional = [d.remainingEndpointRequests, d.remainingCycleRequests,
    d.maximumInputTokensPerRequest, d.inputPricePerMillion, d.outputPricePerMillion,
    d.remainingEndpointMicrocurrency, d.remainingCycleMicrocurrency,
    d.maximumMillisecondsPerRequest];
  if (optional.some(value => value === undefined)) return blocked('capacity_unknown');
  if (optional.some(value => !natural(value)) || !positive(d.maximumMillisecondsPerRequest) ||
      (d.remainingDailyMicrocurrency !== undefined && !natural(d.remainingDailyMicrocurrency))) {
    return blocked('invalid_resource_descriptor');
  }
  // BigInt avoids overflow and rounds cost up separately for every request.
  const requests = 2n * BigInt(d.taskCount) * BigInt(d.perTrialModelCallCap) + 1n;
  if (requests > BigInt(d.remainingEndpointRequests!) || requests > BigInt(d.remainingCycleRequests!)) {
    return blocked('request_capacity');
  }
  const numerator = BigInt(d.maximumInputTokensPerRequest!) * BigInt(d.inputPricePerMillion!) +
    BigInt(d.maximumCompletionTokensPerRequest) * BigInt(d.outputPricePerMillion!);
  const cost = requests * ((numerator + 999999n) / 1000000n);
  if (cost > BigInt(d.remainingEndpointMicrocurrency!) || cost > BigInt(d.remainingCycleMicrocurrency!) ||
      (d.remainingDailyMicrocurrency !== undefined && cost > BigInt(d.remainingDailyMicrocurrency))) {
    return blocked('spending_capacity');
  }
  const duration = requests * BigInt(d.maximumMillisecondsPerRequest!);
  const availableTime = BigInt(Math.min(d.cycleDeadline, d.credentialExpiry)) - BigInt(d.now);
  if (duration >= availableTime) return blocked('deadline_capacity');
  return {
    kind: 'bounded',
    requestEnvelope: Number(requests),
    microcurrencyEnvelope: Number(cost),
    millisecondsEnvelope: Number(duration),
  };
}
