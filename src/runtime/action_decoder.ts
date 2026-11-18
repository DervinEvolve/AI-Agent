import type { ToolSchemaLike } from './runtime_context';

export interface Citation {
  shape?: number;
  call_id?: string;
}

export type DecodedAction =
  | { kind: 'rejected'; reason: string }
  | {
      kind: 'tool_call';
      toolName: string;
      arguments: Record<string, unknown>;
      plan?: string;
    }
  | {
      kind: 'final_answer';
      text: string;
      citations?: Citation[];
      claimsNoToolEvidence?: boolean;
      plan?: string;
    }
  | { kind: 'plan_revision'; plan: string };

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'description',
  'default',
  'title',
]);

function validateAgainstSubsetSchema(
  value: unknown,
  schema: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      return { ok: false, reason: `unsupported_schema_keyword:${key}` };
    }
  }

  const expectedType = schema.type;
  if (expectedType === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: 'expected_object' };
    }
    const obj = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const req of required) {
      if (!(req in obj) || obj[req] === undefined) {
        return { ok: false, reason: `missing_required:${req}` };
      }
    }
    const props = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) {
          return { ok: false, reason: `additional_property_not_allowed:${key}` };
        }
      }
    }
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in obj && obj[key] !== undefined) {
        const res = validateAgainstSubsetSchema(obj[key], propSchema);
        if (!res.ok) {
          return res;
        }
      }
    }
    return { ok: true };
  }

  if (expectedType === 'string') {
    if (typeof value !== 'string') {
      return { ok: false, reason: 'expected_string' };
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      return { ok: false, reason: 'string_too_short' };
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return { ok: false, reason: 'string_too_long' };
    }
  } else if (expectedType === 'number' || expectedType === 'integer') {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return { ok: false, reason: 'expected_number' };
    }
    if (expectedType === 'integer' && !Number.isInteger(value)) {
      return { ok: false, reason: 'expected_integer' };
    }
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return { ok: false, reason: 'number_below_minimum' };
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return { ok: false, reason: 'number_above_maximum' };
    }
  } else if (expectedType === 'boolean') {
    if (typeof value !== 'boolean') {
      return { ok: false, reason: 'expected_boolean' };
    }
  } else if (expectedType === 'array') {
    if (!Array.isArray(value)) {
      return { ok: false, reason: 'expected_array' };
    }
    if (schema.items && typeof schema.items === 'object') {
      for (const item of value) {
        const res = validateAgainstSubsetSchema(item, schema.items as Record<string, unknown>);
        if (!res.ok) {
          return res;
        }
      }
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return { ok: false, reason: 'enum_mismatch' };
  }

  return { ok: true };
}

export class ActionDecoder {
  decode(response: unknown, toolSchemas: ToolSchemaLike[]): DecodedAction {
    if (response === null || typeof response !== 'object' || Array.isArray(response)) {
      return { kind: 'rejected', reason: 'malformed_response' };
    }

    const obj = response as Record<string, unknown>;
    const kind = obj.kind;

    if ('actions' in obj || ('toolName' in obj && 'text' in obj)) {
      return { kind: 'rejected', reason: 'multi_action_not_allowed' };
    }

    if (kind === 'tool_call') {
      if (typeof obj.toolName !== 'string' || !obj.toolName) {
        return { kind: 'rejected', reason: 'missing_tool_name' };
      }
      const schema = toolSchemas.find((s) => s.name === obj.toolName);
      if (!schema) {
        return { kind: 'rejected', reason: `unknown_tool:${obj.toolName}` };
      }
      const args = obj.arguments;
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        return { kind: 'rejected', reason: 'invalid_arguments' };
      }
      const jsonSchema = schema.inputSchema ?? schema.parameters;
      if (jsonSchema) {
        const valid = validateAgainstSubsetSchema(args, jsonSchema);
        if (!valid.ok) {
          return { kind: 'rejected', reason: `schema_invalid:${valid.reason}` };
        }
      }
      return {
        kind: 'tool_call',
        toolName: obj.toolName,
        arguments: args as Record<string, unknown>,
        plan: typeof obj.plan === 'string' ? obj.plan : undefined,
      };
    }

    if (kind === 'final_answer') {
      if (typeof obj.text !== 'string') {
        return { kind: 'rejected', reason: 'missing_final_answer_text' };
      }
      return {
        kind: 'final_answer',
        text: obj.text,
        citations: Array.isArray(obj.citations) ? (obj.citations as Citation[]) : undefined,
        claimsNoToolEvidence: obj.claimsNoToolEvidence === true,
        plan: typeof obj.plan === 'string' ? obj.plan : undefined,
      };
    }

    if (kind === 'plan_revision') {
      if (typeof obj.plan !== 'string' || !obj.plan.trim()) {
        return { kind: 'rejected', reason: 'missing_plan' };
      }
      return { kind: 'plan_revision', plan: obj.plan };
    }

    return { kind: 'rejected', reason: 'unknown_action_kind' };
  }
}
