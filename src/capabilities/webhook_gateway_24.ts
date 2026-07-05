import type { BackgroundRedactionAdapter, RedactionContext, RedactionResult } from "./background_redaction_adapter_24";
import { redactSafely } from "./background_redaction_adapter_24";

export interface WebhookDeliverySummaryInput {
  url: string;
  status: number;
  responseBody?: string;
}

export interface WebhookDeliverySummary {
  redacted: RedactionResult;
}

export class WebhookGateway {
  async summarizeDelivery(
    delivery: WebhookDeliverySummaryInput,
    redactionAdapter: BackgroundRedactionAdapter,
    context: RedactionContext = {},
  ): Promise<WebhookDeliverySummary> {
    const summary = JSON.stringify({
      url: delivery.url,
      status: delivery.status,
      responseBody: delivery.responseBody ?? "",
    });

    return {
      redacted: await redactSafely(redactionAdapter, summary, {
        ...context,
        surface: "webhook_summary",
      }),
    };
  }
}
