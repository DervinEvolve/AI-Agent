export const PROGRAM_CAPS = Object.freeze({
  maxProgramBytes: 8192,
  maxSteps: 32,
  maxMapItems: 16,
  maxInnerCalls: 32,
  maxDepth: 32,
});

export const REASON_CODES = Object.freeze({
  invalid_program: 'invalid_program',
  program_evaluation_error: 'program_evaluation_error',
  program_aborted: 'program_aborted',
});

export interface ProgramConfig {
  enabled: boolean;
  programTools: string[];
  maxMapItems?: number;
  maxInnerCalls?: number;
  maxProgramSteps?: number;
}

export type OpSpec =
  | { kind: 'call'; tool: string; args: unknown }
  | { kind: 'map'; over: unknown; tool: string; args_template: unknown; limit: number }
  | { kind: 'select'; from: unknown; pointer: string }
  | { kind: 'count'; from: unknown }
  | { kind: 'join'; from: unknown; separator: string };

export interface StepSpec {
  id: string;
  op: OpSpec;
}

export interface ProgramSpec {
  version: 1;
  steps: StepSpec[];
}

export interface ProgramExecutionRecord {
  outerCallId: string;
  entries: { innerCallId?: string; step: string; index?: number; state: string }[];
}

export type ValidationResult = { ok: true; program: ProgramSpec } | { ok: false; reason: string };

const ID_RE = /^[a-z][a-z0-9_]{0,23}$/;
const BAD = new Set(['__proto__', 'constructor', 'prototype']);

export function validateProgram(raw: unknown, config?: Partial<ProgramConfig>): ValidationResult {
  const fail = (reason: string): ValidationResult => ({ ok: false, reason });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('not_object');
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) return fail('bad_version');
  for (const k of Object.keys(o)) if (k !== 'version' && k !== 'steps') return fail('unknown_field');
  if (!Array.isArray(o.steps)) return fail('bad_steps');
  const maxSteps = Math.min(config?.maxProgramSteps ?? 16, PROGRAM_CAPS.maxSteps);
  if (o.steps.length < 1 || o.steps.length > maxSteps) return fail('bad_step_count');
  const maxMap = Math.min(config?.maxMapItems ?? 8, PROGRAM_CAPS.maxMapItems);
  const maxCalls = Math.min(config?.maxInnerCalls ?? 16, PROGRAM_CAPS.maxInnerCalls);
  const seen = new Set<string>();
  let calls = 0;
  for (const s of o.steps) {
    if (typeof s !== 'object' || s === null) return fail('bad_step');
    const st = s as Record<string, unknown>;
    if (typeof st.id !== 'string' || !ID_RE.test(st.id)) return fail('bad_id');
    if (seen.has(st.id)) return fail('duplicate_id');
    seen.add(st.id);
    const op = st.op as Record<string, unknown> | null;
    if (typeof op !== 'object' || op === null) return fail('bad_op');
    if (op.kind === 'call') calls += 1;
    else if (op.kind === 'map') {
      if (!Number.isInteger(op.limit) || (op.limit as number) < 1 || (op.limit as number) > maxMap) return fail('bad_map_limit');
      calls += op.limit as number;
    } else if (!['select', 'count', 'join', 'filter'].includes(op.kind as string)) return fail('bad_kind');
  }
  if (calls > maxCalls) return fail('too_many_calls');
  return { ok: true, program: raw as ProgramSpec };
}

export function resolvePointer(data: unknown, pointer: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (pointer === '') return { ok: true, value: data };
  if (!pointer.startsWith('/')) return { ok: false, reason: 'bad_pointer' };
  let cur: unknown = data;
  for (const part of pointer.slice(1).split('/')) {
    const seg = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (BAD.has(seg)) return { ok: false, reason: 'forbidden_segment' };
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(seg)) return { ok: false, reason: 'bad_index' };
      const i = Number(seg);
      if (i >= cur.length) return { ok: false, reason: 'missing' };
      cur = cur[i];
    } else if (typeof cur === 'object' && cur !== null) {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return { ok: false, reason: 'missing' };
      cur = (cur as Record<string, unknown>)[seg];
    } else return { ok: false, reason: 'missing' };
  }
  return { ok: true, value: cur };
}
