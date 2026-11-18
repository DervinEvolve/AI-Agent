import * as https from 'node:https';
import * as http from 'node:http';
import { performance } from 'node:perf_hooks';

export type LiveTransportCode =
  | 'CONFIGURATION' | 'CREDENTIAL_REQUIRED' | 'DISCLOSURE_DENIED'
  | 'REQUEST_TOO_LARGE' | 'RESPONSE_TOO_LARGE' | 'HTTP_STATUS'
  | 'NETWORK' | 'INTERRUPTED' | 'DEADLINE' | 'CANCELLED' | 'CLOSED'
  | 'PROTECTED_OUTPUT';

/** Deliberately contains no underlying Error, URL, headers or provider body. */
export class LiveTransportError extends Error {
  readonly code: LiveTransportCode;
  readonly status?: number;
  constructor(code: LiveTransportCode, status?: number) {
    super(code);
    this.name = 'LiveTransportError';
    this.code = code;
    if (Number.isInteger(status) && status! >= 100 && status! <= 599) this.status = status;
  }
}

export interface LiveTransportClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface LiveTransportConfig {
  endpoint: string;
  credential?: string;
  /** HTTP is permitted only for literal 127.0.0.1, without credentials. */
  fixtureMode?: boolean;
  /** Absolute monotonic deadline, in the supplied clock's milliseconds. */
  deadlineMs: number;
  finalizationReserveMs: number;
  maxRequestBytes: number;
  /** Called on a copy of the exact serialized UTF-8 request before sockets. */
  authorizeDisclosure(bytes: Uint8Array): boolean;
  deniedExactBytes?: readonly Uint8Array[];
  /** Shared runtime denied-byte integration is not yet verified. */
  requireSharedDeniedBytes?: boolean;
  /** Additional values whose echo must not escape successful responses. */
  protectedValues?: readonly string[];
  signal?: AbortSignal;
  clock?: LiveTransportClock;
}

