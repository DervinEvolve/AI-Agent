export type ToolStatus = 'ok' | 'error' | 'invalid_args' | 'timeout';

export interface ToolResult {
  call_id: string | null;
  tool_name: string;
  status: ToolStatus;
  started: boolean;
  output: unknown;
  error: string | null;
  duration_ms: number;
  termination_confirmed: boolean;
}

export type ToolFn = (args: Record<string, unknown>) => Promise<unknown>;

interface Entry {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  fn: ToolFn;
  idempotent: boolean;
  timeoutS: number;
}

const ALLOWED = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'enum', 'const',
  'minimum', 'maximum', 'minLength', 'maxLength', 'items', 'minItems',
  'maxItems', 'anyOf', 'oneOf', 'description', 'title',
]);

export function checkSchema(s: unknown, depth = 1): void {
  if (depth > 8) throw new Error('schema_too_deep');
  if (typeof s !== 'object' || s === null || Array.isArray(s)) throw new Error('schema_invalid');
  for (const k of Object.keys(s)) {
    if (k === 'pattern') throw new Error('regex_unavailable');
    if (!ALLOWED.has(k)) throw new Error('unsupported_keyword:' + k);
  }
  const o = s as Record<string, any>;
  if (o.properties) for (const v of Object.values(o.properties)) checkSchema(v, depth + 1);
  if (o.items) checkSchema(o.items, depth + 1);
  for (const k of ['anyOf', 'oneOf']) if (Array.isArray(o[k])) for (const v of o[k]) checkSchema(v, depth + 1);
  if (typeof o.additionalProperties === 'object' && o.additionalProperties) checkSchema(o.additionalProperties, depth + 1);
}

function isInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v);
}

function typeOk(t: string, v: unknown): boolean {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'integer': return isInt(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    case 'array': return Array.isArray(v);
    case 'object': return typeof v === 'object' && v !== null && !Array.isArray(v);
  }
  return false;
}

export function validate(s: any, v: unknown): string[] {
  const errs: string[] = [];
  if (s.type !== undefined) {
    const ts = Array.isArray(s.type) ? s.type : [s.type];
    if (!ts.some((t: string) => typeOk(t, v))) return ['type'];
  }
  if (s.enum && !s.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(v))) errs.push('enum');
  if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(v)) errs.push('const');
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) errs.push('minimum');
    if (s.maximum !== undefined && v > s.maximum) errs.push('maximum');
  }
  if (typeof v === 'string') {
    if (s.minLength !== undefined && v.length < s.minLength) errs.push('minLength');
    if (s.maxLength !== undefined && v.length > s.maxLength) errs.push('maxLength');
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) errs.push('minItems');
    if (s.maxItems !== undefined && v.length > s.maxItems) errs.push('maxItems');
    if (s.items) v.forEach((x) => errs.push(...validate(s.items, x)));
  }
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const r of s.required ?? []) if (!(r in o)) errs.push('required:' + r);
    const props = s.properties ?? {};
    for (const k of Object.keys(o)) {
      if (k in props) errs.push(...validate(props[k], o[k]));
      else if (s.additionalProperties === false) errs.push('additional:' + k);
      else if (typeof s.additionalProperties === 'object') errs.push(...validate(s.additionalProperties, o[k]));
    }
  }
  if (s.anyOf && !s.anyOf.some((b: unknown) => validate(b, v).length === 0)) errs.push('anyOf');
  if (s.oneOf && s.oneOf.filter((b: unknown) => validate(b, v).length === 0).length !== 1) errs.push('oneOf');
  return errs;
}

export class ToolRegistry {
  private tools = new Map<string, Entry>();
  private counter = 0;

  register(name: string, description: string, schema: Record<string, unknown>, fn: ToolFn, idempotent = false, timeoutS = 5): void {
    if (this.tools.has(name)) throw new Error('duplicate_tool');
    if (JSON.stringify(schema).length > 8192) throw new Error('schema_too_large');
    checkSchema(schema);
    this.tools.set(name, { name, description, schema, fn, idempotent, timeoutS });
  }

  isIdempotent(name: string): boolean {
    return this.tools.get(name)?.idempotent ?? false;
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const base = { call_id: null, tool_name: name, started: false, output: null, error: null as string | null, duration_ms: 0, termination_confirmed: false };
    const t = this.tools.get(name);
    if (!t) return { ...base, status: 'error', error: 'unknown_tool' };
    const errs = validate(t.schema, args);
    if (errs.length) return { ...base, status: 'invalid_args', error: errs.join(',') };
    const call_id = 'call_' + ++this.counter;
    const t0 = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), t.timeoutS * 1000); });
    try {
      const r = await Promise.race([Promise.resolve().then(() => t.fn(args)), timeout]);
      const d = Date.now() - t0;
      if (r === 'timeout') return { ...base, call_id, started: true, status: 'timeout', error: 'deadline', duration_ms: d };
      return { ...base, call_id, started: true, status: 'ok', output: r, duration_ms: d };
    } catch (e) {
      return { ...base, call_id, started: true, status: 'error', error: String(e), duration_ms: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  }
}
