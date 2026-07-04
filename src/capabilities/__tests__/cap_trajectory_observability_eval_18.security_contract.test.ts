import { describe, expect, it } from 'vitest';
import { TraceRecorder } from '../cap_trajectory_observability_eval_18';

function start(recorder: TraceRecorder) {
  const response = recorder.handle({ action: 'start_trace', task_id: 'task-observe', scope: { tenant_id: 'tenant-a', retention_days: 7 } });
  expect(response.status).toBe('ok');
  expect(response.trace_ref?.trace_id).toBeTruthy();
  return response.trace_ref!.trace_id;
}

describe('cap_trajectory_observability_eval_18 security contract', () => {
  it('creates unique trace refs with scope, version, timestamps, and redaction provenance', () => {
    const recorder = new TraceRecorder();
    const first = recorder.handle({ action: 'start_trace', task_id: 'task-a', scope: { tenant_id: 't1' } });
    const second = recorder.handle({ action: 'start_trace', task_id: 'task-a', scope: { tenant_id: 't1' } });

    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');
    expect(first.trace_ref?.trace_id).not.toBe(second.trace_ref?.trace_id);
    expect(first.trace_ref).toMatchObject({ task_id: 'task-a', version: 1, event_count: 0, scope: { tenant_id: 't1' } });
    expect(first.trace_ref?.started_at).toEqual(expect.any(String));
    expect(first.provenance.redaction_policy_id).toBe('trace-eval-redaction-v1');
  });

  it('rejects unknown, malformed, oversized, and forbidden-sensitive-field events', () => {
    const recorder = new TraceRecorder();
    const trace_id = start(recorder);

    expect(recorder.handle({ action: 'record_event', trace_id, event: { event_type: 'nonsense' as never, actor: 'controller' } }).status).toBe('invalid_event');
    expect(recorder.handle({ action: 'record_event', trace_id, event: { event_type: 'planning_step', actor: '' } }).status).toBe('invalid_event');
    expect(
      recorder.handle({
        action: 'record_event',
        trace_id,
        event: { event_type: 'tool_invocation', actor: 'controller', inputs: { access_token: 'abc' } },
      }).status,
    ).toBe('invalid_event');
    expect(
      recorder.handle({
        action: 'record_event',
        trace_id,
        event: { event_type: 'reflection', actor: 'controller', outputs: { blob: 'x'.repeat(70_000) } },
      }).status,
    ).toBe('invalid_event');
  });

  it('redacts synthetic secrets before persistence and preserves stable canonical hashes', () => {
    const recorder = new TraceRecorder();
    const trace_id = start(recorder);
    const event = {
      event_type: 'model_call' as const,
      actor: 'model',
      inputs: { prompt: 'use API key sk-test_1234567890abcdef and continue' },
      outputs: { response: 'never reveal OAuth token ya29.A0AfH6SMBexampletokenvalue' },
      budget_delta: { tokens: 10, cost_usd: 0.01 },
    };

    const first = recorder.handle({ action: 'record_event', trace_id, event });
    const stored = recorder.getStoredEvent(trace_id, first.event_ref!.sequence)!;

    expect(first.status).toBe('ok');
    expect(JSON.stringify(stored)).not.toContain('sk-test_1234567890abcdef');
    expect(JSON.stringify(stored)).not.toContain('ya29.A0AfH6SMBexampletokenvalue');
    expect(stored.canonical_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('policy blocks actual vault-held secret bytes instead of persisting a redacted event', () => {
    const recorder = new TraceRecorder();
    const trace_id = start(recorder);

    const response = recorder.handle({
      action: 'record_event',
      trace_id,
      event: {
        event_type: 'api_observation',
        actor: 'adapter',
        outputs: { body: 'BEGIN ACTUAL VAULT SECRET: VAULT_SECRET_BYTES_super_secret_value' },
      },
    });

    expect(response.status).toBe('policy_blocked');
    expect(response.trace_ref?.event_count).toBe(0);
  });

  it('keeps closed traces append-only and requires a new linked version for later writes', () => {
    const recorder = new TraceRecorder();
    const trace_id = start(recorder);
    expect(recorder.handle({ action: 'close_trace', trace_id, event: { event_type: 'final_answer', actor: 'controller', status: 'completed' } }).status).toBe('ok');

    const writeAfterClose = recorder.handle({
      action: 'record_event',
      trace_id,
      event: { event_type: 'reflection', actor: 'controller', outputs: { note: 'mutate closed trace' } },
    });

    expect(writeAfterClose.status).toBe('invalid_event');
    expect(writeAfterClose.error?.code).toBe('trace_closed');
  });

  it('exports redacted traces without approval tokens, cookies, vault handles, hidden prompts, or deleted memory content', () => {
    const recorder = new TraceRecorder();
    const trace_id = start(recorder);
    recorder.handle({
      action: 'record_event',
      trace_id,
      event: {
        event_type: 'memory_operation',
        actor: 'memory',
        inputs: { query: 'deleted item' },
        outputs: { deleted: true, memory_ref: 'mem-1', content: 'deleted memory text must not rehydrate' },
        provenance: { source: 'cap_long_term_memory_3', deletion_ref: 'del-1' },
      },
    });
    recorder.handle({ action: 'close_trace', trace_id });

    const exported = recorder.handle({ action: 'export_redacted_trace', trace_id, export_policy: { max_events: 10, include_hashes: true } });
    const serialized = JSON.stringify(exported.redacted_trace);

    expect(exported.status).toBe('redacted');
    expect(serialized).not.toContain('deleted memory text must not rehydrate');
    expect(serialized).not.toContain('approval_token');
    expect(serialized).not.toContain('vault_session_handle');
    expect(serialized).not.toContain('hidden_prompt');
    expect(serialized).toContain('DELETED_MEMORY_CONTENT_OMITTED');
  });
});
