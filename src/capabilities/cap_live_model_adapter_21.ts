import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FinishReason = 'stop' | 'tool_calls';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ToolCall[];
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface UsageCap {
  type: 'token' | 'byte' | 'monetary';
  limit: number;
}

export interface BoundedRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  max_tokens?: number;
  temperature?: number;
  deadline_ms: number;
  max_attempts?: number;
  usage_cap?: UsageCap;
  run_id?: string;
}

export interface ProviderResponse {
  finish: FinishReason;
  content?: string;
  tool_calls?: ToolCall[];
  untrusted_content?: string;
  usage?: Usage;
  raw?: unknown;
}

export interface TransportError {
  error: 'transport_error';
  status_code?: number;
  retryable: boolean;
  phase: 'pre-content' | 'post-content';
  message: string;
  retry_after_ms?: number;
  body?: string;
  usage?: Usage;
}

export interface ModelAdapter {
  complete(request: BoundedRequest): Promise<ProviderResponse | TransportError>;
}

export interface ToolResult {
  call_id: string;
  outcome: 'known' | 'unknown';
  result?: unknown;
}

export interface RunReport {
  run_id: string;
  status: 'completed' | 'halted' | 'error';
  final_answer?: string;
  tool_results: ToolResult[];
  journal: string[];
  diagnostics: string[];
  usage: Usage;
  latency_ms: number;
}

export interface HostConfig {
  base_url: string;
  model: string;
  api_key_env?: string;
  timeout_ms?: number;
  max_response_bytes?: number;
  finalization_reserve_ms?: number;
}

export interface Authorizer {
  getKey(): string | undefined;
}

export interface RuntimeConfig {
  tools?: ToolDefinition[];
  deadline_ms?: number;
  finalization_reserve_ms?: number;
}

// ---------------------------------------------------------------------------
// Usage ledger
// ---------------------------------------------------------------------------

export interface UsageRecord {
  attempt: number;
  usage?: Usage;
  latency_ms: number;
  run_id?: string;
}

export class UsageLedger {
  private records: UsageRecord[] = [];
  private cap?: UsageCap;

  setCap(cap: UsageCap): void {
    this.cap = cap;
  }

  hasActiveCap(): boolean {
    return this.cap !== undefined;
  }

  record(attempt: number, usage: Usage | undefined, latency_ms: number, run_id?: string): void {
    this.records.push({ attempt, usage, latency_ms, run_id });
  }

  getTotalUsage(): Usage {
    const total: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    for (const r of this.records) {
      if (r.usage) {
        total.prompt_tokens += r.usage.prompt_tokens;
        total.completion_tokens += r.usage.completion_tokens;
        total.total_tokens += r.usage.total_tokens;
      }
    }
    return total;
  }

  wouldExceed(usage: Usage): boolean {
    if (!this.cap) return false;
    const total = this.getTotalUsage();
    const next = {
      prompt_tokens: total.prompt_tokens + usage.prompt_tokens,
      completion_tokens: total.completion_tokens + usage.completion_tokens,
      total_tokens: total.total_tokens + usage.total_tokens,
    };
    switch (this.cap.type) {
      case 'token':
        return next.total_tokens > this.cap.limit;
      case 'byte':
        // approximate: tokens * 4 bytes
        return next.total_tokens * 4 > this.cap.limit;
      case 'monetary':
        // no pricing table; treat as token cap for safety
        return next.total_tokens > this.cap.limit;
      default:
        return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();

  register(name: string, handler: (args: Record<string, unknown>) => Promise<unknown>): void {
    this.handlers.set(name, handler);
  }

  async dispatch(call: ToolCall): Promise<ToolResult> {
    const handler = this.handlers.get(call.function.name);
    if (!handler) {
      return { call_id: call.id, outcome: 'unknown' };
    }
    try {
      const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      const result = await handler(args);
      return { call_id: call.id, outcome: 'known', result };
    } catch {
      return { call_id: call.id, outcome: 'unknown' };
    }
  }
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

class BodyReadError extends Error {
  bytes: number;
  constructor(message: string, bytes: number) {
    super(message);
    this.bytes = bytes;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  if (!value) return undefined;
  const v = Array.isArray(value) ? value[0] : value;
  if (!v) return undefined;
  const seconds = Number(v);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(v);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function readBody(
  res: http.IncomingMessage,
  maxBytes: number,
  deadline: number
): Promise<{ body: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        res.destroy();
        reject(new BodyReadError('deadline exceeded while reading response', bytes));
      }
    }, Math.max(0, deadline - Date.now()));

    res.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        settled = true;
        clearTimeout(timeout);
        res.destroy();
        reject(new BodyReadError('response body exceeds maximum size', bytes));
        return;
      }
      chunks.push(chunk);
    });

    res.on('end', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ body: Buffer.concat(chunks).toString('utf8'), bytes });
      }
    });

    res.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new BodyReadError(err.message, bytes));
      }
    });
  });
}

