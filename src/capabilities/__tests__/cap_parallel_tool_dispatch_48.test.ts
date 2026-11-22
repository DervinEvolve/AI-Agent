import { describe, it, expect } from 'vitest';
import {
  validateDispatchConfig,
  decodeActionEnvelope,
  dispatchToolBatch,
  compactTurnGroups,
  type ToolRegistration,
  type RecoveryLedgerState,
  type BudgetState,
  type TurnMessage,
} from '../cap_parallel_tool_dispatch_48';

function makeLedger(): RecoveryLedgerState {
  return { slot: null, unknownOutcomes: [], quarantinedServices: new Set() };
}

function makeBudget(steps = 10, usage = 10): BudgetState {
  return { stepsRemaining: steps, usageRemaining: usage, reservedSteps: 0, reservedUsage: 0 };
}

describe('cap_parallel_tool_dispatch_48', () => {
  it('rejects batching combined with durableRunMount at startup', () => {
    expect(() => validateDispatchConfig({ maxToolCallsPerTurn: 4, durableRunMount: true })).toThrow();
    expect(validateDispatchConfig({ maxToolCallsPerTurn: 1, durableRunMount: true })).toEqual({
      effectiveMaxCalls: 1,
      effectiveConcurrency: 1,
    });
  });

  it('keeps child loops single-action', () => {
    expect(validateDispatchConfig({ maxToolCallsPerTurn: 4, isChildLoop: true })).toEqual({
      effectiveMaxCalls: 1,
      effectiveConcurrency: 1,
    });
  });

  it('rejects over-cap, duplicate-id, mutually exclusive, and malformed-argument envelopes', () => {
    expect(
      decodeActionEnvelope(
        {
          kind: 'tool_calls',
          tool_calls: [
            { provider_call_id: '1', name: 'a', arguments: '{}' },
            { provider_call_id: '2', name: 'b', arguments: '{}' },
          ],
        },
        1,
      ).ok,
    ).toBe(false);

    expect(
      decodeActionEnvelope(
        {
          kind: 'tool_calls',
          tool_calls: [
            { provider_call_id: 'dup', name: 'a', arguments: '{}' },
            { provider_call_id: 'dup', name: 'b', arguments: '{}' },
          ],
        },
        4,
      ).ok,
    ).toBe(false);

    expect(
      decodeActionEnvelope(
        {
          kind: 'tool_calls',
          tool_calls: [{ provider_call_id: '1', name: 'a', arguments: '{bad json' }],
        },
        4,
      ).ok,
    ).toBe(false);

    expect(
      decodeActionEnvelope(
        {
          kind: 'tool_calls',
          tool_calls: [{ provider_call_id: '1', name: 'a', arguments: '{}' }],
          final_answer: 'done',
        },
        4,
      ).ok,
    ).toBe(false);
  });

  it('runs concurrentSafe idempotent batch concurrently and returns results in emitted order', async () => {
    const order: string[] = [];
    const registry = new Map<string, ToolRegistration>([
      [
        'fast',
        {
          name: 'fast',
          idempotent: true,
          concurrentSafe: true,
          execute: async (args) => {
            await new Promise((r) => setTimeout(r, 15));
            order.push(String(args.id));
            return args.id;
          },
        },
      ],
    ]);

    const decoded = decodeActionEnvelope(
      {
        kind: 'tool_calls',
        tool_calls: [
          { provider_call_id: 'p1', name: 'fast', arguments: '{"id":1}' },
          { provider_call_id: 'p2', name: 'fast', arguments: '{"id":2}' },
          { provider_call_id: 'p3', name: 'fast', arguments: '{"id":3}' },
        ],
        reasoning_details: { trace: 'kept' },
      },
      4,
    );
    expect(decoded.ok).toBe(true);
    expect(decoded.reasoning_details).toEqual({ trace: 'kept' });

    const results = await dispatchToolBatch(
      decoded.acceptedCalls,
      registry,
      makeLedger(),
      makeBudget(),
      { maxToolCallsPerTurn: 4, maxConcurrency: 3 },
    );

    expect(results.map((r) => r.provider_call_id)).toEqual(['p1', 'p2', 'p3']);
    expect(results.every((r) => r.started && r.outcome === 'success')).toBe(true);
    expect(order.length).toBe(3);
  });

  it('falls back to sequential when any tool is not concurrentSafe and stops tail on failure', async () => {
    const executed: string[] = [];
    const registry = new Map<string, ToolRegistration>([
      [
        'unsafe',
        {
          name: 'unsafe',
          idempotent: true,
          concurrentSafe: false,
          execute: async () => {
            executed.push('unsafe');
            throw new Error('boom');
          },
        },
      ],
      [
        'safe',
        {
          name: 'safe',
          idempotent: true,
          concurrentSafe: true,
          execute: async () => {
            executed.push('safe');
            return 'ok';
          },
        },
      ],
    ]);

    const decoded = decodeActionEnvelope(
      {
        kind: 'tool_calls',
        tool_calls: [
          { provider_call_id: 'p1', name: 'unsafe', arguments: '{}' },
          { provider_call_id: 'p2', name: 'safe', arguments: '{}' },
        ],
      },
      4,
    );

    const ledger = makeLedger();
    const results = await dispatchToolBatch(
      decoded.acceptedCalls,
      registry,
      ledger,
      makeBudget(),
      { maxToolCallsPerTurn: 4, maxConcurrency: 2 },
    );

    expect(executed).toEqual(['unsafe']);
    expect(results[0].started).toBe(true);
    expect(results[0].outcome).toBe('known_error');
    expect(results[1].started).toBe(false);
    expect(results[1].unstartedReason).toBe('batch_aborted');
    expect(ledger.slot?.toolName).toBe('unsafe');
  });

  it('handles budget exhaustion without debiting unstarted tails', async () => {
    const registry = new Map<string, ToolRegistration>([
      [
        't',
        {
          name: 't',
          idempotent: true,
          concurrentSafe: false,
          execute: async () => 'ok',
        },
      ],
    ]);
    const decoded = decodeActionEnvelope(
      {
        kind: 'tool_calls',
        tool_calls: [
          { provider_call_id: 'p1', name: 't', arguments: '{}' },
          { provider_call_id: 'p2', name: 't', arguments: '{}' },
        ],
      },
      4,
    );
    const budget = makeBudget(1, 1);
    const results = await dispatchToolBatch(
      decoded.acceptedCalls,
      registry,
      makeLedger(),
      budget,
      { maxToolCallsPerTurn: 4 },
    );

    expect(results[0].started).toBe(true);
    expect(results[1].started).toBe(false);
    expect(results[1].unstartedReason).toBe('budget_exhausted');
    expect(budget.reservedSteps).toBe(1);
  });

  it('compacts assistant tool_calls and paired tool results as an atomic turn group', () => {
    const messages: TurnMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        tool_calls: [
          { provider_call_id: 'p1', name: 'a', arguments: '{}' },
          { provider_call_id: 'p2', name: 'b', arguments: '{}' },
        ],
      },
      { role: 'tool', provider_call_id: 'p1', content: 'r1' },
      { role: 'tool', provider_call_id: 'p2', content: 'r2' },
      { role: 'user', content: 'next' },
    ];

    const compacted = compactTurnGroups(messages, 4);
    expect(compacted.length).toBe(4);
    expect(compacted[0].role).toBe('assistant');
    expect(compacted[1].provider_call_id).toBe('p1');
    expect(compacted[2].provider_call_id).toBe('p2');
    expect(compacted[3].content).toBe('next');
  });
});
