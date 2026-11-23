import { describe, it, expect, vi } from 'vitest';
import {
  EventStreamAbortController,
  AbortError,
  assertNoDurableRunMount,
} from '../event_stream_abort_57';
import { RuntimeEvent, CancelledResult } from '../types';

describe('cap_event_stream_abort_57 pure-TS slice', () => {
  it('emits ordered events with strictly increasing seq and correct lifecycle ordering', () => {
    const events: RuntimeEvent[] = [];
    const controller = new EventStreamAbortController('run-1', {
      sink: (event) => events.push(event),
      clock: () => 1000,
    });

    controller.start();
    controller.turnStarted(1);
    controller.dispatchIntent('call-1', 'tool-a', 2);
    controller.recordStartedOperation({ call_id: 'call-1', kind: 'tool' });
    controller.recordSettledOperation('call-1', { status: 'success' });
    controller.finalization(true, 'success');

    expect(events.map((e) => e.kind)).toEqual([
      'run_started',
      'turn_started',
      'dispatch_intent',
      'dispatch_settled',
      'finalization',
    ]);

    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
    }
    expect(events[0].kind).toBe('run_started');
    expect(events[1].kind).toBe('turn_started');
    const intentIndex = events.findIndex((e) => e.kind === 'dispatch_intent');
    const settledIndex = events.findIndex((e) => e.kind === 'dispatch_settled');
    expect(intentIndex).toBeLessThan(settledIndex);
    expect(events.filter((e) => e.kind === 'dispatch_settled' && e.payload.call_id === 'call-1')).toHaveLength(1);
  });

  it('records throwing and thenable-returning sinks as sink_error without recursive delivery', () => {
    const events: RuntimeEvent[] = [];
    let throwCount = 0;
    const controller = new EventStreamAbortController('run-2', {
      sink: (event) => {
        events.push(event);
        if (event.kind === 'dispatch_intent') {
          throwCount++;
          throw new Error('boom');
        }
        if (event.kind === 'dispatch_settled') {
          return Promise.resolve();
        }
      },
      clock: () => 2000,
    });

    controller.start();
    controller.dispatchIntent('call-1', 'tool-b', 1);
    controller.recordSettledOperation('call-1', { status: 'success' });

    expect(throwCount).toBe(1);
    expect(controller.getSinkErrors()).toHaveLength(2);
    expect(controller.getSinkErrors()[0].error).toBe('boom');
    expect(controller.getSinkErrors()[1].error).toBe('thenable_returned');
    // No recursive delivery: only the original events, no extra sink_error events.
    expect(events).toHaveLength(3);
  });

  it('elides payloads over byte cap and never includes raw argument bytes', () => {
    const events: RuntimeEvent[] = [];
    const byteCap = 30;
    const controller = new EventStreamAbortController('run-3', {
      sink: (event) => events.push(event),
      byteCap,
      clock: () => 3000,
    });

    controller.dispatchIntent('call-1', 'tool-with-long-name', 123456);
    const event = events[0];
    expect(event.kind).toBe('dispatch_intent');
    const payload = event.payload as { tool_name?: string; _elided_bytes?: number };
    expect(payload._elided_bytes).toBeGreaterThan(0);
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(byteCap + 20); // JSON overhead allowance
    expect(JSON.stringify(payload)).not.toContain('tool-with-long-name');
  });

  it('abort before dispatch start prevents invocation and returns cancelled envelope', () => {
    const controller = new EventStreamAbortController('run-4', {
      signal: AbortSignal.abort(),
      clock: () => 4000,
    });

    expect(() => controller.dispatchIntent('call-1', 'tool-c', 0)).toThrow(AbortError);
    expect(() => controller.recordStartedOperation({ call_id: 'call-1', kind: 'tool' })).toThrow(AbortError);

    controller.aborted();
    const result = controller.getCancelledResult();
    expect(result.reason).toBe('aborted');
    expect(result.references).toHaveLength(0);
    expect(result.unresolved).toHaveLength(0);
    expect(result.verification).toBe('not_run_aborted');
  });

  it('abort fired from inside dispatch_intent sink prevents tool start', () => {
    const abortController = new AbortController();
    const events: RuntimeEvent[] = [];
    const controller = new EventStreamAbortController('run-5', {
      signal: abortController.signal,
      sink: (event) => {
        events.push(event);
        if (event.kind === 'dispatch_intent') {
          abortController.abort();
        }
      },
      clock: () => 5000,
    });

    controller.start();
    controller.dispatchIntent('call-1', 'tool-d', 1);
    // After sink aborts, the subsequent boundary must throw.
    expect(() => controller.recordStartedOperation({ call_id: 'call-1', kind: 'tool' })).toThrow(AbortError);

    controller.aborted();
    const result = controller.getCancelledResult();
    expect(result.references).toHaveLength(0);
    expect(result.unresolved).toHaveLength(0);
    expect(events.some((e) => e.kind === 'dispatch_intent')).toBe(true);
  });

  it('records started call that settles ok before drain cutoff as success; unresolved at cutoff as unknown and never started=false', () => {
    const events: RuntimeEvent[] = [];
    const controller = new EventStreamAbortController('run-6', {
      sink: (event) => events.push(event),
      clock: vi.fn(() => 6000),
    });

    controller.recordStartedOperation({ call_id: 'call-ok', kind: 'tool' });
    controller.recordSettledOperation('call-ok', { status: 'success', classification: 'success' });

    controller.recordStartedOperation({ call_id: 'call-pending', kind: 'tool' });

    const unresolved = controller.drainStartedOperations();
    expect(unresolved.map((op) => op.call_id)).toEqual(['call-pending']);

    const result = controller.getCancelledResult();
    expect(result.references).toEqual([
      { call_id: 'call-ok', started: true, outcome: { status: 'success', classification: 'success' } },
      { call_id: 'call-pending', started: true, outcome: { status: 'unknown' } },
    ]);
    expect(result.unresolved).toEqual([{ call_id: 'call-pending', kind: 'tool' }]);
    // Never started=false for a started call.
    expect(result.references.every((ref) => ref.started === true)).toBe(true);
  });

  it('late results after finalization do not mint a second dispatch_settled', () => {
    const events: RuntimeEvent[] = [];
    const controller = new EventStreamAbortController('run-7', {
      sink: (event) => events.push(event),
      clock: () => 7000,
    });

    controller.recordStartedOperation({ call_id: 'call-1', kind: 'tool' });
    controller.recordSettledOperation('call-1', { status: 'success' });
    controller.finalization(true, 'success');

    // Late reconciliation attempt.
    controller.recordSettledOperation('call-1', { status: 'failure' });

    const settledEvents = events.filter((e) => e.kind === 'dispatch_settled' && e.payload.call_id === 'call-1');
    expect(settledEvents).toHaveLength(1);
    expect(settledEvents[0].payload.outcome.status).toBe('success');
  });

  it('abort after finalization does not rewrite the finalized run', () => {
    const events: RuntimeEvent[] = [];
    const controller = new EventStreamAbortController('run-8', {
      sink: (event) => events.push(event),
      clock: () => 8000,
    });

    controller.finalization(true, 'success');
    controller.aborted();

    const finalizationEvents = events.filter((e) => e.kind === 'finalization');
    expect(finalizationEvents).toHaveLength(1);
    expect(finalizationEvents[0].payload.final).toBe(true);
    expect(events[events.length - 1].kind).toBe('aborted');
  });

  it('startup rejects durable-run mount with signal attached', () => {
    expect(() => assertNoDurableRunMount(AbortSignal.abort())).toThrow(
      /cannot be mounted together with cap_durable_runs_mount_41/,
    );
    expect(() => assertNoDurableRunMount(undefined)).not.toThrow();
  });
});
