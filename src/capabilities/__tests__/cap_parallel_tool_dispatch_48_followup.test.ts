import { describe, it, expect } from 'vitest';
import {
  HARD_MAX_TOOL_CALLS_PER_TURN,
  RECOMMENDED_MAX_TOOL_CALLS_PER_TURN,
  validateDispatchConfig,
  decodeActionEnvelope,
} from '../cap_parallel_tool_dispatch_48';

describe('cap_parallel_tool_dispatch_48 followup', () => {
  it('exports expected cap constants', () => {
    expect(HARD_MAX_TOOL_CALLS_PER_TURN).toBe(8);
    expect(RECOMMENDED_MAX_TOOL_CALLS_PER_TURN).toBe(4);
  });

  it('validates dispatch config for single-action defaults and child loops', () => {
    expect(validateDispatchConfig({ maxToolCallsPerTurn: 1 })).toEqual({
      effectiveMaxCalls: 1,
      effectiveConcurrency: 1,
    });

    expect(validateDispatchConfig({ maxToolCallsPerTurn: 4, isChildLoop: true })).toEqual({
      effectiveMaxCalls: 1,
      effectiveConcurrency: 1,
    });

    expect(() =>
      validateDispatchConfig({ maxToolCallsPerTurn: 2, durableRunMount: true }),
    ).toThrow();
  });

  it('decodes valid tool_calls envelope and mints distinct call_ids', () => {
    const res = decodeActionEnvelope(
      {
        kind: 'tool_calls',
        reasoning_details: { trace: 'r1' },
        tool_calls: [
          { provider_call_id: 'p1', name: 'read_file', arguments: '{"path":"a.txt"}' },
          { provider_call_id: 'p2', name: 'list_dir', arguments: { dir: '.' } },
        ],
      },
      4,
    );

    expect(res.ok).toBe(true);
    expect(res.acceptedCalls).toHaveLength(2);
    expect(res.acceptedCalls[0].provider_call_id).toBe('p1');
    expect(res.acceptedCalls[0].name).toBe('read_file');
    expect(res.acceptedCalls[0].parsedArgs).toEqual({ path: 'a.txt' });
    expect(res.acceptedCalls[1].provider_call_id).toBe('p2');
    expect(res.acceptedCalls[1].parsedArgs).toEqual({ dir: '.' });
    expect(res.acceptedCalls[0].call_id).toBeTruthy();
    expect(res.acceptedCalls[1].call_id).toBeTruthy();
    expect(res.acceptedCalls[0].call_id).not.toBe(res.acceptedCalls[1].call_id);
    expect(res.reasoning_details).toEqual({ trace: 'r1' });
  });

  it('rejects malformed JSON arguments, empty provider_call_id, and mutually exclusive fields', () => {
    expect(
      decodeActionEnvelope(
        {
          kind: 'tool_calls',
          tool_calls: [{ provider_call_id: 'p1', name: 'a', arguments: '{bad json' }],
        },
        4,
      ).ok,
    ).toBe(false);

    expect(
      decodeActionEnvelope(
        {
          kind: 'tool_calls',
          tool_calls: [{ provider_call_id: '', name: 'a', arguments: '{}' }],
        },
        4,
      ).ok,
    ).toBe(false);

    expect(
      decodeActionEnvelope(
        {
          kind: 'tool_calls',
          final_answer: 'conflict',
          tool_calls: [{ provider_call_id: 'p1', name: 'a', arguments: '{}' }],
        },
        4,
      ).ok,
    ).toBe(false);
  });
});
