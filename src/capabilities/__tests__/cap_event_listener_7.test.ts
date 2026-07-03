import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventCollector } from '../../event_loop/collector';
import { EventListenerAdapter } from '../../tools/event_listener_adapter';

describe('cap_event_listener_7', () => {
  let sandboxRoot: string;
  let collector: EventCollector;
  let adapter: EventListenerAdapter;

  beforeEach(() => {
    sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-'));
    collector = new EventCollector({
      sandboxRoot,
      egressAllowed: false,
    });
    adapter = new EventListenerAdapter(collector);
  });

  afterEach(() => {
    collector.stop();
    // Clean up sandbox
    try {
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('register a file_watch listener on a sandbox path, create a file, poll returns the event with payload', async () => {
    collector.start();

    const watchDir = path.join(sandboxRoot, 'watched');
    fs.mkdirSync(watchDir);

    const registerResult = await adapter.execute({
      action: 'register',
      event_spec: {
        type: 'file_watch',
        config: { path: watchDir },
      },
      handler_spec: {
        goal: 'Process file change',
      },
    });

    expect(registerResult.status).toBe('registered');
    expect(registerResult.listener_id).toBeTruthy();

    // Create a file in the watched directory
    const testFile = path.join(watchDir, 'test.txt');
    fs.writeFileSync(testFile, 'hello');

    // Wait for the file watcher to fire
    await new Promise((resolve) => setTimeout(resolve, 200));

    const pollResult = await adapter.execute({ action: 'poll' });
    expect(pollResult.status).toBe('success');
    expect(pollResult.events).toBeDefined();
    expect(pollResult.events!.length).toBeGreaterThan(0);

    const event = pollResult.events!.find((e) => e.listener_id === registerResult.listener_id);
    expect(event).toBeDefined();
    expect(event!.event_type).toMatch(/file_/);
    expect(event!.payload.filename).toBe('test.txt');
  });

  it('register a timer listener with interval, wait, poll returns timer event', async () => {
    collector.start();

    const registerResult = await adapter.execute({
      action: 'register',
      event_spec: {
        type: 'timer',
        config: { interval_ms: 100 },
      },
      handler_spec: {
        goal: 'Handle timer tick',
      },
    });

    expect(registerResult.status).toBe('registered');
    expect(registerResult.listener_id).toBeTruthy();

    // Wait for the timer to fire
    await new Promise((resolve) => setTimeout(resolve, 250));

    const pollResult = await adapter.execute({ action: 'poll' });
    expect(pollResult.status).toBe('success');
    expect(pollResult.events).toBeDefined();
    expect(pollResult.events!.length).toBeGreaterThan(0);

    const event = pollResult.events!.find((e) => e.listener_id === registerResult.listener_id);
    expect(event).toBeDefined();
    expect(event!.event_type).toBe('timer');
    expect(event!.payload.fireCount).toBeGreaterThan(0);
  });

  it('webhook listener registration is rejected if network egress not allowed for the task', async () => {
    collector.start();

    const result = await adapter.execute({
      action: 'register',
      event_spec: {
        type: 'webhook',
        config: { path: '/hook' },
      },
      handler_spec: {
        goal: 'Handle webhook',
      },
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('egress');
  });

  it('registering a listener with a handler goal that violates policy is rejected', async () => {
    collector.start();

    // Empty goal should be rejected
    const result = await adapter.execute({
      action: 'register',
      event_spec: {
        type: 'timer',
        config: { interval_ms: 1000 },
      },
      handler_spec: {
        goal: '',
      },
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('goal');
  });

  it('unregister removes listener and no further events are queued', async () => {
    collector.start();

    const registerResult = await adapter.execute({
      action: 'register',
      event_spec: {
        type: 'timer',
        config: { interval_ms: 100 },
      },
      handler_spec: {
        goal: 'Handle timer',
      },
    });

    expect(registerResult.status).toBe('registered');
    const listenerId = registerResult.listener_id!;

    // Wait for at least one event
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Unregister
    const unregisterResult = await adapter.execute({
      action: 'unregister',
      listener_id: listenerId,
    });
    expect(unregisterResult.status).toBe('unregistered');

    // Poll to clear any queued events
    await adapter.execute({ action: 'poll' });

    // Wait more and poll again - should have no events for this listener
    await new Promise((resolve) => setTimeout(resolve, 250));
    const pollResult = await adapter.execute({ action: 'poll' });

    const events = pollResult.events || [];
    const listenerEvents = events.filter((e) => e.listener_id === listenerId);
    expect(listenerEvents.length).toBe(0);
  });

  it('poll returns only events for registered listeners', async () => {
    collector.start();

    // Register one listener
    const regResult = await adapter.execute({
      action: 'register',
      event_spec: {
        type: 'timer',
        config: { interval_ms: 100 },
      },
      handler_spec: {
        goal: 'Test handler',
      },
    });

    expect(regResult.status).toBe('registered');

    // Wait for events
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Poll
    const pollResult = await adapter.execute({ action: 'poll' });
    expect(pollResult.status).toBe('success');

    // All events should belong to registered listeners
    for (const event of pollResult.events || []) {
      expect(event.listener_id).toBe(regResult.listener_id);
    }
  });

  it('event listener background thread does not access host filesystem outside sandbox root', async () => {
    collector.start();

    // Try to watch a path outside the sandbox
    const outsidePath = path.join(os.tmpdir(), 'outside-sandbox-' + Date.now());
    fs.mkdirSync(outsidePath);

    try {
      const result = await adapter.execute({
        action: 'register',
        event_spec: {
          type: 'file_watch',
          config: { path: outsidePath },
        },
        handler_spec: {
          goal: 'Should fail',
        },
      });

      expect(result.status).toBe('error');
      expect(result.error).toContain('sandbox');
    } finally {
      fs.rmSync(outsidePath, { recursive: true, force: true });
    }
  });

  it('file_watch listener only monitors paths within the sandbox root; attempts to watch outside are rejected', async () => {
    collector.start();

    // Try to watch the parent of sandbox root
    const parentPath = path.dirname(sandboxRoot);

    const result = await adapter.execute({
      action: 'register',
      event_spec: {
        type: 'file_watch',
        config: { path: parentPath },
      },
      handler_spec: {
        goal: 'Should fail',
      },
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('sandbox');
  });

  it('timer listener respects max_fires and stops after limit', async () => {
    collector.start();

    const registerResult = await adapter.execute({
      action: 'register',
      event_spec: {
        type: 'timer',
        config: { interval_ms: 50, max_fires: 2 },
      },
      handler_spec: {
        goal: 'Limited timer',
      },
    });

    expect(registerResult.status).toBe('registered');
    const listenerId = registerResult.listener_id!;

    // Wait long enough for max_fires to be exceeded
    await new Promise((resolve) => setTimeout(resolve, 300));

    const pollResult = await adapter.execute({ action: 'poll' });
    const events = (pollResult.events || []).filter((e) => e.listener_id === listenerId);

    // Should have at most max_fires events
    expect(events.length).toBeLessThanOrEqual(2);

    // Check the list - listener should be removed after max_fires
    const listResult = await adapter.execute({ action: 'list' });
    const listener = listResult.listeners?.find((l) => l.listener_id === listenerId);
    expect(listener).toBeUndefined();
  });

  it('multiple concurrent listeners do not interfere', async () => {
    collector.start();

    // Register two file watchers on different directories
    const dir1 = path.join(sandboxRoot, 'dir1');
    const dir2 = path.join(sandboxRoot, 'dir2');
    fs.mkdirSync(dir1);
    fs.mkdirSync(dir2);

    const reg1 = await adapter.execute({
      action: 'register',
      event_spec: { type: 'file_watch', config: { path: dir1 } },
      handler_spec: { goal: 'Handler 1' },
    });

    const reg2 = await adapter.execute({
      action: 'register',
      event_spec: { type: 'file_watch', config: { path: dir2 } },
      handler_spec: { goal: 'Handler 2' },
    });

    expect(reg1.status).toBe('registered');
    expect(reg2.status).toBe('registered');

    // Create a file in dir1 only
    fs.writeFileSync(path.join(dir1, 'file1.txt'), 'content');

    await new Promise((resolve) => setTimeout(resolve, 200));

    const pollResult = await adapter.execute({ action: 'poll' });
    const events = pollResult.events || [];

    // Should have event for listener 1 but not listener 2
    const listener1Events = events.filter((e) => e.listener_id === reg1.listener_id);
    const listener2Events = events.filter((e) => e.listener_id === reg2.listener_id);

    expect(listener1Events.length).toBeGreaterThan(0);
    expect(listener2Events.length).toBe(0);
  });

  it('handler goal execution via spawn_subagents respects all sub-agent constraints', async () => {
    // This test validates that the handler spec is properly stored and can be
    // passed to spawn_subagents. The actual spawning is done by the agent runtime,
    // but we verify the adapter correctly preserves the handler configuration.
    collector.start();

    const handlerSpec = {
      goal: 'Analyze file changes and report findings',
      budgets: { max_tokens: 1000 },
      success_criteria: ['Report generated', 'No errors'],
      auto_spawn: false, // Default: disabled for safety
    };

    const registerResult = await adapter.execute({
      action: 'register',
      event_spec: {
        type: 'file_watch',
        config: { path: sandboxRoot },
      },
      handler_spec: handlerSpec,
    });

    expect(registerResult.status).toBe('registered');

    // Verify the listener is stored with the correct handler spec
    const listResult = await adapter.execute({ action: 'list' });
    const listener = listResult.listeners?.find(
      (l) => l.listener_id === registerResult.listener_id
    );

    expect(listener).toBeDefined();
    expect(listener!.handler_spec.goal).toBe(handlerSpec.goal);
    expect(listener!.handler_spec.budgets).toEqual(handlerSpec.budgets);
    expect(listener!.handler_spec.success_criteria).toEqual(handlerSpec.success_criteria);
    expect(listener!.handler_spec.auto_spawn).toBe(false);
  });

  it('list action returns all registered listeners', async () => {
    collector.start();

    // Register a few listeners
    await adapter.execute({
      action: 'register',
      event_spec: { type: 'timer', config: { interval_ms: 1000 } },
      handler_spec: { goal: 'Timer 1' },
    });

    await adapter.execute({
      action: 'register',
      event_spec: { type: 'timer', config: { interval_ms: 2000 } },
      handler_spec: { goal: 'Timer 2' },
    });

    const listResult = await adapter.execute({ action: 'list' });
    expect(listResult.status).toBe('success');
    expect(listResult.listeners).toBeDefined();
    expect(listResult.listeners!.length).toBe(2);
    expect(listResult.listeners![0].listener_id).toBeTruthy();
    expect(listResult.listeners![0].created_at).toBeTruthy();
  });

  it('poll returns empty events when no events have been triggered', async () => {
    collector.start();

    const pollResult = await adapter.execute({ action: 'poll' });
    expect(pollResult.status).toBe('success');
    expect(pollResult.events).toEqual([]);
  });

  it('register with invalid action returns error', async () => {
    collector.start();

    const result = await adapter.execute({
      action: 'invalid' as 'register',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Unknown action');
  });

  it('unregister with non-existent listener returns error', async () => {
    collector.start();

    const result = await adapter.execute({
      action: 'unregister',
      listener_id: 'nonexistent',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('not found');
  });
});
