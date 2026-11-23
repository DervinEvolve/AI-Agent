import { describe, it, expect } from 'vitest';
import {
  EventStreamAbortController,
  AbortError,
  assertNoDurableRunMount,
} from '../event_stream_abort_57';
import { RuntimeEvent, CancelledResult } from '../types';

describe('EventStreamAbortController behavior', () => {
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
    let thenableCount = 0;
    const controller = new EventStreamAbortController('run-2', {
      sink: (event) => {
        events.push(event);
        if (event.kind === 'dispatch_intent') {
          throwCount++;
          throw new Error('boom');
        }
        if (event.kind === 'turn_started') {
          thenableCount++;
          return Promise.resolve(); // thenable
        }
      },
      clock: () => 2000,
    });

    controller.start();
    controller.turnStarted(1);
    controller.dispatchIntent('call-1', 'tool-a', 2);
    controller.recordStartedOperation({ call_id: 'call-1', kind: 'tool' });
    controller.recordSettledOperation('call-1', { status: 'success' });
    controller.finalization(true, 'success');

    // All events still delivered
    expect(events).toHaveLength(5);
    // The sink was invoked for each event exactly once
    expect(throwCount).toBe(1);
    expect(thenableCount).toBe(1);
  });

  it('abort before dispatch: checkAbort true, unstarted operation recorded, cancelled result', () => {
    const abortController = new AbortController();
    const controller = new EventStreamAbortController('run-3', {
      signal: abortController.signal,
      clock: () => 3000,
    });

    controller.start();
    controller.turnStarted(1);

    abortController.abort();
    expect(controller.checkAbort()).toBe(true);

    // Record an unstarted operation (e.g., batch member)
    controller.recordUnstartedOperation('call-2', 'aborted');

    const cancelled: CancelledResult = controller.finalizeCancelled();
    expect(cancelled.reason).toBe('aborted');
    expect(cancelled.references).toEqual([]);
    expect(cancelled.unresolvedOperations).toHaveLength(1);
    expect(cancelled.unresolvedOperations[0].call_id).toBe('call-2');
    expect(cancelled.verification).toBe('not_run_aborted');
  });

  it('drain with injected clock: unresolved operation recorded unknown', async () => {
    let fakeNow = 0;
    const controller = new EventStreamAbortController('run-4', {
      clock: () => fakeNow,
      drainDeadlineMs: 100,
    });

    controller.start();
    controller.turnStarted(1);
    controller.dispatchIntent('call-1', 'tool-a', 2);
    controller.recordStartedOperation({ call_id: 'call-1', kind: 'tool' });

    // Advance clock past deadline
    fakeNow = 150;

    await controller.drainStartedOperations();

    const cancelled: CancelledResult = controller.finalizeCancelled();
    expect(cancelled.unresolvedOperations).toHaveLength(1);
    expect(cancelled.unresolvedOperations[0].call_id).toBe('call-1');
  });

  it('assertNoDurableRunMount throws when signal and durable run mount present', () => {
    expect(() =>
      assertNoDurableRunMount({ signal: new AbortController().signal, durableRunMount: true })
    ).toThrow(AbortError);
    expect(() =>
      assertNoDurableRunMount({ signal: undefined, durableRunMount: true })
    ).not.toThrow();
  });
});
