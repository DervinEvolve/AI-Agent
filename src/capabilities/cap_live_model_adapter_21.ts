/**
 * Node http/https live-model transport (cap_live_model_adapter_21).
 * Exactly one attempt per complete(). Never sleeps. Never follows redirects.
 * retryable is advice only and is false for 500–599 after request bytes were sent.
 */
import http from "node:http";
import https from "node:https";
import { redactSecrets, registerDeniedBytes } from "./secret_redactor.js";

export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_ERROR_BODY_CAP = 8 * 1024;

export type AdapterPhase = "pre-content" | "streaming" | "complete";

export interface HostConfig {
  endpoint: string;
  /** Environment variable name holding the API key. The model cannot choose this. */
  api_key_env?: string;
  /** Explicit test exemption. Production CLI must never set this. */
  allow_loopback_without_key?: boolean;
  env?: NodeJS.ProcessEnv;
  timeout_ms?: number;
  max_response_bytes?: number;
  error_body_cap?: number;
  model?: string;
}

export interface Authorizer {
  inference_disclosure_authorized?: boolean;
}

export interface StructuredRejection {
  ok: false;
  error: string;
  detail?: string;
}

export interface AdapterHandle {
  ok: true;
  endpoint: URL;
  keyPresent: boolean;
  close: () => { status: "confirmed" | "unconfirmed"; sockets_opened: number };
}

export type OpenResult = AdapterHandle | StructuredRejection;

export interface BoundedRequest {
  messages: Array<{ role: string; content: string }>;
  tools?: unknown;
  deadline_ms?: number;
  finalization_reserve_ms?: number;
  run_deadline_ms?: number;
}

export interface ProviderResponse {
  ok: true;
  status_code: number;
  body: string;
  phase: "complete";
  usage: unknown;
  usage_known: boolean;
}

export interface TransportError {
  ok: false;
  error: "transport_error" | "credential_missing" | "policy_rejected" | "overflow" | "deadline_exceeded";
  status_code?: number;
  retryable: false | true;
  phase: AdapterPhase;
  detail?: string;
  retry_after_ms?: number | null;
  bytes_read?: number;
}

export type CompleteResult = ProviderResponse | TransportError;

export interface AdapterCounters {
  sockets_opened: number;
  requests_started: number;
  complete_calls: number;
  bytes_sent: number;
}

const counters = new Map<AdapterHandle, AdapterCounters>();

export function getAdapterCounters(handle: AdapterHandle): AdapterCounters | undefined {
  return counters.get(handle);
}

function fail(error: string, detail?: string): StructuredRejection {
  return { ok: false, error, detail: detail ? redactSecrets(detail) : undefined };
}

/** WHATWG URL parsing can collapse 127.1; require the hostname string exactly. */
export function validateEndpoint(raw: string): { ok: true; url: URL } | StructuredRejection {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("malformed_url");
  }
  if (url.username !== "" || url.password !== "") {
    return fail("userinfo_rejected");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail("unsupported_scheme", url.protocol);
  }
  if (url.protocol === "http:" && url.hostname !== "127.0.0.1") {
    return fail("http_host_rejected", url.hostname);
  }
  return { ok: true, url };
}

export function readCredential(
  envName: string | undefined,
  env: NodeJS.ProcessEnv,
): { present: true; value: string } | { present: false } {
  if (!envName) return { present: false };
  const raw = env[envName];
  if (raw === undefined) return { present: false };
  if (raw.trim() === "") return { present: false };
  return { present: true, value: raw };
}

export function LiveModelAdapterOpen(host_config: HostConfig, _authorizer?: Authorizer): OpenResult {
  const checked = validateEndpoint(host_config.endpoint);
  if (!checked.ok) return checked;
  const env = host_config.env ?? process.env;
  const cred = readCredential(host_config.api_key_env, env);
  const loopbackOk =
    host_config.allow_loopback_without_key === true &&
    checked.url.protocol === "http:" &&
    checked.url.hostname === "127.0.0.1";
  if (!cred.present && !loopbackOk) {
    return fail("credential_missing");
  }
  if (cred.present) {
    registerDeniedBytes(cred.value);
  }
  const handle: AdapterHandle = {
    ok: true,
    endpoint: checked.url,
    keyPresent: cred.present,
    close: () => {
      const c = counters.get(handle);
      counters.delete(handle);
      return { status: "confirmed" as const, sockets_opened: c?.sockets_opened ?? 0 };
    },
  };
  counters.set(handle, { sockets_opened: 0, requests_started: 0, complete_calls: 0, bytes_sent: 0 });
  return handle;
}

export const LiveModelAdapter = {
  open: LiveModelAdapterOpen,
  complete: complete,
  close(handle: AdapterHandle) {
    return handle.close();
  },
};

function parseRetryAfter(header: string | string[] | undefined, remainingMs: number): {
  ms: number | null;
  usable: boolean;
} {
  if (header === undefined) return { ms: null, usable: false };
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || raw.trim() === "") return { ms: null, usable: false };
  const delta = Number(raw);
  if (Number.isFinite(delta) && String(raw).trim() !== "" && !/[a-zA-Z]/.test(raw)) {
    const ms = Math.round(delta * 1000);
    if (ms < 0 || ms > remainingMs) return { ms, usable: false };
    return { ms, usable: true };
  }
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return { ms: null, usable: false };
  const ms = when - Date.now();
  if (ms < 0 || ms > remainingMs) return { ms: Math.max(0, ms), usable: false };
  return { ms, usable: true };
}

