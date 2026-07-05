export const cap_background_redactor_contract_24 = {
  id: "cap_background_redactor_contract_24",
  modifies: "cap_proactive_background_execution_22",
  description:
    "Tightens background execution so redaction is performed through an injected adapter with a stable redact(text, context) interface.",
  redactionAdapterContract: {
    input: "{text:string, context?:object}",
    output: "{text:string, redactions:list, blocked:bool}",
    acceptedTestDoubles: [
      "object exposing redact(text, context)",
      "plain function wrapped once by RedactionAdapter.fromCallable for legacy tests",
    ],
    forbidden: [
      "direct invocation of an imported secret_redactor module/object without interface normalization",
      "assuming secret_redactor itself is callable",
    ],
  },
} as const;

export { BackgroundExecutor } from "./background_executor_24";
export { BackgroundLease } from "./background_lease_24";
export { RedactionAdapter, redactSafely } from "./background_redaction_adapter_24";
export { TriggerRegistry } from "./trigger_registry_24";
export { WebhookGateway } from "./webhook_gateway_24";
export type {
  BackgroundExecutionRequest,
  BackgroundExecutionResult,
  BackgroundExecutionStatus,
} from "./background_executor_24";
export type {
  BackgroundRedactionAdapter,
  LegacyRedactorCallable,
  RedactionContext,
  RedactionRecord,
  RedactionResult,
} from "./background_redaction_adapter_24";
