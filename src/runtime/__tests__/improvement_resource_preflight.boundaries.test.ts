import { describe, expect, it } from 'vitest';
import { preflightImprovementResources, type ImprovementResourceDescriptor } from '../improvement_resource_preflight';

// Each request costs 3 * 2 + 5 * 1 = 11 microcurrency units.
// Two arms of four tasks at two calls, plus the proposer, require 17 calls.
const exactBudget = (): ImprovementResourceDescriptor => ({
  taskCount: 4,
  perTrialModelCallCap: 2,
  remainingEndpointRequests: 17,
  remainingCycleRequests: 17,
  maximumInputTokensPerRequest: 3,
  maximumCompletionTokensPerRequest: 5,
  endpointCompletionTokenCeiling: 5,
  inputPricePerMillion: 2000000,
  outputPricePerMillion: 1000000,
  remainingEndpointMicrocurrency: 187,
  remainingCycleMicrocurrency: 187,
  remainingDailyMicrocurrency: 187,
  maximumMillisecondsPerRequest: 10,
  now: 1000,
  cycleDeadline: 1170,
  credentialExpiry: 1170,
});

describe('resource envelope inclusive boundaries', () => {
  it('accepts exactly sufficient independent budgets without mutating the descriptor', () => {
    const input = Object.freeze(exactBudget());
    const before = { ...input };
    expect(preflightImprovementResources(input)).toEqual({
      kind: 'bounded',
      requestEnvelope: 17,
      microcurrencyEnvelope: 187,
      millisecondsEnvelope: 170,
    });
    expect(input).toEqual(before);
  });

  it('requires both request allowances to cover the complete envelope', () => {
    for (const key of ['remainingEndpointRequests', 'remainingCycleRequests'] as const) {
      expect(preflightImprovementResources({ ...exactBudget(), [key]: 16 })).toEqual({
        kind: 'blocked', reason: 'request_capacity',
      });
    }
  });

  it('lets each independent spending limit veto an otherwise affordable envelope', () => {
    for (const key of [
      'remainingEndpointMicrocurrency',
      'remainingCycleMicrocurrency',
      'remainingDailyMicrocurrency',
    ] as const) {
      expect(preflightImprovementResources({ ...exactBudget(), [key]: 186 })).toEqual({
        kind: 'blocked', reason: 'spending_capacity',
      });
    }
  });

  it('checks remaining time rather than comparing the duration to absolute timestamps', () => {
    for (const key of ['cycleDeadline', 'credentialExpiry'] as const) {
      expect(preflightImprovementResources({ ...exactBudget(), [key]: 1169 })).toEqual({
        kind: 'blocked', reason: 'deadline_capacity',
      });
    }
  });
});