const defaultClock: LiveTransportClock = {
  now: () => performance.now(),
  schedule: (callback, delay) => setTimeout(callback, delay),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const RESPONSE_LIMIT = 4 * 1024 * 1024;

/**
 * One request per send; no redirects, pooling or retries. This is a transport,
 * not a ModelAdapter: decoder mapping must be integrated against verified runtime sources.
 */
export class LiveModelTransport {
  private readonly url: URL;
  private readonly credential?: string;
  private readonly clock: LiveTransportClock;
  private readonly deadline: number;
  private readonly cap: number;
  private readonly authorize: (bytes: Uint8Array) => boolean;
  private readonly denied: Buffer[];
  private readonly protectedValues: string[];
  private readonly signal?: AbortSignal;
  private readonly pending = new Set<() => void>();
  private closed = false;

  constructor(config: LiveTransportConfig) {
    const fail = (): never => { throw new LiveTransportError('CONFIGURATION'); };
    let url: URL;
    try { url = new URL(config.endpoint); } catch { return fail(); }
    if (url.username || url.password || url.hash || config.requireSharedDeniedBytes) fail();
    if (config.fixtureMode) {
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || config.credential !== undefined) fail();
    } else {
      if (url.protocol !== 'https:') fail();
      if (!config.credential || !config.credential.trim()) throw new LiveTransportError('CREDENTIAL_REQUIRED');
      if (/[\r\n]/.test(config.credential)) fail();
    }
    if (!Number.isFinite(config.deadlineMs) || !Number.isFinite(config.finalizationReserveMs)
      || config.finalizationReserveMs < 0 || !Number.isSafeInteger(config.maxRequestBytes)
      || config.maxRequestBytes <= 0 || typeof config.authorizeDisclosure !== 'function') fail();
    this.url = url;
    this.credential = config.credential;
    this.clock = config.clock ?? defaultClock;
    this.deadline = config.deadlineMs - config.finalizationReserveMs;
    if (!Number.isFinite(this.deadline)) fail();
    this.cap = config.maxRequestBytes;
    this.authorize = config.authorizeDisclosure;
    this.denied = (config.deniedExactBytes ?? []).map(value => Buffer.from(value));
    this.protectedValues = [...(config.protectedValues ?? []), ...(this.credential ? [this.credential] : [])].filter(Boolean);
    this.signal = config.signal;
  }

  close(): void {
    this.closed = true;
    for (const cancel of [...this.pending]) cancel();
  }

  async send(payload: unknown): Promise<string> {
    if (this.closed) throw new LiveTransportError('CLOSED');
    if (this.signal?.aborted) throw new LiveTransportError('CANCELLED');
    let bytes: Buffer;
    try {
      const text = JSON.stringify(payload);
      if (text === undefined) throw new Error();
      bytes = Buffer.from(text, 'utf8');
    } catch { throw new LiveTransportError('CONFIGURATION'); }
    if (bytes.length > this.cap) throw new LiveTransportError('REQUEST_TOO_LARGE');
    let allowed = false;
    try { allowed = this.authorize(Buffer.from(bytes)) === true; } catch { /* fail closed */ }
    if (!allowed || this.denied.some(value => value.length > 0 && bytes.includes(value))) {
      throw new LiveTransportError('DISCLOSURE_DENIED');
    }
    const remaining = this.deadline - this.clock.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new LiveTransportError('DEADLINE');
    // Authorization callbacks may synchronously cancel or close the host.
    if (this.closed) throw new LiveTransportError('CLOSED');
    if (this.signal?.aborted) throw new LiveTransportError('CANCELLED');

    return new Promise<string>((resolve, reject) => {
      let request: http.ClientRequest | undefined;
      let response: http.IncomingMessage | undefined;
      let done = false;
      let timer: unknown;
      let timerArmed = false;
      const finish = (error?: LiveTransportError, value?: string): void => {
        if (done) return;
        done = true;
        if (timerArmed) this.clock.cancel(timer);
        this.pending.delete(onClose);
        this.signal?.removeEventListener('abort', onAbort);
        response?.destroy();
        request?.destroy();
        if (error) reject(error); else resolve(value!);
      };
      const onClose = (): void => finish(new LiveTransportError('CLOSED'));
      const onAbort = (): void => finish(new LiveTransportError('CANCELLED'));
      const armDeadline = (): void => {
        const left = this.deadline - this.clock.now();
        if (!Number.isFinite(left) || left <= 0) {
          finish(new LiveTransportError('DEADLINE'));
          return;
        }
        timer = this.clock.schedule(armDeadline, Math.min(left, 2147483647));
        timerArmed = true;
      };
      this.pending.add(onClose);
      this.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        armDeadline();
        if (done) return;
        const headers: Record<string, string | number> = {
          'Content-Type': 'application/json', 'Content-Length': bytes.length,
        };
        if (this.credential) headers.Authorization = `Bearer ${this.credential}`;
        const transport = this.url.protocol === 'https:' ? https : http;
        request = transport.request(this.url, { method: 'POST', headers, agent: false }, incoming => {
          response = incoming;
          if (done) { incoming.destroy(); return; }
          const status = incoming.statusCode;
          const success = status !== undefined && status >= 200 && status < 300;
          let length = 0;
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => {
            if (done) return;
            length += chunk.length;
            if (length > RESPONSE_LIMIT) { finish(new LiveTransportError('RESPONSE_TOO_LARGE')); return; }
            // Provider error bodies are counted but never retained.
            if (success) chunks.push(chunk);
          });
          incoming.on('aborted', () => finish(new LiveTransportError('INTERRUPTED')));
          incoming.on('error', () => finish(new LiveTransportError('INTERRUPTED')));
          incoming.on('close', () => {
            if (!incoming.complete) finish(new LiveTransportError('INTERRUPTED'));
          });
          incoming.on('end', () => {
            if (done) return;
            if (!incoming.complete) { finish(new LiveTransportError('INTERRUPTED')); return; }
            if (!success) { finish(new LiveTransportError('HTTP_STATUS', status)); return; }
            const text = Buffer.concat(chunks).toString('utf8');
            // Decode JSON escapes for echo detection without rewriting any arguments.
            let echoed = this.protectedValues.some(secret => text.includes(secret));
            try {
              JSON.parse(text, (_key: string, value: unknown) => {
                if (this.protectedValues.some(secret => _key.includes(secret)
                  || (typeof value === 'string' && value.includes(secret)))) echoed = true;
                return value;
              });
            } catch { /* Complete malformed responses remain decoder work. */ }
            if (echoed) finish(new LiveTransportError('PROTECTED_OUTPUT'));
            else finish(undefined, text);
          });
        });
        request.on('error', () => finish(new LiveTransportError('NETWORK')));
        request.end(bytes);
      } catch { finish(new LiveTransportError('NETWORK')); }
    });
  }
}
