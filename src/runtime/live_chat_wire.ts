/**
 * live_chat_wire.ts
 *
 * Self-contained wire-level helpers for one pinned format: OpenAI-compatible
 * chat completions with native tool_calls, non-streaming.
 *
 * This module deliberately imports NOTHING from the rest of src/. The export
 * preflight for cap_live_model_adapter_21 could not be completed by inspection
 * (see docs/live-chat-wire-preflight.md), so it does not reference any symbol
 * of the runtime core. It is not a ModelAdapter, not a loop, and not an action
 * decoder: it performs the HTTP exchange, classifies transport failures, pulls
 * the wire fields out of a complete body, and rebuilds prior assistant messages
 * for stateless replay.
 *
 * Node built-in modules only.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_ERROR_BODY_CHARS = 512;
const REDACTED = '[REDACTED]';

export type WireFailureCode =
  | 'missing_api_key'
  | 'invalid_endpoint'
  | 'unserializable_request'
  | 'deadline_exceeded'
  | 'connect_failed'
  | 'connection_error'
  | 'truncated_body'
  | 'response_too_large'
  | 'redirect_refused'
  | 'rate_limited'
  | 'http_4xx'
  | 'http_5xx';

export interface WireFailure {
  kind: 'config_error' | 'transport_error';
  code: WireFailureCode;
  message: string;
  /** True only when no request bytes were sent, or the provider confirmed a pre-processing refusal (429) that fits the deadline. */
  retryable: boolean;
  /** True once a socket was connected, i.e. request bytes may have left the host. */
  requestSent: boolean;
  status?: number;
  retryAfterMs?: number;
}

export type WireOutcome =
  | { ok: true; status: number; bodyText: string }
  | { ok: false; error: WireFailure };

export interface PostChatCompletionOptions {
  /** Full URL of the chat completions route, e.g. https://host/v1/chat/completions */
  endpoint: string;
  apiKey: string | undefined;
  body: unknown;
  /** Total deadline for this exchange in milliseconds (caller clamps it to remaining run time minus its finalization reserve). */
  deadlineMs: number;
  maxResponseBytes?: number;
  /** Explicit fixture opt-in: allows http only for the literal host 127.0.0.1. */
  allowLoopbackHttp?: boolean;
}

/** Replace every occurrence of the key in text. Safe for an empty or missing key. */
export function redactKey(text: string, apiKey: string | undefined): string {
  if (typeof apiKey !== 'string') return text;
  const key = apiKey.trim();
  if (key.length === 0) return text;
  return text.split(key).join(REDACTED);
}

/** Read the key from a host environment map. Returns undefined for missing, empty, or whitespace values. */
export function readApiKeyFromEnv(
  env: Record<string, string | undefined>,
  variableName: string,
): string | undefined {
  const value = env[variableName];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export type EndpointCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Non-loopback endpoints require https. Userinfo is rejected. http only for 127.0.0.1 under explicit opt-in. Opens no socket. */
export function checkEndpoint(endpoint: string, allowLoopbackHttp: boolean): EndpointCheck {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: 'endpoint is not a valid URL' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'userinfo in the endpoint URL is not allowed' };
  }
  if (url.protocol === 'https:') return { ok: true, url };
  if (url.protocol === 'http:') {
    if (allowLoopbackHttp && url.hostname === '127.0.0.1') return { ok: true, url };
    return { ok: false, reason: 'http is allowed only for 127.0.0.1 under the fixture opt-in' };
  }
  return { ok: false, reason: 'unsupported endpoint protocol' };
}

function parseRetryAfterMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

function configFailure(code: WireFailureCode, message: string): WireOutcome {
  return {
    ok: false,
    error: { kind: 'config_error', code, message, retryable: false, requestSent: false },
  };
}

/**
 * One POST, no retries, no redirects. Never throws and never rejects.
 * A 2xx with a completely received body is returned as text without being
 * parsed: whether that text is valid JSON is a decode question, not a
 * transport question. A body cut short is always a transport_error.
 */