interface RequestOutcome {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  bytes: number;
  error?: Error;
  phase: 'pre-content' | 'post-content';
}

function performRequest(
  url: URL,
  headers: Record<string, string>,
  body: string,
  deadline: number,
  maxBytes: number,
  timeoutMs: number
): Promise<RequestOutcome> {
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = lib.request(
      url,
      {
        method: 'POST',
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, headers: res.headers, body: '', bytes: 0, phase: 'pre-content' });
          return;
        }
        readBody(res, maxBytes, deadline)
          .then(({ body: responseBody, bytes }) => {
            resolve({ status, headers: res.headers, body: responseBody, bytes, phase: 'pre-content' });
          })
          .catch((err: BodyReadError) => {
            resolve({
              status,
              headers: res.headers,
              body: '',
              bytes: err.bytes,
              error: err,
              phase: err.bytes > 0 ? 'post-content' : 'pre-content',
            });
          });
      }
    );

    req.on('error', (err) => {
      resolve({ status: 0, headers: {}, body: '', bytes: 0, error: err, phase: 'pre-content' });
    });

    req.on('timeout', () => {
      req.destroy(new Error('socket timeout'));
    });

    req.write(body);
    req.end();
  });
}

function parseUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const prompt = u.prompt_tokens;
  const completion = u.completion_tokens;
  const total = u.total_tokens;
  if (
    typeof prompt === 'number' &&
    typeof completion === 'number' &&
    typeof total === 'number'
  ) {
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
  }
  return undefined;
}

function isTransportError(x: ProviderResponse | TransportError): x is TransportError {
  return (x as TransportError).error === 'transport_error';
}

function transportError(
  message: string,
  status_code: number | undefined,
  retryable: boolean,
  phase: 'pre-content' | 'post-content',
  body?: string,
  retry_after_ms?: number,
  usage?: Usage
): TransportError {
  return {
    error: 'transport_error',
    status_code,
    retryable,
    phase,
    message,
    body: body ? body.slice(0, 500) : undefined,
    retry_after_ms,
    usage,
  };
}

function decodeProviderResponse(body: string, status: number): ProviderResponse | TransportError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return transportError('malformed JSON response', status, false, 'pre-content', body);
  }

  if (!parsed || typeof parsed !== 'object') {
    return transportError('response is not an object', status, false, 'pre-content', body);
  }

  const obj = parsed as Record<string, unknown>;
  const choices = obj.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return transportError('missing choices array', status, false, 'pre-content', body);
  }

  const choice = choices[0] as Record<string, unknown>;
  const finish_reason = choice.finish_reason;
  if (finish_reason !== 'stop' && finish_reason !== 'tool_calls') {
    return transportError(`invalid finish_reason: ${String(finish_reason)}`, status, false, 'pre-content', body);
  }

  const message = choice.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== 'object') {
    return transportError('missing message object', status, false, 'pre-content', body);
  }

  const content = typeof message.content === 'string' ? message.content : undefined;
  const tool_calls_raw = message.tool_calls;
  const usage = parseUsage(obj.usage);

  if (finish_reason === 'tool_calls') {
    if (!Array.isArray(tool_calls_raw) || tool_calls_raw.length !== 1) {
      return transportError('tool_calls finish requires exactly one tool_call entry', status, false, 'pre-content', body);
    }
    const call = tool_calls_raw[0] as Record<string, unknown>;
    if (
      !call ||
      typeof call.id !== 'string' ||
      call.type !== 'function' ||
      !call.function ||
      typeof (call.function as Record<string, unknown>).name !== 'string' ||
      typeof (call.function as Record<string, unknown>).arguments !== 'string'
    ) {
      return transportError('malformed tool_call entry', status, false, 'pre-content', body);
    }
    const toolCall: ToolCall = {
      id: call.id,
      type: 'function',
      function: {
        name: (call.function as Record<string, unknown>).name as string,
        arguments: (call.function as Record<string, unknown>).arguments as string,
      },
    };
    if (content !== undefined && content !== '') {
      return {
        finish: 'tool_calls',
        tool_calls: [toolCall],
        untrusted_content: content,
        usage,
        raw: parsed,
      };
    }
    return { finish: 'tool_calls', tool_calls: [toolCall], usage, raw: parsed };
  }

  // finish_reason === 'stop'
  if (tool_calls_raw !== undefined) {
    return transportError('stop finish must not include tool_calls', status, false, 'pre-content', body);
  }
  if (content === undefined) {
    return transportError('stop finish missing content', status, false, 'pre-content', body);
  }
  return { finish: 'stop', content, usage, raw: parsed };
}

