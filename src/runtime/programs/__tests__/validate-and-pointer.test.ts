import { describe, expect, it } from 'vitest';
import {
  PROGRAM_CAPS,
  REASON_CODES,
  resolvePointer,
  validateProgram,
  type ProgramSpec,
} from '../types';

function callStep(id: string, tool = 'read_file') {
  return { id, op: { kind: 'call' as const, tool, args: { path: id } } };
}

function program(steps: ProgramSpec['steps']): ProgramSpec {
  return { version: 1, steps };
}

describe('validateProgram grammar and call bounds', () => {
  it('accepts a chained program and returns the parsed spec', () => {
    const raw = program([
      callStep('load'),
      {
        id: 'pick',
        op: {
          kind: 'select',
          from: { $ref: '/steps/load/output' },
          pointer: '/items',
        },
      },
      {
        id: 'only',
        op: {
          kind: 'filter',
          from: { $ref: '/steps/pick/output' },
          pointer: '/n',
          comparison: 'gt',
          value: 0,
        },
      },
      {
        id: 'n',
        op: { kind: 'count', from: { $ref: '/steps/only/output' } },
      },
      {
        id: 'label',
        op: {
          kind: 'join',
          from: { $ref: '/steps/pick/output/names' },
          separator: ',',
        },
      },
    ]);
    const result = validateProgram(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.program.steps).toHaveLength(5);
    expect(result.program.steps[1].op.kind).toBe('select');
  });

  it('rejects unknown fields, bad versions, and duplicate step ids', () => {
    expect(validateProgram({ version: 2, steps: [callStep('a')] }).ok).toBe(false);
    expect(validateProgram({ version: 1, steps: [callStep('a')], extra: true }).ok).toBe(false);
    expect(
      validateProgram(program([callStep('same'), callStep('same')])).ok,
    ).toBe(false);
    expect(validateProgram(program([])).ok).toBe(false);
  });

  it('rejects forward references, cycles, and refs that are not exact singletons', () => {
    expect(
      validateProgram(
        program([
          {
            id: 'early',
            op: { kind: 'count', from: { $ref: '/steps/later/output' } },
          },
          callStep('later'),
        ]),
      ).ok,
    ).toBe(false);
    expect(
      validateProgram(
        program([
          {
            id: 'self',
            op: { kind: 'count', from: { $ref: '/steps/self/output' } },
          },
        ]),
      ).ok,
    ).toBe(false);
    expect(
      validateProgram(
        program([
          {
            id: 'wrapped',
            op: {
              kind: 'select',
              from: { note: 'not a singleton', $ref: '/steps/missing/output' },
              pointer: '',
            },
          },
        ]),
      ).ok,
    ).toBe(false);
  });

  it('rejects a map whose worst-case calls exceed the configured cap before execution', () => {
    const steps = [
      {
        id: 'wide',
        op: {
          kind: 'map',
          over: { $ref: '/nowhere' },
          tool: 'read_file',
          args_template: { item: { $item: '' } },
          limit: 8,
        },
      },
      callStep('after'),
    ];
    const over = validateProgram(program(steps), { maxInnerCalls: 8, maxProgramSteps: 16 });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe(REASON_CODES.invalid_program);

    const under = validateProgram(program(steps), { maxInnerCalls: 9, maxProgramSteps: 16 });
    expect(under.ok).toBe(false);
    if (!under.ok) expect(under.reason).not.toBe('too_many_calls');
  });

  it('rejects map limits above the hard cap and step counts above the inclusive config cap', () => {
    const hugeMap = program([
      {
        id: 'm',
        op: {
          kind: 'map',
          over: [],
          tool: 'read_file',
          args_template: {},
          limit: PROGRAM_CAPS.maxMapItems + 1,
        },
      },
    ]);
    expect(validateProgram(hugeMap).ok).toBe(false);

    const steps = Array.from({ length: 4 }, (_, i) => callStep(`s${i}`));
    expect(validateProgram(program(steps), { maxProgramSteps: 3 }).ok).toBe(false);
    expect(validateProgram(program(steps), { maxProgramSteps: 4 }).ok).toBe(true);
  });

  it('rejects hostile pointer segments inside $ref and $item before any dispatch', () => {
    const hostile = [
      '/steps/load/output/__proto__',
      '/steps/load/output/constructor',
      '/steps/load/output/prototype',
      '/steps/load/output/__proto__/x',
      '/steps/load/output/a~1b',
    ];
    for (const pointer of hostile.slice(0, 4)) {
      const result = validateProgram(
        program([
          callStep('load'),
          { id: 'bad', op: { kind: 'select', from: { $ref: pointer }, pointer: '' } },
        ]),
      );
      expect(result.ok).toBe(false);
    }
    const item = validateProgram(
      program([
        {
          id: 'm',
          op: {
            kind: 'map',
            over: [],
            tool: 'read_file',
            args_template: { x: { $item: '/__proto__' } },
            limit: 1,
          },
        },
      ]),
    );
    expect(item.ok).toBe(false);
  });
});

describe('resolvePointer', () => {
  it('decodes RFC 6901 escapes and reads only own properties', () => {
    const doc = Object.create({ inherited: 1 });
    doc['a/b'] = { 'c~d': [10, 20] };
    const hit = resolvePointer(doc, '/a~1b/c~0d/1');
    expect(hit).toEqual({ ok: true, value: 20 });
    expect(resolvePointer(doc, '/inherited').ok).toBe(false);
    expect(resolvePointer(doc, '/toString').ok).toBe(false);
    expect(resolvePointer(doc, '/constructor').ok).toBe(false);
  });

  it('rejects proto segments after decoding and non-canonical array indexes', () => {
    const encoded = resolvePointer({ safe: 1 }, '/__proto__');
    expect(encoded.ok).toBe(false);
    const tildeProto = resolvePointer({ ok: true }, '/~1__proto__');
    expect(tildeProto.ok).toBe(false);
    expect(resolvePointer([1, 2], '/-').ok).toBe(false);
    expect(resolvePointer([1, 2], '/01').ok).toBe(false);
    expect(resolvePointer([1, 2], '/1').ok).toBe(true);
    expect(resolvePointer([1, 2], '/2').ok).toBe(false);
  });

  it('does not treat a stored $ref object as another reference', () => {
    const doc = { payload: { $ref: '/steps/other/output' }, n: 3 };
    const result = resolvePointer(doc, '/payload');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ $ref: '/steps/other/output' });
    }
    expect(resolvePointer(doc, '/n')).toEqual({ ok: true, value: 3 });
    expect(resolvePointer(doc, '').ok).toBe(false);
  });
});
