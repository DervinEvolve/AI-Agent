import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { QueuedEvent } from './collector';

export class FileWatcher extends EventEmitter {
  private sandboxRoot: string;
  private watchers: Map<string, fs.FSWatcher> = new Map();
  private watchPaths: Map<string, { listenerId: string; pattern?: string }> = new Map();
  private running = false;

  constructor(sandboxRoot: string) {
    super();
    this.sandboxRoot = path.resolve(sandboxRoot);
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
    for (const [watchPath, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();
    this.watchPaths.clear();
  }

  addWatch(listenerId: string, watchPath: string, pattern?: string): void {
    if (!this.running) {
      throw new Error('FileWatcher is not running');
    }

    const resolvedPath = path.resolve(watchPath);
    const normalizedRoot = path.resolve(this.sandboxRoot);

    // Strict isolation: ensure watch path is within sandbox root
    if (!resolvedPath.startsWith(normalizedRoot + path.sep) && resolvedPath !== normalizedRoot) {
      throw new Error(
        `File watch path "${watchPath}" is outside the sandbox root "${this.sandboxRoot}"`
      );
    }

    // If already watching this path, just update the mapping
    if (this.watchPaths.has(resolvedPath)) {
      this.watchPaths.set(resolvedPath, { listenerId, pattern });
      return;
    }

    try {
      const watcher = fs.watch(resolvedPath, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        const entry = this.watchPaths.get(resolvedPath);
        if (!entry) return;

        // Apply pattern filter if specified
        if (entry.pattern) {
          const regex = new RegExp(entry.pattern);
          if (!regex.test(filename)) {
            return;
          }
        }

        const fullPath = path.join(resolvedPath, filename);
        const event: QueuedEvent = {
          listener_id: entry.listenerId,
          event_type: `file_${eventType}`,
          payload: {
            path: fullPath,
            filename,
            eventType,
          },
          timestamp: new Date().toISOString(),
        };

        this.emit('event', event);
      });

      watcher.on('error', (err) => {
        // Log error but don't crash
        console.error(`FileWatcher error for ${resolvedPath}:`, err.message);
      });

      this.watchers.set(resolvedPath, watcher);
      this.watchPaths.set(resolvedPath, { listenerId, pattern });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to watch path "${resolvedPath}": ${message}`);
    }
  }

  removeWatch(listenerId: string): void {
    // Find and remove all watch paths associated with this listener
    for (const [watchPath, entry] of this.watchPaths) {
      if (entry.listenerId === listenerId) {
        const watcher = this.watchers.get(watchPath);
        if (watcher) {
          watcher.close();
          this.watchers.delete(watchPath);
        }
        this.watchPaths.delete(watchPath);
      }
    }
  }
}