// ---------------------------------------------------------------------------
// LiveModelAdapter
// ---------------------------------------------------------------------------

export class LiveModelAdapter implements ModelAdapter {
  constructor(
    private readonly config: HostConfig,
    private readonly authorizer?: Authorizer,
    private readonly ledger: UsageLedger = new UsageLedger()
  ) {}

  async complete(request: BoundedRequest): Promise<ProviderResponse | TransportError> {
    const start = Date.now();
    const maxAttempts = request.max_attempts ?? 1;
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt++;
      const result = await this.transportAttempt(request, attempt);

      if (!isTransportError(result)) {
        this.ledger.record(attempt, result.usage, Date.now() - start, request.run_id);
        if (result.usage === undefined && this.ledger.hasActiveCap()) {
          return transportError(
            'missing usage under active cap; halting',
            undefined,
            false,
            'pre-content'
          );
        }
        return result;
      }

      const err = result as TransportError;
      this.ledger.record(attempt, err.usage, Date.now() - start, request.run_id);

      if (!err.retryable || attempt >= maxAttempts) {
        return err;
      }

      if (this.ledger.hasActiveCap() && err.usage && this.ledger.wouldExceed(err.usage)) {
        return transportError(
          'usage cap would be exceeded; halting',
          err.status_code,
          false,
          err.phase,
          err.body,
          err.retry_after_ms,
          err.usage
        );
      }

      if (err.retry_after_ms && Date.now() + err.retry_after_ms > Date.now() + request.deadline_ms) {
        return transportError(
          'Retry-After beyond run deadline; reported not awaited',
          err.status_code,
          false,
          err.phase,
          err.body,
          err.retry_after_ms,
          err.usage
        );
      }

      if (err.retry_after_ms) {
        await sleep(Math.min(err.retry_after_ms, 1000));
      }
    }

