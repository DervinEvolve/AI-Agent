import http from "node:http";
import { describe, it, expect, afterEach } from "vitest";
import { ToolRegistry } from "../../runtime/tool_registry.js";
import {
  LiveModelAdapter,
  validateEndpoint,
  readCredential,
  componentAvailability,
  DEFAULT_MAX_RESPONSE_BYTES,
} from "../cap_live_model_adapter_21.js";
import { decodeChatCompletion } from "../cap_action_decoder_19.js";
import { runCli } from "../cap_live_model_cli_21.js";
import { runBoundedHarness } from "../cap_live_model_harness_21.js";
import { registerDeniedBytes } from "../secret_redactor.js";

const servers: http.Server[] = [];

function listen(handler: http.RequestListener): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    handler(req, res);
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve({ url: `http://127.0.0.1:${addr.port}/v1/chat/completions`, hits: () => hits });
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.close(() => r());
        }),
    ),
  );
});

function envelope(message: unknown, finish = "stop", usage?: unknown) {
  return JSON.stringify({
    choices: [{ finish_reason: finish, message }],
    ...(usage !== undefined ? { usage } : {}),
  });
}

describe("cap_live_model_adapter_21", () => {
  it("rejects userinfo and non-127.0.0.1 http before any socket", () => {
    expect(validateEndpoint("http://user:pass@127.0.0.1/v1").ok).toBe(false);
    expect(validateEndpoint("http://127.1/v1").ok).toBe(false);
    expect(validateEndpoint("ftp://127.0.0.1/v1").ok).toBe(false);
    expect(validateEndpoint("http://127.0.0.1/v1").ok).toBe(true);
    const bad = LiveModelAdapter.open({ endpoint: "http://example.com/v1", allow_loopback_without_key: true });
    expect(bad.ok).toBe(false);
  });

  it("keyless loopback requires explicit fixture flag", () => {
    const denied = LiveModelAdapter.open({
      endpoint: "http://127.0.0.1:9/v1",
      api_key_env: "MISSING_KEY_XYZ",
      env: {},
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toBe("credential_missing");
    const allowed = LiveModelAdapter.open({
      endpoint: "http://127.0.0.1:9/v1",
      allow_loopback_without_key: true,
      env: {},
    });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) allowed.close();
  });

  it("HTTP 500 502 503 504 are transport_error retryable=false after one request", async () => {
    for (const status of [500, 502, 503, 504]) {
      const fx = await listen((_req, res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
      });
      const handle = LiveModelAdapter.open({
        endpoint: fx.url,
        allow_loopback_without_key: true,
      });
      expect(handle.ok).toBe(true);
      if (!handle.ok) continue;
      const result = await LiveModelAdapter.complete(handle, {
        messages: [{ role: "user", content: "hi" }],
        deadline_ms: 2000,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("transport_error");
        expect(result.status_code).toBe(status);
        expect(result.retryable).toBe(false);
        expect(result.phase).toBe("pre-content");
      }
      expect(fx.hits()).toBe(1);
      handle.close();
    }
  });

  it("does not follow redirects and does not retry 429", async () => {
    const fx = await listen((_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1/elsewhere" });
      res.end();
    });
    const handle = LiveModelAdapter.open({ endpoint: fx.url, allow_loopback_without_key: true });
    if (!handle.ok) throw new Error("open");
    const result = await LiveModelAdapter.complete(handle, {
      messages: [{ role: "user", content: "x" }],
      deadline_ms: 2000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.status_code).toBe(302);
    }
    expect(fx.hits()).toBe(1);
    handle.close();

    const fx2 = await listen((_req, res) => {
      res.writeHead(429, { "retry-after": "99999" });
      res.end("slow");
    });
    const h2 = LiveModelAdapter.open({ endpoint: fx2.url, allow_loopback_without_key: true });
    if (!h2.ok) throw new Error("open2");
    const r2 = await LiveModelAdapter.complete(h2, {
      messages: [{ role: "user", content: "x" }],
      deadline_ms: 1000,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.retryable).toBe(false);
    expect(fx2.hits()).toBe(1);
    h2.close();
  });

  it("overflow destroys the request and counts streamed bytes", async () => {
    const fx = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      for (let i = 0; i < 6; i++) res.write(chunk);
      res.end();
    });
    const handle = LiveModelAdapter.open({ endpoint: fx.url, allow_loopback_without_key: true });
    if (!handle.ok) throw new Error("open");
    const result = await LiveModelAdapter.complete(handle, {
      messages: [{ role: "user", content: "x" }],
      deadline_ms: 5000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("overflow");
      expect(result.retryable).toBe(false);
      expect((result.bytes_read ?? 0) > DEFAULT_MAX_RESPONSE_BYTES).toBe(true);
    }
    handle.close();
  });

  it("slow stream exceeding total deadline is destroyed", async () => {
    const fx = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
    });
    const handle = LiveModelAdapter.open({ endpoint: fx.url, allow_loopback_without_key: true });
    if (!handle.ok) throw new Error("open");
    const result = await LiveModelAdapter.complete(handle, {
      messages: [{ role: "user", content: "x" }],
      deadline_ms: 80,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("deadline_exceeded");
    handle.close();
  });

  it("redacts sentinel keys from error bodies", async () => {
    const sentinel = "sk-sentinel-LIVE-KEY-DO-NOT-LEAK";
    registerDeniedBytes(sentinel);
    const fx = await listen((_req, res) => {
      res.writeHead(500);
      res.end(`failed with ${sentinel}`);
    });
    const handle = LiveModelAdapter.open({
      endpoint: fx.url,
      allow_loopback_without_key: true,
    });
    if (!handle.ok) throw new Error("open");
    const result = await LiveModelAdapter.complete(handle, {
      messages: [{ role: "user", content: "x" }],
      deadline_ms: 2000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail ?? "").not.toContain(sentinel);
    }
    handle.close();
  });

  it("decoder rejects malformed, multi, unknown, schema, truncation, function_call", () => {
    const tools = [{ name: "echo", schema: { type: "object", required: ["text"], properties: { text: { type: "string" } }, additionalProperties: false } }];
    expect(decodeChatCompletion("{", tools).kind).toBe("reject");
    const multi = envelope({
      tool_calls: [
        { id: "p1", function: { name: "echo", arguments: "{\"text\":\"a\"}" } },
        { id: "p2", function: { name: "echo", arguments: "{\"text\":\"b\"}" } },
      ],
    }, "tool_calls");
    expect(decodeChatCompletion(multi, tools)).toMatchObject({ kind: "reject", reason: "multi_action" });
    const unknown = envelope({ tool_calls: [{ id: "prov", function: { name: "nope", arguments: "{}" } }] }, "tool_calls");
    expect(decodeChatCompletion(unknown, tools)).toMatchObject({ kind: "reject", reason: "unknown_tool" });
    const badArgs = envelope({ tool_calls: [{ id: "prov", function: { name: "echo", arguments: "{\"text\":1}" } }] }, "tool_calls");
    expect(decodeChatCompletion(badArgs, tools)).toMatchObject({ kind: "reject", reason: "schema_invalid" });
    expect(decodeChatCompletion(envelope({ content: "x" }, "length"), tools)).toMatchObject({ reason: "truncated" });
    expect(decodeChatCompletion(envelope({ content: "x" }, "function_call"), tools)).toMatchObject({ reason: "invalid_finish_reason" });
    const ok = decodeChatCompletion(
      envelope({ tool_calls: [{ id: "prov-id", function: { name: "echo", arguments: "{\"text\":\"hi\"}" } }] }, "tool_calls"),
      tools,
    );
    expect(ok.kind).toBe("tool_request");
    if (ok.kind === "tool_request") {
      expect(ok.provider_tool_call_id).toBe("prov-id");
      expect("call_id" in ok).toBe(false);
    }
  });

  it("harness dispatches once via imported registry then candidate final with zero more dispatches", async () => {
    let n = 0;
    const fx = await listen((_req, res) => {
      n += 1;
      res.writeHead(200, { "content-type": "application/json" });
      if (n === 1) {
        res.end(
          envelope(
            { tool_calls: [{ id: "provider-should-not-be-call-id", function: { name: "echo", arguments: "{\"text\":\"hi\"}" } }] },
            "tool_calls",
            { prompt_tokens: 1, completion_tokens: 1 },
          ),
        );
      } else {
        res.end(envelope({ content: "done" }, "stop", { prompt_tokens: 2, completion_tokens: 1 }));
      }
    });
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "echo",
      inputSchema: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string" } },
        additionalProperties: false,
      },
      handler: async (args) => ({ echoed: (args as { text: string }).text, call_id: "registry-call-1" }),
    });
    const handle = LiveModelAdapter.open({ endpoint: fx.url, allow_loopback_without_key: true });
    if (!handle.ok) throw new Error("open");
    const report = await runBoundedHarness(
      handle,
      registry,
      { messages: [{ role: "user", content: "hi" }], deadline_ms: 2000 },
      { max_turns: 4, max_consecutive_decode_rejects: 3, active_cap: false },
    );
    expect(report.dispatches).toBe(1);
    expect(report.final_answer_dispatches).toBe(0);
    expect(report.candidate_final_answer).toBe("done");
    expect(report.call_ids).toEqual(["registry-call-1"]);
    expect(report.call_ids).not.toContain("provider-should-not-be-call-id");
    expect(report.finalizer).toBe("unavailable");
    expect(report.verification).not.toBe("pass");
    handle.close();
  });

  it("stops after three decode rejects and does not complete again after unknown usage", async () => {
    let hits = 0;
    const fx = await listen((_req, res) => {
      hits += 1;
      res.writeHead(200);
      res.end("{");
    });
    const registry = new ToolRegistry();
    const handle = LiveModelAdapter.open({ endpoint: fx.url, allow_loopback_without_key: true });
    if (!handle.ok) throw new Error("open");
    const report = await runBoundedHarness(
      handle,
      registry,
      { messages: [{ role: "user", content: "x" }], deadline_ms: 2000 },
      { max_turns: 8, max_consecutive_decode_rejects: 3, active_cap: false },
    );
    expect(report.complete_calls).toBe(3);
    expect(hits).toBe(3);
    expect(report.dispatches).toBe(0);
    expect(report.stopped_reason).toBe("three_consecutive_decode_rejects");
    handle.close();

    const fx2 = await listen((_req, res) => {
      res.writeHead(200);
      res.end(envelope({ content: "no usage" }, "stop"));
    });
    const h2 = LiveModelAdapter.open({ endpoint: fx2.url, allow_loopback_without_key: true });
    if (!h2.ok) throw new Error("open");
    const r2 = await runBoundedHarness(
      h2,
      registry,
      { messages: [{ role: "user", content: "x" }], deadline_ms: 2000 },
      { max_turns: 5, max_consecutive_decode_rejects: 3, active_cap: true },
    );
    expect(r2.complete_calls).toBe(1);
    expect(r2.stopped_reason).toBe("unknown_usage_active_cap");
    expect(r2.dispatches).toBe(0);
    h2.close();
  });

  it("CLI credential_missing for unset empty and whitespace before any socket", () => {
    for (const env of [{}, { OPENAI_API_KEY: "" }, { OPENAI_API_KEY: "   " }]) {
      const observer = { count: 0 };
      const result = runCli({ task: "do thing", json: true, env, socketObserver: observer });
      expect(result.error).toBe("credential_missing");
      expect(result.code).not.toBe(0);
      expect(result.sockets).toBe(0);
      expect(result.final_answer).toBeNull();
      expect(observer.count).toBe(0);
      expect(result.live_baseline).toBe("not_run");
      expect(result.live_baseline_reason).toBe("credential_unavailable");
    }
  });

  it("CLI runtime_unavailable when key present and AgentRuntime absent", () => {
    const sentinel = "sk-cli-sentinel-SHOULD-NOT-APPEAR";
    registerDeniedBytes(sentinel);
    const result = runCli({
      task: "do thing",
      json: true,
      env: { OPENAI_API_KEY: sentinel },
    });
    expect(result.error).toBe("runtime_unavailable");
    expect(result.code).not.toBe(0);
    expect(result.sockets).toBe(0);
    expect(result.tool_dispatches).toBe(0);
    expect(result.final_answer).toBeNull();
    expect(result.stdout).not.toContain(sentinel);
    expect(result.components.AgentRuntime).toBe("unavailable");
    expect(result.components.finalizer).toBe("unavailable");
    expect(result.live_baseline).toBe("not_run");
  });

  it("readCredential treats trim-empty as missing and availability is not a fabricated score", () => {
    expect(readCredential("K", {}).present).toBe(false);
    expect(readCredential("K", { K: "  " }).present).toBe(false);
    expect(readCredential("K", { K: "abc" }).present).toBe(true);
    const a = componentAvailability();
    expect(a.live_baseline).toBe("not_run");
    expect(a.live_baseline_reason).toBe("credential_unavailable");
    expect(a.recovery_ledger).toBe("unavailable");
    expect(a.usage_accounting).toBe("unavailable");
  });
});
