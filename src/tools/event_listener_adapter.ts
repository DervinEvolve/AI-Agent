import { EventCollector, EventSpec, HandlerSpec, RegisteredListener, QueuedEvent } from '../event_loop/collector';

export interface EventListenerInput {
  action: 'register' | 'unregister' | 'poll' | 'list';
  event_spec?: {
    type: 'file_watch' | 'timer' | 'webhook';
    config: Record<string, unknown>;
  };
  handler_spec?: {
    goal: string;
    budgets?: Record<string, number>;
    success_criteria?: string[];
    auto_spawn?: boolean;
  };
  listener_id?: string;
}

export interface EventListenerOutput {
  status: string;
  listener_id?: string;
  events?: QueuedEvent[];
  listeners?: RegisteredListener[];
  error?: string;
}

export class EventListenerAdapter {
  private collector: EventCollector;

  constructor(collector: EventCollector) {
    this.collector = collector;
  }

  async execute(input: EventListenerInput): Promise<EventListenerOutput> {
    switch (input.action) {
      case 'register': {
        if (!input.event_spec) {
          return { status: 'error', error: 'event_spec is required for register action' };
        }
        if (!input.handler_spec) {
          return { status: 'error', error: 'handler_spec is required for register action' };
        }

        // Auto-spawn is disabled by default for safety
        const handlerSpec: HandlerSpec = {
          ...input.handler_spec,
          auto_spawn: input.handler_spec.auto_spawn === true ? true : false,
        };

        const result = this.collector.register(input.event_spec as EventSpec, handlerSpec);
        if (result.error) {
          return { status: 'error', error: result.error };
        }
        return { status: 'registered', listener_id: result.listener_id };
      }

      case 'unregister': {
        if (!input.listener_id) {
          return { status: 'error', error: 'listener_id is required for unregister action' };
        }
        const result = this.collector.unregister(input.listener_id);
        if (result.error) {
          return { status: 'error', error: result.error };
        }
        return { status: result.status };
      }

      case 'poll': {
        const result = this.collector.poll();
        return { status: 'success', events: result.events };
      }

      case 'list': {
        const result = this.collector.list();
        return { status: 'success', listeners: result.listeners };
      }

      default:
        return { status: 'error', error: `Unknown action: ${(input as { action: string }).action}` };
    }
  }
}
