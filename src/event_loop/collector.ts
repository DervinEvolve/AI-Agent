import { EventEmitter } from 'events';
import { FileWatcher } from './file_watcher';
import { TimerScheduler } from './timer_scheduler';
import { WebhookReceiver } from './webhook_receiver';

export interface EventSpec {
  type: 'file_watch' | 'timer' | 'webhook';
  config: Record<string, unknown>;
}

export interface HandlerSpec {
  goal: string;
  budgets?: Record<string, number>;
  success_criteria?: string[];
  auto_spawn?: boolean;
}

export interface RegisteredListener {
  listener_id: string;
  event_spec: EventSpec;
  handler_spec: HandlerSpec;
  created_at: string;
}

export interface QueuedEvent {
  listener_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface EventCollectorOptions {
  sandboxRoot: string;
  egressAllowed: boolean;
  webhookPort?: number;
}

export class EventCollector extends EventEmitter {
  private listeners: Map<string, RegisteredListener> = new Map();
  private eventQueue: QueuedEvent[] = [];
  private fileWatcher: FileWatcher;
  private timerScheduler: TimerScheduler;
  private webhookReceiver: WebhookReceiver;
  private sandboxRoot: string;
  private egressAllowed: boolean;
  private running = false;

  constructor(options: EventCollectorOptions) {
    super();
    this.sandboxRoot = options.sandboxRoot;
    this.egressAllowed = options.egressAllowed;
    this.fileWatcher = new FileWatcher(this.sandboxRoot);
    this.timerScheduler = new TimerScheduler();
    this.webhookReceiver = new WebhookReceiver(options.webhookPort || 0);
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.fileWatcher.on('event', (event: QueuedEvent) => {
      this.enqueue(event);
    });

    this.timerScheduler.on('event', (event: QueuedEvent) => {
      this.enqueue(event);
    });

    this.webhookReceiver.on('event', (event: QueuedEvent) => {
      this.enqueue(event);
    });

    this.fileWatcher.start();
    this.timerScheduler.start();
    this.webhookReceiver.start();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.fileWatcher.stop();
    this.timerScheduler.stop();
    this.webhookReceiver.stop();
    this.listeners.clear();
    this.eventQueue = [];
  }

  register(
    eventSpec: EventSpec,
    handlerSpec: HandlerSpec
  ): { listener_id: string; error?: string } {
    if (!this.running) {
      return { listener_id: '', error: 'Event loop is not running' };
    }

    // Validate sandbox isolation
    if (eventSpec.type === 'file_watch') {
      const config = eventSpec.config as { path?: string };
      if (!config.path) {
        return { listener_id: '', error: 'file_watch requires a path in config' };
      }
      const normalizedPath = this.normalizePath(config.path);
      if (!normalizedPath.startsWith(this.normalizePath(this.sandboxRoot))) {
        return {
          listener_id: '',
          error: 'File watch path must be within the sandbox root',
        };
      }
    }

    if (eventSpec.type === 'webhook' && !this.egressAllowed) {
      return {
        listener_id: '',
        error: 'Webhook listeners are not allowed when network egress is disabled',
      };
    }

    // Validate handler spec (policy check would go here)
    if (!handlerSpec.goal || handlerSpec.goal.trim().length === 0) {
      return { listener_id: '', error: 'Handler goal must not be empty' };
    }

    const listenerId = `listener_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    const listener: RegisteredListener = {
      listener_id: listenerId,
      event_spec: eventSpec,
      handler_spec: handlerSpec,
      created_at: new Date().toISOString(),
    };

    this.listeners.set(listenerId, listener);

    // Activate the specific event source
    if (eventSpec.type === 'file_watch') {
      const config = eventSpec.config as { path: string; pattern?: string };
      this.fileWatcher.addWatch(listenerId, config.path, config.pattern);
    } else if (eventSpec.type === 'timer') {
      const config = eventSpec.config as {
        interval_ms?: number;
        cron?: string;
        max_fires?: number;
      };
      this.timerScheduler.addTimer(listenerId, config);
    } else if (eventSpec.type === 'webhook') {
      const config = eventSpec.config as { path: string; method?: string };
      this.webhookReceiver.addRoute(listenerId, config.path, config.method);
    }

    return { listener_id: listenerId };
  }

  unregister(listenerId: string): { status: string; error?: string } {
    if (!this.listeners.has(listenerId)) {
      return { status: 'error', error: `Listener ${listenerId} not found` };
    }

    const listener = this.listeners.get(listenerId)!;
    if (listener.event_spec.type === 'file_watch') {
      this.fileWatcher.removeWatch(listenerId);
    } else if (listener.event_spec.type === 'timer') {
      this.timerScheduler.removeTimer(listenerId);
    } else if (listener.event_spec.type === 'webhook') {
      this.webhookReceiver.removeRoute(listenerId);
    }

    this.listeners.delete(listenerId);
    // Remove queued events for this listener
    this.eventQueue = this.eventQueue.filter((e) => e.listener_id !== listenerId);

    return { status: 'unregistered' };
  }

  poll(): { events: QueuedEvent[] } {
    const events = [...this.eventQueue];
    this.eventQueue = [];
    return { events };
  }

  list(): { listeners: RegisteredListener[] } {
    return { listeners: Array.from(this.listeners.values()) };
  }

  private enqueue(event: QueuedEvent): void {
    if (this.listeners.has(event.listener_id)) {
      this.eventQueue.push(event);
      this.emit('event-queued', event);
    }
  }

  private normalizePath(p: string): string {
    // Simple path normalization
    return p.replace(/\/+/g, '/').replace(/\/$/, '');
  }
}
