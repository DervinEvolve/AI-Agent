/**
 * Test-only harness. Not production orchestration and not reachable from the CLI.
 * Dispatches at most one ToolRegistry.call per decoded tool request.
 * Stops after three consecutive decode rejects and after unknown usage under an active cap.
 */
import { ToolRegistry } from "../runtime/tool_registry.js";
import { decodeChatCompletion, type RegistryToolView } from "./cap_action_decoder_19.js";
import {
  LiveModelAdapter,
  type AdapterHandle,
  type BoundedRequest,
  type CompleteResult,
} from "./cap_live_model_adapter_21.js";

export interface HarnessLimits {
  max_turns: number;
  max_consecutive_decode_rejects: number;
  active_cap: boolean;
}

export interface HarnessReport {
  finalizer: "unavailable";
  recovery_ledger: "unavailable";
  usage_accounting: "unavailable";
  verification: "not_run";
  dispatches: number;
  final_answer_dispatches: number;
  complete_calls: number;
  consecutive_rejects: number;
  stopped_reason: string;
  candidate_final_answer: string | null;
  call_ids: string[];
  provider_ids_used_as_call_ids: false;
}

export async function runBoundedHarness(
  handle: AdapterHandle,
  registry: ToolRegistry,
  firstRequest: BoundedRequest,
  limits: HarnessLimits,
): Promise<HarnessReport> {
  const tools: RegistryToolView[] = registry.list().map((t) => ({
    name: t.name,
    schema: (t.inputSchema ?? {}) as Record<string, unknown>,
  }));
  let dispatches = 0;
  let finalAnswerDispatches = 0;
  let completeCalls = 0;
  let consecutive = 0;
  let candidate: string | null = null;
  const callIds: string[] = [];
  let stopped = "max_turns";
  let request = firstRequest;

  for (let turn = 0; turn < limits.max_turns; turn++) {
    if (consecutive >= limits.max_consecutive_decode_rejects) {
      stopped = "three_consecutive_decode_rejects";
      break;
    }
    const result: CompleteResult = await LiveModelAdapter.complete(handle, request);
    completeCalls += 1;
    if (!result.ok) {
      stopped = result.error;
      break;
    }
    if (limits.active_cap && !result.usage_known) {
      stopped = "unknown_usage_active_cap";
      break;
    }
    const decoded = decodeChatCompletion(result.body, tools);
    if (decoded.kind === "reject") {
      consecutive += 1;
      if (consecutive >= limits.max_consecutive_decode_rejects) {
        stopped = "three_consecutive_decode_rejects";
        break;
      }
      continue;
    }
    consecutive = 0;
    if (decoded.kind === "final_answer") {
      candidate = decoded.content;
      finalAnswerDispatches += 0;
      stopped = "candidate_final_answer";
      break;
    }
    const toolResult = await registry.call(decoded.tool_name, decoded.arguments);
    dispatches += 1;
    if (toolResult && typeof toolResult === "object" && "call_id" in (toolResult as object)) {
      const id = (toolResult as { call_id?: unknown }).call_id;
      if (typeof id === "string") callIds.push(id);
    }
    stopped = "dispatched";
    request = {
      ...request,
      messages: [...request.messages, { role: "tool", content: JSON.stringify(toolResult) }],
    };
  }

  return {
    finalizer: "unavailable",
    recovery_ledger: "unavailable",
    usage_accounting: "unavailable",
    verification: "not_run",
    dispatches,
    final_answer_dispatches: finalAnswerDispatches,
    complete_calls: completeCalls,
    consecutive_rejects: consecutive,
    stopped_reason: stopped,
    candidate_final_answer: candidate,
    call_ids: callIds,
    provider_ids_used_as_call_ids: false,
  };
}
