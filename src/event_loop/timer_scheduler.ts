import { EventEmitter } from 'events';
import { QueuedEvent } from './collector';

interface TimerConfig {
  interval_ms?: number;
  cron?: string;
  max_fires?: number;
}

interface ActiveTimer {
  listenerId: string;
  config: TimerConfig;
  fireCount: number;
  intervalId?: NodeJS.Timeout;
}

export class TimerScheduler extends EventEmitter {
  private timers: Map<string, ActiveTimer> = new Map();
  private running = false;

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
    for (const [listenerId, timer] of this.timers) {
      if (timer.intervalId) {
        clearInterval(timer.intervalId);
      }
    }
    this.timers.clear();
  }

  addTimer(listenerId: string, config: TimerConfig): void {
    if (!this.running) {
      throw new Error('TimerScheduler is not running');
    }

    if (this.timers.has(listenerId)) {
      throw new Error(`Timer already exists for listener ${listenerId}`);
    }

    const intervalMs = config.interval_ms || 60000; // Default 1 minute
    if (intervalMs < 100) {
      throw new Error('Timer interval must be at least 100ms');
    }

    const maxFires = config.max_fires || Infinity;

    const timer: ActiveTimer = {
      listenerId,
      config,
      fireCount: 0,
    };

    timer.intervalId = setInterval(() => {
      if (!this.running) {
        if (timer.intervalId) clearInterval(timer.intervalId);
        return;
      }

      timer.fireCount++;

      const event: QueuedEvent = {
        listener_id: listenerId,
        event_type: 'timer',
        payload: {
          fireCount: timer.fireCount,
          interval_ms: intervalMs,
        },
        timestamp: new Date().toISOString(),
      };

      this.emit('event', event);

      // Stop after reaching max_fires
      if (timer.fireCount >= maxFires) {
        this.removeTimer(listenerId);
      }
    }, intervalMs);

    this.timers.set(listenerId, timer);
  }

  removeTimer(listenerId: string): void {
    const timer = this.timers.get(listenerId);
    if (timer) {
      if (timer.intervalId) {
        clearInterval(timer.intervalId);
      }
      this.timers.delete(listenerId);
    }
  }
}
