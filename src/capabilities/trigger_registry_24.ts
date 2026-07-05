import type { BackgroundRedactionAdapter, RedactionContext, RedactionResult } from "./background_redaction_adapter_24";
import { redactSafely } from "./background_redaction_adapter_24";

export interface TriggerMetadataExport {
  metadata: Record<string, unknown>;
  redacted: RedactionResult;
}

export class TriggerRegistry {
  async exportMetadata(
    metadata: Record<string, unknown>,
    redactionAdapter: BackgroundRedactionAdapter,
    context: RedactionContext = {},
  ): Promise<TriggerMetadataExport> {
    const serialized = JSON.stringify(metadata);
    const redacted = await redactSafely(redactionAdapter, serialized, {
      ...context,
      surface: "trigger_metadata_export",
    });

    return {
      metadata: { ...metadata },
      redacted,
    };
  }
}
