import { describe, expect, it } from 'vitest';
import { preflightImprovementResources, type ImprovementResourceDescriptor } from '../improvement_resource_preflight';

const descriptor = (): ImprovementResourceDescriptor => ({
  taskCount: 4,
  perTrialModelCallCap: 2,
  remainingEndpointRequests: 20,
  remainingCycleRequests: 17,
  maximumInputTokensPerRequest: 1000,
  maximumCompletionTokensPerRequest: 4096,
  endpointCompletionTokenCeiling: 4096,
  inputPricePerMillion: 1000000,
  outputPricePerMillion: 1000000,
  remainingEndpointMicrocurrency: 250000,
  remainingCycleMicrocurrency: 250000,
  maximumMillisecondsPerRequest: 1000,
  cycleDeadline: 100000,
  credentialExpiry: 900000,
  now: 0,
});

describe('improvement resource preflight (not cycle admission)', () => {
  it('bounds the separate four-task smoke envelope at 17 requests', () => {
    const d = Object.freeze(descriptor());
    expect(preflightImprovementResources(d)).toEqual({
      kind: 'bounded', requestEnvelope: 17,
      microcurrencyEnvelope: 17 * 5096, millisecondsEnvelope: 17000,
    });
  });
  it('blocks sixteen tasks even at one call per trial under twenty requests', () => {
    expect(preflightImprovementResources({ ...descriptor(), taskCount: 16,
      perTrialModelCallCap: 1, remainingCycleRequests: 100 })).toEqual({
      kind: 'blocked', reason: 'request_capacity',
    });
  });
  it('does not treat 33 as sufficient for a larger per-trial cap', () => {
    expect(preflightImprovementResources({ ...descriptor(), taskCount: 16,
      remainingEndpointRequests: 33, remainingCycleRequests: 100 })).toEqual({
      kind: 'blocked', reason: 'request_capacity',
    });
  });
  it('requires pricing and capacity instead of estimating missing data', () => {
    for (const key of ['inputPricePerMillion', 'remainingEndpointRequests',
      'maximumInputTokensPerRequest', 'maximumMillisecondsPerRequest'] as const) {
      expect(preflightImprovementResources({ ...descriptor(), [key]: undefined })).toEqual({
        kind: 'blocked', reason: 'capacity_unknown',
      });
    }
  });
  it('applies tighter daily spending and credential deadlines', () => {
    expect(preflightImprovementResources({ ...descriptor(), remainingDailyMicrocurrency: 1 })).toEqual({
      kind: 'blocked', reason: 'spending_capacity',
    });
    expect(preflightImprovementResources({ ...descriptor(), credentialExpiry: 17000 })).toEqual({
      kind: 'blocked', reason: 'deadline_capacity',
    });
  });
  it('rounds fractional microcurrency up per request', () => {
    expect(preflightImprovementResources({ ...descriptor(), inputPricePerMillion: 1,
      outputPricePerMillion: 1 })).toMatchObject({ kind: 'bounded', microcurrencyEnvelope: 17 });
  });
  it('rejects invalid bounds and cancellation without scores', () => {
    for (const value of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(preflightImprovementResources({ ...descriptor(), perTrialModelCallCap: value })).toEqual({
        kind: 'blocked', reason: 'invalid_resource_descriptor',
      });
    }
    expect(preflightImprovementResources({ ...descriptor(), cancelled: true })).toEqual({
      kind: 'blocked', reason: 'cancelled',
    });
  });
  it('handles oversized multiplication without floating-point overflow', () => {
    expect(preflightImprovementResources({ ...descriptor(), taskCount: Number.MAX_SAFE_INTEGER,
      perTrialModelCallCap: Number.MAX_SAFE_INTEGER })).toEqual({ kind: 'blocked', reason: 'request_capacity' });
  });
});
