import type { BackgroundRedactionAdapter, RedactionResult } from "./background_redaction_adapter_24";
import { redactSafely } from "./background_redaction_adapter_24";
import { BackgroundLease, type BackgroundTraceEvent } from "./background_lease_24";
import { TriggerRegistry, type TriggerMetadataExport } from "./trigger_registry_24";
import { WebhookGateway, type WebhookDeliverySummary, type WebhookDeliverySummaryInput } from "./webhook_gateway_24";

export interface BackgroundExecutionRequest {
  id: string;
  notificationText: string;
  triggerMetadata: Record<string, unknown>;
  webhookDelivery: WebhookDeliverySummaryInput;
}

export type BackgroundExecutionStatus = "completed" | "policy_blocked";

export interface BackgroundExecutionResult {
  id: string;
  status: BackgroundExecutionStatus;
  notification?: RedactionResult;
  triggerMetadataExport?: TriggerMetadataExport;
  webhookSummary?: WebhookDeliverySummary;
  traceEvents: BackgroundTraceEvent[];
}

export interface BackgroundExecutorDependencies {
  redactionAdapter: BackgroundRedactionAdapter;
  triggerRegistry?: TriggerRegistry;
  webhookGateway?: WebhookGateway;
  lease?: BackgroundLease;
}

export class BackgroundExecutor {
  private readonly redactionAdapter: BackgroundRedactionAdapter;
  private readonly triggerRegistry: TriggerRegistry;
  private readonly webhookGateway: WebhookGateway;
  private readonly lease: BackgroundLease;

  constructor(dependencies: BackgroundExecutorDependencies) {
    if (!dependencies.redactionAdapter || typeof dependencies.redactionAdapter.redact !== "function") {
      throw new TypeError("BackgroundExecutor requires an injected redaction adapter object");
    }

    this.redactionAdapter = dependencies.redactionAdapter;
    this.triggerRegistry = dependencies.triggerRegistry ?? new TriggerRegistry();
    this.webhookGateway = dependencies.webhookGateway ?? new WebhookGateway();
    this.lease = dependencies.lease ?? new BackgroundLease();
  }

  async execute(request: BackgroundExecutionRequest): Promise<BackgroundExecutionResult> {
    const notification = await redactSafely(this.redactionAdapter, request.notificationText, {
      executionId: request.id,
      surface: "notification",
    });

    if (notification.blocked) {
      return this.policyBlocked(request.id, notification, "notification");
    }

    const triggerMetadataExport = await this.triggerRegistry.exportMetadata(
      request.triggerMetadata,
      this.redactionAdapter,
      { executionId: request.id },
    );

    if (triggerMetadataExport.redacted.blocked) {
      return this.policyBlocked(request.id, triggerMetadataExport.redacted, "trigger_metadata_export");
    }

    const webhookSummary = await this.webhookGateway.summarizeDelivery(
      request.webhookDelivery,
      this.redactionAdapter,
      { executionId: request.id },
    );

    if (webhookSummary.redacted.blocked) {
      return this.policyBlocked(request.id, webhookSummary.redacted, "webhook_summary");
    }

    this.lease.emit({
      type: "background_execution_completed",
      data: { executionId: request.id },
    });

    return {
      id: request.id,
      status: "completed",
      notification,
      triggerMetadataExport,
      webhookSummary,
      traceEvents: this.lease.snapshot(),
    };
  }

  private policyBlocked(id: string, redacted: RedactionResult, surface: string): BackgroundExecutionResult {
    this.lease.emitRedactedTerminalTrace(redacted, {
      executionId: id,
      surface,
      reason: "redaction_adapter_blocked",
    });

    return {
      id,
      status: "policy_blocked",
      traceEvents: this.lease.snapshot(),
    };
  }
}