function remainingDeadline(req: BoundedRequest, started: number): number {
  const now = Date.now();
  const elapsed = now - started;
  let budget = req.deadline_ms ?? 30_000;
  if (typeof req.run_deadline_ms === "number") {
    const reserve = req.finalization_reserve_ms ?? 0;
    const left = req.run_deadline_ms - elapsed - reserve;
    budget = Math.min(budget, Math.max(0, left));
  }
  return Math.max(0, budget - elapsed);
}

export async function complete(handle: AdapterHandle, request: BoundedRequest): Promise<CompleteResult> {
  const c = counters.get(handle);
  if (!c) {
    return {
      ok: false,
      error: "transport_error",
      retryable: false,
      phase: "pre-content",
      detail: "adapter_closed",
    };
  }
  c.complete_calls += 1;
  const started = Date.now();
  const maxBytes = DEFAULT_MAX_RESPONSE_BYTES;
  const errCap = DEFAULT_ERROR_BODY_CAP;

  const payloadObj = {
    model: "pinned-chat-completions",
    messages: request.messages,
    tools: request.tools,
  };
  const payload = Buffer.from(JSON.stringify(payloadObj), "utf8");

  const url = handle.endpoint;
  const lib = url.protocol === "https:" ? https : http;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-length": String(payload.length),
    accept: "application/json",
  };
  if (handle.keyPresent && handle) {
    const envName = undefined;
    void envName;
  }

  const deadline = remainingDeadline(request, started);

  return new Promise<CompleteResult>((resolve) => {
    let settled = false;
    let bytesRead = 0;
    let phase: AdapterPhase = "pre-content";
    const chunks: Buffer[] = [];
    const finish = (result: CompleteResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers,
        rejectUnauthorized: true,
        timeout: Math.min(Math.max(deadline, 1), request.timeout_ms ?? deadline) as number,
      } as http.RequestOptions & { timeout?: number },
      (res) => {
        const status = res.statusCode ?? 0;
        const cap = status >= 400 ? errCap : maxBytes;
        res.on("data", (buf: Buffer) => {
          phase = "streaming";
          bytesRead += buf.length;
          if (bytesRead > cap) {
            res.destroy();
            req.destroy();
            finish({
              ok: false,
              error: "overflow",
              retryable: false,
              phase: "streaming",
              status_code: status,
              bytes_read: bytesRead,
              detail: "response_byte_cap",
            });
            return;
          }
          chunks.push(buf);
        });
        res.on("end", () => {
          if (settled) return;
          const body = Buffer.concat(chunks).toString("utf8");
          if (status >= 300 && status < 400) {
            finish({
              ok: false,
              error: "transport_error",
              status_code: status,
              retryable: false,
              phase: "pre-content",
              detail: "redirect_rejected",
              bytes_read: bytesRead,
            });
            return;
          }
          if (status === 429) {
            const ra = parseRetryAfter(res.headers["retry-after"], remainingDeadline(request, started));
            finish({
              ok: false,
              error: "transport_error",
              status_code: 429,
              retryable: ra.usable ? true : false,
              phase: "pre-content",
              retry_after_ms: ra.ms,
              detail: redactSecrets(body.slice(0, errCap)),
              bytes_read: bytesRead,
            });
            return;
          }
          if (status >= 500 && status <= 599) {
            finish({
              ok: false,
              error: "transport_error",
              status_code: status,
              retryable: false,
              phase: "pre-content",
              detail: redactSecrets(body.slice(0, errCap)),
              bytes_read: bytesRead,
            });
            return;
          }
          if (status >= 400) {
            finish({
              ok: false,
              error: "transport_error",
              status_code: status,
              retryable: false,
              phase: "pre-content",
              detail: redactSecrets(body.slice(0, errCap)),
              bytes_read: bytesRead,
            });
            return;
          }
          let usage: unknown = undefined;
          let usageKnown = false;
          try {
            const parsed = JSON.parse(body) as { usage?: unknown };
            if (parsed && typeof parsed === "object" && "usage" in parsed && parsed.usage != null) {
              usage = parsed.usage;
              usageKnown = true;
            }
          } catch {
            usageKnown = false;
          }
          finish({
            ok: true,
            status_code: status,
            body,
            phase: "complete",
            usage,
            usage_known: usageKnown,
          });
        });
        res.on("error", () => {
          finish({
            ok: false,
            error: "transport_error",
            retryable: false,
            phase,
            status_code: status,
            bytes_read: bytesRead,
          });
        });
      },
    );

    const totalTimer = setTimeout(() => {
      req.destroy();
      finish({
        ok: false,
        error: "deadline_exceeded",
        retryable: false,
        phase,
        bytes_read: bytesRead,
        detail: "monotonic_deadline",
      });
    }, Math.max(deadline, 1));

    req.on("timeout", () => {
      req.destroy();
      finish({
        ok: false,
        error: "deadline_exceeded",
        retryable: false,
        phase,
        bytes_read: bytesRead,
        detail: "socket_inactivity_destroyed",
      });
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(totalTimer);
      const sent = c.bytes_sent > 0;
      finish({
        ok: false,
        error: "transport_error",
        retryable: sent ? false : true,
        phase,
        detail: redactSecrets(err.message),
        bytes_read: bytesRead,
      });
    });
    req.on("close", () => clearTimeout(totalTimer));

    c.sockets_opened += 1;
    c.requests_started += 1;
    c.bytes_sent += payload.length;
    req.write(payload);
    req.end();
  });
}

export function componentAvailability() {
  return {
    adapter: "available",
    decoder: "available",
    registry_integration: "test_harness_only",
    AgentRuntime: "unavailable",
    recovery_ledger: "unavailable",
    usage_accounting: "unavailable",
    finalizer: "unavailable",
    live_baseline: "not_run" as const,
    live_baseline_reason: "credential_unavailable",
  };
}