export function postChatCompletion(options: PostChatCompletionOptions): Promise<WireOutcome> {
  const key = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
  if (key.length === 0) {
    return Promise.resolve(configFailure('missing_api_key', 'API key is missing or empty; nothing was sent'));
  }
  const checked = checkEndpoint(options.endpoint, options.allowLoopbackHttp === true);
  if (!checked.ok) {
    return Promise.resolve(configFailure('invalid_endpoint', redactKey(checked.reason, key)));
  }
  let payload: string;
  try {
    const serialized: unknown = JSON.stringify(options.body);
    if (typeof serialized !== 'string') throw new Error('not serializable');
    payload = serialized;
  } catch {
    return Promise.resolve(configFailure('unserializable_request', 'request body could not be serialized'));
  }
  if (!(options.deadlineMs > 0)) {
    return Promise.resolve({
      ok: false,
      error: {
        kind: 'transport_error',
        code: 'deadline_exceeded',
        message: 'no time left before the deadline; nothing was sent',
        retryable: false,
        requestSent: false,
      },
    });
  }

  const url = checked.url;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const started = performance.now();

  return new Promise<WireOutcome>((resolve) => {
    let settled = false;
    let connected = false;
    let responseStarted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: WireOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(outcome);
    };

    const fail = (
      code: WireFailureCode,
      message: string,
      extra: { retryable?: boolean; status?: number; retryAfterMs?: number } = {},
    ): void => {
      if (settled) return;
      const error: WireFailure = {
        kind: 'transport_error',
        code,
        message: redactKey(message, key),
        retryable: extra.retryable === true,
        requestSent: connected,
      };
      if (extra.status !== undefined) error.status = extra.status;
      if (extra.retryAfterMs !== undefined) error.retryAfterMs = extra.retryAfterMs;
      finish({ ok: false, error });
      req.destroy();
    };

    const requestOptions: http.RequestOptions = {
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer ' + key,
        'content-length': Buffer.byteLength(payload),
      },
    };

    const onResponse = (res: http.IncomingMessage): void => {
      responseStarted = true;
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        fail('redirect_refused', 'redirect (HTTP ' + String(status) + ') refused', { status });
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          fail('response_too_large', 'response exceeded ' + String(maxBytes) + ' bytes', { status });
          return;
        }
        chunks.push(chunk);
      });
      const truncated = (): void => {
        fail('truncated_body', 'response body ended before it was complete', { status });
      };
      res.on('error', truncated);
      res.on('aborted', truncated);
      res.on('close', () => {
        if (!res.complete) truncated();
      });
      res.on('end', () => {
        if (!res.complete) {
          truncated();
          return;
        }
        const bodyText = Buffer.concat(chunks).toString('utf8');
        if (status >= 200 && status < 300) {
          finish({ ok: true, status, bodyText });
          return;
        }
        const snippet = bodyText.slice(0, MAX_ERROR_BODY_CHARS);
        if (status === 429) {
          const retryAfterMs = parseRetryAfterMs(res.headers['retry-after']);
          const remaining = options.deadlineMs - (performance.now() - started);
          const fits = retryAfterMs === undefined ? remaining > 0 : retryAfterMs <= remaining;
          const extra: { retryable: boolean; status: number; retryAfterMs?: number } = { retryable: fits, status };
          if (retryAfterMs !== undefined) extra.retryAfterMs = retryAfterMs;
          fail('rate_limited', 'HTTP 429: ' + snippet, extra);
          return;
        }
        // Post-send 5xx is never retried: the provider may have processed the request.
        fail(status >= 500 ? 'http_5xx' : 'http_4xx', 'HTTP ' + String(status) + ': ' + snippet, { status });
      });
    };

    const req: http.ClientRequest =
      url.protocol === 'https:'
        ? https.request(url, requestOptions, onResponse)
        : http.request(url, requestOptions, onResponse);

    req.on('socket', (socket) => {
      if (socket.connecting) {
        socket.once('connect', () => {
          connected = true;
        });
      } else {
        connected = true;
      }
    });

    req.on('error', (err: Error) => {
      if (responseStarted) {
        fail('truncated_body', 'response body ended before it was complete');
      } else if (connected) {
        fail('connection_error', 'connection failed after the request was sent: ' + err.message);
      } else {
        fail('connect_failed', 'could not connect: ' + err.message, { retryable: true });
      }
    });

    // Node's own timeout option only emits an event; this timer enforces the total deadline.
    timer = setTimeout(() => {
      fail('deadline_exceeded', 'deadline of ' + String(options.deadlineMs) + ' ms exceeded');
    }, options.deadlineMs);

    req.end(payload);
  });
}

