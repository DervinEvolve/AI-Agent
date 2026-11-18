import http from "node:http";
import { describe, it, expect, afterEach } from "vitest";
import { ToolRegistry } from "../../runtime/tool_registry.js";
import {
  LiveModelAdapter,
  readCredential,
  componentAvailability,
} from "../cap_live_model_adapter_21.js";
import { decodeChatCompletion } from "../cap_action_decoder_19.js";
import { runCli } from "../cap_live_model_cli_21.js";
import { runBoundedHarness } from "../cap_live_model_harness_21.js";

const servers: http.Server[] = [];

function listen(
  handler: http.RequestListener,
): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => handler(req, res));
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1/chat/completions`,
        hits: () => hits,
      });
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

function chatBody(message: unknown, finish = "stop") {
  return JSON.stringify({
    choices: [{ finish_reason: finish, message }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
}

describe("cap_live_model_adapter_21 repair contract", () => {
  it("marks 500-504 retryable=false after exactly one request once bytes were sent", async () => {
    for (const status of [500, 502, 503, 504]) {
      const fx = await listen((_req, res) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "upstream" } }));
      });
      const opened = LiveModelAdapter.open({
        endpoint: fx.url,
        allow_loopback_without_key: true,
        env: {},
        timeout_ms: 2000,
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) continue;
      const result = await LiveModelAdapter.complete(opened, {
        messages: [{ role: "user", content: "ping" }],
        deadline_ms: 2000,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toBe("transport_error");
      expect(result.status_code).toBe(status);
      expect(result.retryable).toBe(false);
      expect(result.phase).toBe("pre-content");
      expect(fx.hits()).toBe(1);
      opened.close();
    }
  });

  it("CLI missing, empty, and whitespace credentials exit nonzero with zero sockets and credential_unavailable", () => {
    const observer = { count: 0 };
    for (const env of [
      {},
      { OPENAI_API_KEY: "" },
      { OPENAI_API_KEY: "   \t" },
    ]) {
      const out = runCli({
        task: "do something",
        json: true,
        env,
        socketObserver: observer,
      });
      expect(out.code).not.toBe(0);
      expect(out.code).toBeGreaterThan(0);
      expect(out.error).toBe("credential_missing");
      expect(out.final_answer).toBeNull();
      expect(out.sockets).toBe(0);
      expect(out.tool_dispatches).toBe(0);
      expect(observer.count).toBe(0);
      expect(out.live_baseline).toBe("not_run");
      expect(out.live_baseline_reason).toBe("credential_unavailable");
      const parsed = JSON.parse(out.stdout);
      expect(parsed.error).toBe("credential_missing");
      expect(parsed.sockets).toBe(0);
    }
    expect(readCredential("OPENAI_API_KEY", { OPENAI_API_KEY: "  " }).present).toBe(false);
    expect(readCredential("OPENAI_API_KEY", {}).present).toBe(false);
  });

  it("with a key but no AgentRuntime, CLI is runtime_unavailable and opens no sockets", () => {
    const availability = componentAvailability();
    expect(availability.agent_runtime).toBe("unavailable");
    const observer = { count: 0 };
    const out = runCli({
      task: "solve",
      json: true,
      env: { OPENAI_API_KEY: "sk-test-present" },
      socketObserver: observer,
    });
    expect(out.code).not.toBe(0);
    expect(out.error).toBe("runtime_unavailable");
    expect(out.final_answer).toBeNull();
    expect(out.sockets).toBe(0);
    expect(out.tool_dispatches).toBe(0);
    expect(observer.count).toBe(0);
    expect(out.live_baseline).toBe("not_run");
    expect(out.components.agent_runtime).toBe("unavailable");
  });

  it("harness dispatches one registry call then a candidate final answer with no further dispatch", async () => {
    let step = 0;
    const fx = await listen((_req, res) => {
      step += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (step === 1) {
        res.end(
          chatBody(
            {
              tool_calls: [
                {
                  id: "call_provider_should_not_be_call_id",
                  type: "function",
                  function: {
                    name: "echo",
                    arguments: JSON.stringify({ text: "hi" }),
                  },
                },
              ],
            },
            "tool_calls",
          ),
        );
        return;
      }
      res.end(chatBody({ content: "done" }, "stop"));
    });

    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "echo",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      async execute(args) {
        return { echoed: (args as { text: string }).text };
      },
    });

    const opened = LiveModelAdapter.open({
      endpoint: fx.url,
      allow_loopback_without_key: true,
      env: {},
      timeout_ms: 2000,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const report = await runBoundedHarness(
      opened,
      registry,
      { messages: [{ role: "user", content: "echo hi" }], deadline_ms: 2000 },
      { max_turns: 4, max_consecutive_decode_rejects: 3, active_cap: false },
    );

    expect(report.dispatches).toBe(1);
    expect(report.final_answer_dispatches).toBe(0);
    expect(report.candidate_final_answer).toBe("done");
    expect(report.complete_calls).toBe(2);
    expect(report.call_ids.length).toBe(1);
    expect(report.call_ids[0]).not.toBe("call_provider_should_not_be_call_id");
    expect(report.provider_ids_used_as_call_ids).toBe(false);
    expect(report.finalizer).toBe("unavailable");
    expect(report.verification).toBe("not_run");
    expect(fx.hits()).toBe(2);
    opened.close();

    const decoded = decodeChatCompletion(
      chatBody(
        {
          tool_calls: [
            {
              id: "prov",
              type: "function",
              function: { name: "echo", arguments: "{\"text\":1}" },
            },
            {
              id: "prov2",
              type: "function",
              function: { name: "echo", arguments: "{}" },
            },
          ],
        },
        "tool_calls",
      ),
      [{ name: "echo", schema: { type: "object", additionalProperties: false } }],
    );
    expect(decoded.kind).toBe("reject");
    if (decoded.kind === "reject") expect(decoded.reason).toBe("multi_action");
  });
});
