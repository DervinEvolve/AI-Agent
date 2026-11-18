/**
 * Reusable OpenAI-compatible chat-completions action decoder (cap_19).
 * Provider ids never become call_ids. Arguments are not coerced.
 * This is not an agent runtime and does not dispatch tools.
 */

export type DecodeRejectReason =
  | "malformed_json"
  | "invalid_envelope"
  | "invalid_finish_reason"
  | "truncated"
  | "multi_action"
  | "unknown_tool"
  | "schema_invalid"
  | "arguments_not_object";

export interface RegistryToolView {
  name: string;
  schema: Record<string, unknown>;
}

export interface DecodedToolRequest {
  kind: "tool_request";
  tool_name: string;
  arguments: Record<string, unknown>;
  /** Provider id is retained only as opaque data, never as a call_id. */
  provider_tool_call_id: string | null;
}

export interface DecodedFinalAnswer {
  kind: "final_answer";
  content: string;
  /** Candidate only until a consolidated finalizer is mounted. */
  candidate: true;
}

export interface DecodeReject {
  kind: "reject";
  reason: DecodeRejectReason;
  detail?: string;
}

export type DecodeResult = DecodedToolRequest | DecodedFinalAnswer | DecodeReject;

const VALID_FINISH = new Set(["stop", "tool_calls", "length"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function schemaAllows(schema: Record<string, unknown> | undefined, args: Record<string, unknown>): boolean {
  if (!schema || Object.keys(schema).length === 0) return true;
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  for (const key of required) {
    if (typeof key !== "string" || !(key in args)) return false;
  }
  const props = isPlainObject(schema.properties) ? schema.properties : null;
  if (!props) return true;
  const additional = schema.additionalProperties;
  for (const [k, val] of Object.entries(args)) {
    const prop = props[k];
    if (!isPlainObject(prop)) {
      if (additional === false) return false;
      continue;
    }
    const t = prop.type;
    if (typeof t === "string") {
      if (t === "string" && typeof val !== "string") return false;
      if (t === "number" && typeof val !== "number") return false;
      if (t === "integer" && (typeof val !== "number" || !Number.isInteger(val))) return false;
      if (t === "boolean" && typeof val !== "boolean") return false;
      if (t === "object" && !isPlainObject(val)) return false;
      if (t === "array" && !Array.isArray(val)) return false;
      if (t === "null" && val !== null) return false;
    }
    if (Array.isArray(prop.enum) && !prop.enum.includes(val)) return false;
  }
  return true;
}

export function decodeChatCompletion(
  raw: string,
  tools: readonly RegistryToolView[],
): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "reject", reason: "malformed_json" };
  }
  if (!isPlainObject(parsed)) return { kind: "reject", reason: "invalid_envelope" };
  const choices = parsed.choices;
  if (!Array.isArray(choices) || choices.length !== 1 || !isPlainObject(choices[0])) {
    return { kind: "reject", reason: "invalid_envelope" };
  }
  const choice = choices[0];
  const finish = choice.finish_reason;
  if (finish === "length") return { kind: "reject", reason: "truncated" };
  if (typeof finish !== "string" || !VALID_FINISH.has(finish)) {
    return { kind: "reject", reason: "invalid_finish_reason", detail: String(finish) };
  }
  const message = choice.message;
  if (!isPlainObject(message)) return { kind: "reject", reason: "invalid_envelope" };

  const toolCalls = message.tool_calls;
  const hasTools = Array.isArray(toolCalls) && toolCalls.length > 0;
  if (hasTools) {
    if (toolCalls.length !== 1) return { kind: "reject", reason: "multi_action" };
    if (finish !== "tool_calls" && finish !== "stop") {
      return { kind: "reject", reason: "invalid_finish_reason" };
    }
    const tc = toolCalls[0];
    if (!isPlainObject(tc) || !isPlainObject(tc.function)) {
      return { kind: "reject", reason: "invalid_envelope" };
    }
    const name = tc.function.name;
    if (typeof name !== "string" || name.length === 0) {
      return { kind: "reject", reason: "unknown_tool" };
    }
    const known = tools.find((t) => t.name === name);
    if (!known) return { kind: "reject", reason: "unknown_tool", detail: name };
    const argRaw = tc.function.arguments;
    if (typeof argRaw !== "string") return { kind: "reject", reason: "malformed_json" };
    let args: unknown;
    try {
      args = JSON.parse(argRaw);
    } catch {
      return { kind: "reject", reason: "malformed_json" };
    }
    if (!isPlainObject(args)) return { kind: "reject", reason: "arguments_not_object" };
    if (!schemaAllows(known.schema, args)) return { kind: "reject", reason: "schema_invalid" };
    const pid = typeof tc.id === "string" ? tc.id : null;
    return {
      kind: "tool_request",
      tool_name: name,
      arguments: args,
      provider_tool_call_id: pid,
    };
  }

  if (finish === "tool_calls") return { kind: "reject", reason: "invalid_envelope" };
  if (typeof message.content !== "string" || message.content.length === 0) {
    return { kind: "reject", reason: "invalid_envelope" };
  }
  return { kind: "final_answer", content: message.content, candidate: true };
}
