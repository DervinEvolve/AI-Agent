import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BackgroundExecutor } from "../background_executor_24";
import { RedactionAdapter, type BackgroundRedactionAdapter } from "../background_redaction_adapter_24";

function buildRequest(secret = "secret-token") {
  return {
    id: "run-24",
    notificationText: `notify operator about ${secret}`,
    triggerMetadata: {
      trigger: "cron",
      authorization: `Bearer ${secret}`,
    },
    webhookDelivery: {
      url: `https://hooks.example.test/deliver?token=${secret}`,
      status: 200,
      responseBody: `accepted ${secret}`,
    },
  };
}

describe("cap_background_redactor_contract_24", () => {
  it("uses an injected redaction adapter object for notifications, trigger metadata exports, and webhook summaries", async () => {
    const calls: Array<{ text: string; context?: Record<string, unknown> }> = [];
    const adapter: BackgroundRedactionAdapter = {
      async redact(text, context) {
        calls.push({ text, context });
        return {
          text: text.replaceAll("secret-token", "[REDACTED]"),
          redactions: text.includes("secret-token") ? [{ kind: "test_secret" }] : [],
          blocked: false,
        };
      },
    };

    const result = await new BackgroundExecutor({ redactionAdapter: adapter }).execute(buildRequest());

    expect(result.status).toBe("completed");
    expect(calls.map((call) => call.context?.surface)).toEqual([
      "notification",
      "trigger_metadata_export",
      "webhook_summary",
    ]);
    expect(result.notification?.text).toContain("[REDACTED]");
    expect(result.triggerMetadataExport?.redacted.text).toContain("[REDACTED]");
    expect(result.webhookSummary?.redacted.text).toContain("[REDACTED]");
    expect(result.notification?.text).not.toContain("secret-token");
    expect(result.triggerMetadataExport?.redacted.text).not.toContain("secret-token");
    expect(result.webhookSummary?.redacted.text).not.toContain("secret-token");
  });

  it("normalizes legacy fake redactor functions through RedactionAdapter.fromCallable before executor use", async () => {
    const adapter = RedactionAdapter.fromCallable((text) =>
      text.replace(/api_key=[A-Za-z0-9_-]+/g, "api_key=[REDACTED]"),
    );

    const result = await new BackgroundExecutor({ redactionAdapter: adapter }).execute({
      id: "legacy-run",
      notificationText: "rotation completed for api_key=abc123",
      triggerMetadata: { header: "api_key=abc123" },
      webhookDelivery: {
        url: "https://hooks.example.test?api_key=abc123",
        status: 202,
        responseBody: "queued api_key=abc123",
      },
    });

    expect(result.status).toBe("completed");
    expect(result.notification?.text).toBe("rotation completed for api_key=[REDACTED]");
    expect(result.webhookSummary?.redacted.text).not.toContain("abc123");
  });

  it("returns policy_blocked and emits a redacted terminal trace when the adapter blocks output", async () => {
    const adapter: BackgroundRedactionAdapter = {
      async redact() {
        return {
          text: "[REDACTED blocked notification]",
          redactions: [{ kind: "policy_secret" }],
          blocked: true,
        };
      },
    };

    const result = await new BackgroundExecutor({ redactionAdapter: adapter }).execute(buildRequest("do-not-leak"));

    expect(result.status).toBe("policy_blocked");
    expect(result.traceEvents).toHaveLength(1);
    expect(result.traceEvents[0]).toMatchObject({
      type: "terminal_trace",
      terminal: true,
      policyBlocked: true,
      text: "[REDACTED blocked notification]",
    });
    expect(JSON.stringify(result)).not.toContain("do-not-leak");
  });

  it("fails closed without leaking input when an injected adapter returns malformed output", async () => {
    const adapter = {
      async redact() {
        return { text: 42, redactions: [], blocked: false };
      },
    } as unknown as BackgroundRedactionAdapter;

    const result = await new BackgroundExecutor({ redactionAdapter: adapter }).execute(buildRequest("malformed-secret"));

    expect(result.status).toBe("policy_blocked");
    expect(result.traceEvents[0]?.text).toBe("[redaction failed]");
    expect(JSON.stringify(result)).not.toContain("malformed-secret");
  });

  it("keeps background modules free of direct secret_redactor callable dependencies", () => {
    const moduleUrls = [
      "../background_executor_24.ts",
      "../trigger_registry_24.ts",
      "../webhook_gateway_24.ts",
      "../background_lease_24.ts",
    ];

    for (const moduleUrl of moduleUrls) {
      const source = readFileSync(new URL(moduleUrl, import.meta.url), "utf8");
      expect(source).not.toMatch(/secret_redactor/);
      expect(source).not.toMatch(/secretRedactor\s*\(/);
    }
  });
});