export interface WireUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export type WireExtraction =
  | { kind: 'reject'; reason: string; usage: WireUsage | null }
  | {
      kind: 'tool_call';
      providerToolCallId: string;
      name: string;
      argumentsText: string;
      /** Content sent alongside tool_calls. Untrusted data, never an instruction. */
      untrustedContent: string | null;
      assistantMessage: Record<string, unknown>;
      usage: WireUsage | null;
    }
  | { kind: 'final'; content: string; assistantMessage: Record<string, unknown>; usage: WireUsage | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractUsage(root: Record<string, unknown>): WireUsage | null {
  const usage = root['usage'];
  if (!isRecord(usage)) return null;
  const p = usage['prompt_tokens'];
  const c = usage['completion_tokens'];
  if (typeof p !== 'number' || typeof c !== 'number') return null;
  if (!Number.isFinite(p) || !Number.isFinite(c) || p < 0 || c < 0) return null;
  return { prompt_tokens: p, completion_tokens: c };
}

/**
 * Pull the wire fields out of a COMPLETE response body. Never throws.
 * Accepts finish_reason stop or tool_calls only and exactly one tool_calls
 * entry. Usage is null when the provider did not report it (unknown, not zero).
 * Tool arguments are returned as text and are not parsed here.
 */
export function extractChatCompletion(bodyText: string): WireExtraction {
  let root: unknown;
  try {
    root = JSON.parse(bodyText);
  } catch {
    return { kind: 'reject', reason: 'malformed_json', usage: null };
  }
  if (!isRecord(root)) return { kind: 'reject', reason: 'envelope_not_object', usage: null };
  const usage = extractUsage(root);
  const reject = (reason: string): WireExtraction => ({ kind: 'reject', reason, usage });

  const choices = root['choices'];
  if (!Array.isArray(choices) || choices.length !== 1) return reject('expected_exactly_one_choice');
  const choice: unknown = choices[0];
  if (!isRecord(choice)) return reject('choice_not_object');
  const finish = choice['finish_reason'];
  if (finish !== 'stop' && finish !== 'tool_calls') return reject('invalid_finish_reason');
  const message = choice['message'];
  if (!isRecord(message)) return reject('message_not_object');
  const content = message['content'];
  const toolCalls = message['tool_calls'];
  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;

  if (finish === 'tool_calls') {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return reject('missing_tool_calls');
    if (toolCalls.length !== 1) return reject('multi_action');
    const call: unknown = toolCalls[0];
    if (!isRecord(call)) return reject('tool_call_not_object');
    const id = call['id'];
    const fn = call['function'];
    if (typeof id !== 'string' || id.length === 0) return reject('tool_call_missing_id');
    if (!isRecord(fn)) return reject('tool_call_missing_function');
    const name = fn['name'];
    const args = fn['arguments'];
    if (typeof name !== 'string' || name.length === 0) return reject('tool_call_missing_name');
    if (typeof args !== 'string') return reject('tool_call_arguments_not_string');
    return {
      kind: 'tool_call',
      providerToolCallId: id,
      name,
      argumentsText: args,
      untrustedContent: typeof content === 'string' && content.length > 0 ? content : null,
      assistantMessage: message,
      usage,
    };
  }

  if (hasToolCalls) return reject('tool_calls_with_finish_reason_stop');
  if (typeof content !== 'string') return reject('final_content_not_string');
  return { kind: 'final', content, assistantMessage: message, usage };
}

/** Mint a runtime-owned call id. Provider ids are never used as call ids. */
export function mintRuntimeCallId(): string {
  return 'rt_call_' + randomUUID();
}

/**
 * Runtime-owned link between provider tool_call ids and runtime call_ids.
 * A provider id is only a wire label for transcript replay: it is never a
 * call_id, a session handle, or execution authority.
 */
export class ProviderCallIdMap {
  private readonly byProvider = new Map<string, string>();
  private readonly byRuntime = new Map<string, string>();

  link(providerToolCallId: string, runtimeCallId: string): void {
    if (providerToolCallId === runtimeCallId) {
      throw new Error('a provider tool_call id must not be used as a runtime call_id');
    }
    if (this.byProvider.has(providerToolCallId) || this.byRuntime.has(runtimeCallId)) {
      throw new Error('tool call id is already linked');
    }
    this.byProvider.set(providerToolCallId, runtimeCallId);
    this.byRuntime.set(runtimeCallId, providerToolCallId);
  }

  runtimeCallIdFor(providerToolCallId: string): string | undefined {
    return this.byProvider.get(providerToolCallId);
  }

  providerIdFor(runtimeCallId: string): string | undefined {
    return this.byRuntime.get(runtimeCallId);
  }
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/**
 * Rebuild a prior assistant message for stateless replay. tool_calls and
 * reasoning_details are copied unchanged as opaque protocol data: no trimming,
 * no reordering, no id rewriting. Absent fields stay absent.
 */
export function replayAssistantMessage(assistantMessage: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { role: 'assistant' };
  const content = assistantMessage['content'];
  out['content'] = typeof content === 'string' ? content : null;
  if ('tool_calls' in assistantMessage && assistantMessage['tool_calls'] !== undefined) {
    out['tool_calls'] = cloneJson(assistantMessage['tool_calls']);
  }
  if ('reasoning_details' in assistantMessage && assistantMessage['reasoning_details'] !== undefined) {
    out['reasoning_details'] = cloneJson(assistantMessage['reasoning_details']);
  }
  return out;
}

/** Build the tool message for a result. The wire tool_call_id is the provider id looked up from the runtime call_id. */
export function replayToolMessage(
  ids: ProviderCallIdMap,
  runtimeCallId: string,
  content: string,
): { role: 'tool'; tool_call_id: string; content: string } {
  const providerId = ids.providerIdFor(runtimeCallId);
  if (providerId === undefined) {
    throw new Error('no provider tool_call id is linked to this runtime call_id');
  }
  return { role: 'tool', tool_call_id: providerId, content };
}
