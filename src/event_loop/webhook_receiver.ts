import { EventEmitter } from 'events';
import * as http from 'http';
import { QueuedEvent } from './collector';

interface WebhookRoute {
  listenerId: string;
  path: string;
  method: string;
}

export class WebhookReceiver extends EventEmitter {
  private port: number;
  private server: http.Server | null = null;
  private routes: Map<string, WebhookRoute> = new Map();
  private running = false;

  constructor(port: number) {
    super();
    this.port = port;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.server = http.createServer((req, res) => {
      if (!this.running) {
        res.writeHead(503);
        res.end('Service unavailable');
        return;
      }

      const url = new URL(req.url || '/', `http://localhost:${this.port}`);
      const routeKey = `${req.method}:${url.pathname}`;
      const route = this.routes.get(routeKey);

      if (!route) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });

      req.on('end', () => {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(body || '{}');
        } catch {
          payload = { rawBody: body };
        }

        const event: QueuedEvent = {
          listener_id: route.listenerId,
          event_type: 'webhook',
          payload: {
            method: req.method,
            path: url.pathname,
            headers: req.headers,
            body: payload,
          },
          timestamp: new Date().toISOString(),
        };

        this.emit('event', event);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'received' }));
      });
    });

    this.server.listen(this.port, () => {
      const addr = this.server!.address();
      if (addr && typeof addr === 'object') {
        this.port = addr.port;
      }
    });
  }

  stop(): void {
    this.running = false;
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.routes.clear();
  }

  addRoute(listenerId: string, webhookPath: string, method?: string): void {
    if (!this.running) {
      throw new Error('WebhookReceiver is not running');
    }

    const normalizedPath = webhookPath.startsWith('/') ? webhookPath : `/${webhookPath}`;
    const normalizedMethod = (method || 'POST').toUpperCase();
    const routeKey = `${normalizedMethod}:${normalizedPath}`;

    if (this.routes.has(routeKey)) {
      throw new Error(`Route ${routeKey} is already registered`);
    }

    this.routes.set(routeKey, { listenerId, path: normalizedPath, method: normalizedMethod });
  }

  removeRoute(listenerId: string): void {
    for (const [key, route] of this.routes) {
      if (route.listenerId === listenerId) {
        this.routes.delete(key);
      }
    }
  }

  getPort(): number {
    return this.port;
  }
}
