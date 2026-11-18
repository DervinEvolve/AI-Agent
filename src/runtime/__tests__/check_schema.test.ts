import { describe, it, expect } from 'vitest';
import { checkSchema, ToolRegistry } from '../tool_registry';

// Builds a schema whose innermost node sits at depth `levels` (the root is depth 1).
function nest(levels: number): Record<string, unknown> {
  let s: Record<string, unknown> = { type: 'string' };
  for (let i = 1; i < levels; i++) {
    s = { type: 'object', properties: { a: s } };
  }
  return s;
}

describe('checkSchema', () => {
  it('accepts a schema using only the supported subset', () => {
    const schema = {
      type: 'object',
      title: 't',
      description: 'd',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 10 },
        n: { type: 'integer', minimum: 0, maximum: 5 },
        tags: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 3 },
        mode: { enum: ['a', 'b'] },
        fixed: { const: 1 },
        either: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        one: { oneOf: [{ type: 'boolean' }, { type: 'number' }] },
      },
      required: ['name'],
      additionalProperties: false,
    };
    expect(() => checkSchema(schema)).not.toThrow();
  });

  it('rejects non-object schemas', () => {
    expect(() => checkSchema(null)).toThrow('schema_invalid');
    expect(() => checkSchema('string')).toThrow('schema_invalid');
    expect(() => checkSchema(42)).toThrow('schema_invalid');
    expect(() => checkSchema([])).toThrow('schema_invalid');
  });

  it('rejects $ref and format as unsupported keywords, naming the keyword', () => {
    expect(() => checkSchema({ $ref: '#' })).toThrow('unsupported_keyword:$ref');
    expect(() => checkSchema({ type: 'string', format: 'email' })).toThrow('unsupported_keyword:format');
  });

  it('fails closed on pattern with regex_unavailable', () => {
    expect(() => checkSchema({ type: 'string', pattern: '^a+$' })).toThrow('regex_unavailable');
  });

  it('finds unsupported keywords nested under properties, items, anyOf, oneOf and additionalProperties', () => {
    expect(() =>
      checkSchema({ type: 'object', properties: { a: { type: 'string', pattern: 'x' } } }),
    ).toThrow('regex_unavailable');
    expect(() =>
      checkSchema({ type: 'array', items: { type: 'string', format: 'uri' } }),
    ).toThrow('unsupported_keyword:format');
    expect(() => checkSchema({ anyOf: [{ type: 'string' }, { $ref: '#' }] })).toThrow(
      'unsupported_keyword:$ref',
    );
    expect(() => checkSchema({ oneOf: [{ type: 'string', pattern: 'a' }] })).toThrow(
      'regex_unavailable',
    );
    expect(() =>
      checkSchema({ type: 'object', additionalProperties: { type: 'string', pattern: 'a' } }),
    ).toThrow('regex_unavailable');
  });

  it('does not confuse property names with schema keywords', () => {
    const schema = {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        format: { type: 'string' },
        $ref: { type: 'string' },
      },
    };
    expect(() => checkSchema(schema)).not.toThrow();
  });

  it('rejects non-object subschemas', () => {
    expect(() => checkSchema({ type: 'object', properties: { a: 'string' } })).toThrow('schema_invalid');
    expect(() => checkSchema({ type: 'array', items: [{ type: 'string' }] })).toThrow('schema_invalid');
  });

  it('allows depth 8 and rejects depth 9', () => {
    expect(() => checkSchema(nest(8))).not.toThrow();
    expect(() => checkSchema(nest(9))).toThrow('schema_too_deep');
  });

  it('counts depth through items as well as properties', () => {
    let s: Record<string, unknown> = { type: 'string' };
    for (let i = 1; i < 9; i++) s = { type: 'array', items: s };
    expect(() => checkSchema(s)).toThrow('schema_too_deep');
  });
});

describe('ToolRegistry argument gating', () => {
  it('never invokes the tool function when arguments are schema-invalid', async () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'integer' } },
      required: ['a'],
      additionalProperties: false,
    };
    let calls = 0;
    const r = new ToolRegistry();
    r.register('count', 'd', schema, async () => {
      calls += 1;
      return calls;
    });

    const bad = await r.call('count', { a: 'x' });
    expect(bad.status).toBe('invalid_args');
    expect(bad.started).toBe(false);
    expect(calls).toBe(0);

    const good = await r.call('count', { a: 1 });
    expect(good.status).toBe('ok');
    expect(good.output).toBe(1);
    expect(calls).toBe(1);
  });
});
