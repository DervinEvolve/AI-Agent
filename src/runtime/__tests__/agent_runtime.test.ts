import { describe, expect, it } from 'vitest';
import {
  AgentRuntime,
  type ModelAdapter,
  type ToolRegistryLike,
} from '../agent_runtime';
import { OutcomeClassifier } from '../outcome_classifier';
import type { ToolSchemaLike } from '../runtime_context';

class ScriptedAdapter implements ModelAdapter {
  private index = 0;
  public calls = 0;

  constructor(private readonly script: Array<{ response: unknown; usage?: { tokens?: number; cost?: number } }>) {}

  async complete(): Promise<{ response: unknown; usage?: { tokens?: number; cost?: number } }> {
    this.calls += 1;
    const item = this.script[this.index];
    this.index += 1;
    if (!item) {
      throw new Error('ScriptedAdapter exhausted');
    }
    return item;
  }
}

function createTestRegistry(
  tools: Record<
    string,
    {
      schema: ToolSchemaLike;
      idempotent?: boolean;
      fn: (args: Record<string, unknown>) => Promise<any>;
    }
  >,
): ToolRegistryLike {
  return {
    listSchemas: () => Object.values(tools).map((t) => t.schema),
    isIdempotent: (name: string) => tools[name]?.idempotent ?? true,
    call: async (name: string, args: Record<string, unknown>) => tools[name].fn(args),
  };
}

describe('AgentRuntime core slice', () => {
  it('dispatches one tool_call, stores snapshot, and publishes grounded completion', async () => {
    const registry = createTestRegistry({
      echo: {
        schema: {
          name: 'echo',
          inputSchema: {
            type: 'object',
            properties: { msg: { type: 'string' } },
            required: ['msg'],
            additionalProperties: false,
          },
        },
        fn: async (args) => ({ status: 'ok', output: { echoed: args.msg } }),
      },
    });

    const adapter = new ScriptedAdapter([
      { response: { kind: 'tool_call', toolName: 'echo', arguments: { msg: 'hello' } } },
      {
        response: {
          kind: 'final_answer',
          text: 'Echoed hello',
          citations: [{ shape: 1, call_id: 'call_1' }],
        },
      },
    ]);

    const runtime = new AgentRuntime();
    const report = await runtime.run('Echo hello', adapter, { registry });
    expect(report.outcome).toBe('completion');
    expect(report.steps).toBe(1);
    expect(report.turns).toBe(2);
    expect(report.validator).toBe('subset');
  });

  it('supports model-turn recall of oversized output with zero allowance cost', async () => {
    const mutableResult = { status: 'ok', output: { data: 'A'.repeat(60) } };
    const registry = createTestRegistry({
      big: {
        schema: { name: 'big', inputSchema: { type: 'object', properties: {} } },
        fn: async () => mutableResult,
      },
    });

    const adapter = new ScriptedAdapter([
      { response: { kind: 'tool_call', toolName: 'big', arguments: {} } },
      { response: { kind: 'tool_call', toolName: 'recall', arguments: { call_id: 'call_1', offset: 0, limit: 20 } } },
      { response: { kind: 'tool_call', toolName: 'recall', arguments: { call_id: 'call_1', offset: 20, limit: 20 } } },
      {
        response: {
          kind: 'final_answer',
          text: 'Recalled output',
          citations: [{ shape: 1, call_id: 'call_1' }],
        },
      },
    ]);

    const runtime = new AgentRuntime();
    const report = await runtime.run('Read big output', adapter, {
      registry,
      preview_limit: 16,
    });
    mutableResult.output.data = 'MUTATED';
    expect(report.outcome).toBe('completion');
    expect(report.steps).toBe(3);
  });

  it('refuses non-idempotent timeout redispatch and blocks fourth recovery attempt', async () => {
    const registry = createTestRegistry({
      flaky: {
        idempotent: false,
        schema: { name: 'flaky', inputSchema: { type: 'object', properties: {} } },
        fn: async () => ({ status: 'timeout', output: null }),
      },
      repair: {
        idempotent: true,
        schema: { name: 'repair', inputSchema: { type: 'object', properties: {} } },
        fn: async () => ({ status: 'ok', output: { ok: false } }),
      },
    });

    const adapter = new ScriptedAdapter([
      { response: { kind: 'tool_call', toolName: 'flaky', arguments: {} } },
      { response: { kind: 'tool_call', toolName: 'flaky', arguments: {} } },
      { response: { kind: 'tool_call', toolName: 'repair', arguments: {} } },
      { response: { kind: 'tool_call', toolName: 'repair', arguments: {} } },
      { response: { kind: 'tool_call', toolName: 'repair', arguments: {} } },
      { response: { kind: 'tool_call', toolName: 'repair', arguments: {} } },
      {
        response: {
          kind: 'final_answer',
          text: 'Could not recover',
          claimsNoToolEvidence: true,
        },
      },
    ]);

    const runtime = new AgentRuntime();
    const report = await runtime.run('Recover', adapter, { registry, max_turns: 10, max_steps: 10 });
    expect(report.outcome).toBe('completion');
    expect(report.unresolved.length).toBe(1);
    expect(report.reasons).toContain('non_idempotent_unknown_outcome_redispatch_refused');
    expect(report.reasons).toContain('recovery_allowance_exhausted');
  });

  it('fails on three consecutive invalid actions without dispatching', async () => {
    let dispatched = 0;
    const registry = createTestRegistry({
      noop: {
        schema: { name: 'noop', inputSchema: { type: 'object', properties: {} } },
        fn: async () => {
          dispatched += 1;
          return { status: 'ok', output: {} };
        },
      },
    });

    const adapter = new ScriptedAdapter([
      { response: { kind: 'tool_call', toolName: 'unknown', arguments: {} } },
      { response: { kind: 'tool_call', toolName: 'noop', arguments: 'bad' } },
      { response: { kind: 'tool_call', toolName: 'noop', arguments: {}, text: 'multi' } },
    ]);

    const runtime = new AgentRuntime();
    const report = await runtime.run('Bad actions', adapter, { registry });
    expect(report.outcome).toBe('failed');
    expect(dispatched).toBe(0);
  });

  it('enforces usage caps and deadline bounds', async () => {
    const registry = createTestRegistry({});
    const adapter = new ScriptedAdapter([
      { response: { kind: 'plan_revision', plan: 'step 1' }, usage: { tokens: 100 } },
      { response: { kind: 'final_answer', text: 'late', claimsNoToolEvidence: true } },
    ]);

    const runtime = new AgentRuntime();
    const report = await runtime.run('Cap test', adapter, { registry, max_tokens: 50 });
    expect(report.outcome).toBe('incomplete');
    expect(adapter.calls).toBe(1);
    expect(report.reasons).toContain('token_cap_exhausted');
  });

  it('validates contracts and rejects malformed contracts with infrastructure_error', async () => {
    const registry = createTestRegistry({});
    const adapter = new ScriptedAdapter([
      { response: { kind: 'final_answer', text: 'done', claimsNoToolEvidence: true } },
    ]);

    const runtime = new AgentRuntime();
    const report = await runtime.run('Contract test', adapter, {
      registry,
      contract: { criteria: [] },
    });
    expect(report.outcome).toBe('incomplete');
    expect(report.reasons).toContain('infrastructure_error');
  });
});