    return transportError('max attempts exhausted', undefined, false, 'pre-content');
  }

  private async transportAttempt(
    request: BoundedRequest,
    attempt: number
  ): Promise<ProviderResponse | TransportError> {
    let url: URL;
    try {
      url = new URL(this.config.base_url);
    } catch {
      return transportError('invalid base_url', undefined, false, 'pre-content');
    }

    if (url.username || url.password) {
      return transportError('userinfo in URL is not allowed', undefined, false, 'pre-content');
    }

    if (url.protocol === 'http:') {
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
        return transportError('http is only allowed for 127.0.0.1 fixtures', undefined, false, 'pre-content');
      }
    } else if (url.protocol !== 'https:') {
      return transportError('unsupported protocol', undefined, false, 'pre-content');
    }

    const finalizationReserve = this.config.finalization_reserve_ms ?? 1000;
    const deadline = Date.now() + request.deadline_ms - finalizationReserve;
    if (deadline <= Date.now()) {
      return transportError('deadline already exceeded', undefined, false, 'pre-content');
    }

    const payload: Record<string, unknown> = {
      model: this.config.model,
      messages: request.messages,
    };
    if (request.tools && request.tools.length > 0) payload.tools = request.tools;
    if (request.max_tokens !== undefined) payload.max_tokens = request.max_tokens;
    if (request.temperature !== undefined) payload.temperature = request.temperature;

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
    };

    const apiKey = this.authorizer?.getKey() ?? process.env[this.config.api_key_env ?? 'LIVE_MODEL_API_KEY'];
    if (apiKey) {
      headers['authorization'] = `Bearer ${apiKey}`;
    }

    const outcome = await performRequest(
      url,
      headers,
      body,
      deadline,
      this.config.max_response_bytes ?? 4 * 1024 * 1024,
      this.config.timeout_ms ?? 30000
    );

    if (outcome.error) {
      return transportError(
        outcome.error.message,
        outcome.status || undefined,
        outcome.phase === 'pre-content',
        outcome.phase,
        outcome.body
      );
    }

    if (outcome.status >= 300 && outcome.status < 400) {
      return transportError('redirect not allowed', outcome.status, false, 'pre-content');
    }

    if (outcome.status === 429 || outcome.status >= 500) {
      const retry_after_ms = parseRetryAfter(outcome.headers['retry-after']);
      return transportError(
        `HTTP ${outcome.status}`,
        outcome.status,
        true,
        'pre-content',
        outcome.body,
        retry_after_ms
      );
    }

    if (outcome.status !== 200) {
      return transportError(
        `unexpected status ${outcome.status}`,
        outcome.status,
        false,
        'pre-content',
        outcome.body
      );
    }

    return decodeProviderResponse(outcome.body, outcome.status);
  }
}

// ---------------------------------------------------------------------------
// AgentRuntime (minimal loop for this capability; no second ActionDecoder)
// ---------------------------------------------------------------------------

export class AgentRuntime {
  constructor(
    private readonly adapter: ModelAdapter,
    private readonly tools: ToolRegistry,
    private readonly config: RuntimeConfig = {}
  ) {}

  async run(
    task: string,
    options: { max_turns?: number; usage_cap?: UsageCap } = {}
  ): Promise<RunReport> {
    const run_id = randomUUID();
    const journal: string[] = [];
    const diagnostics: string[] = [];
    const tool_results: ToolResult[] = [];
    const start = Date.now();
    const max_turns = options.max_turns ?? 1;
    const usage_cap = options.usage_cap;
    const ledger = (this.adapter as LiveModelAdapter).ledger;
    if (ledger && usage_cap) {
      ledger.setCap(usage_cap);
    }

    let messages: ChatMessage[] = [{ role: 'user', content: task }];
    let final_answer: string | undefined;
    let status: 'completed' | 'halted' | 'error' = 'error';

    for (let turn = 0; turn < max_turns; turn++) {
      const deadline_ms = this.config.deadline_ms ?? 30000;
      const request: BoundedRequest = {
        messages,
        tools: this.config.tools,
        deadline_ms,
        max_attempts: 1,
        usage_cap,
        run_id,
      };

      const result = await this.adapter.complete(request);

      if (isTransportError(result)) {
        diagnostics.push(`transport error: ${result.message}`);
        status = 'error';
        break;
      }

      const resp = result as ProviderResponse;

      if (resp.finish === 'stop') {
        if (resp.content !== undefined) {
          final_answer = resp.content;
          status = 'completed';
        } else {
          diagnostics.push('final answer missing content');
          status = 'error';
        }
        break;
      }

      if (resp.finish === 'tool_calls') {
        if (!resp.tool_calls || resp.tool_calls.length !== 1) {
          diagnostics.push('invalid tool_calls count');
          status = 'error';
          break;
        }
        const call = resp.tool_calls[0];
        const toolResult = await this.tools.dispatch(call);
        tool_results.push(toolResult);
        journal.push(
          `dispatched tool ${call.function.name} call_id=${call.id} outcome=${toolResult.outcome}`
        );
        messages.push({ role: 'assistant', content: '', tool_calls: [call] });
        messages.push({
          role: 'tool',
          content: JSON.stringify(toolResult.result ?? ''),
          tool_call_id: call.id,
        });
        // continue loop
      }
    }

    const usage = ledger ? ledger.getTotalUsage() : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    return {
      run_id,
      status,
      final_answer,
      tool_results,
      journal,
      diagnostics,
      usage,
      latency_ms: Date.now() - start,
    };
  }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out;
}
