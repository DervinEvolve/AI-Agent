import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventCollector } from '../../event_loop/collector';
import { EventListenerAdapter } from '../../tools/event_listener_adapter';

describe('Event Listener Real Logic Tests', () => {
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
    collector.start();
  });

  afterEach(() => {
    collector.stop();
    try {
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('should reject file_watch registration for paths outside sandbox', async () => {
    const outsidePath = os.tmpdir(); // definitely outside sandboxRoot
    const result = await adapter.execute({
      action: 'register',
      event_spec: {
        type: 'file_watch',
        config: { path: outsidePath },
      },
      handler_spec: {
        goal: 'test',
      },
    });
    expect(result.status).toBe('error');
    expect(result.error).toBeTruthy();
  });

  it('should stop producing events after unregister', async () => {
    const watchDir = path.join(sandboxRoot, 'sub');
    fs.mkdirSync(watchDir);

    const reg = await adapter.execute({
      action: 'register',
      event_spec: {
        type: 'file_watch',
        config: { path: watchDir },
      },
      handler_spec: {
        goal: 'test handler',
      },
    });
    expect(reg.status).toBe('registered');
    const listenerId = reg.listener_id!;

    // create first file
    fs.writeFileSync(path.join(watchDir, 'first.txt'), 'data');
    await new Promise((r) => setTimeout(r, 300));

    let poll = await adapter.execute({ action: 'poll' });
    expect(poll.status).toBe('success');
    expect(poll.events?.some(e => e.listener_id === listenerId)).toBe(true);

    // unregister
    const unreg = await adapter.execute({ action: 'unregister', listener_id: listenerId });
    expect(unreg.status).toBe('unregistered');

    // create second file
    fs.writeFileSync(path.join(watchDir, 'second.txt'), 'data2');
    await new Promise((r) => setTimeout(r, 300));

    poll = await adapter.execute({ action: 'poll' });
    // should have no events for that listener
    const eventsForListener = poll.events?.filter(e => e.listener_id === listenerId) ?? [];
    expect(eventsForListener.length).toBe(0);
  });
});
