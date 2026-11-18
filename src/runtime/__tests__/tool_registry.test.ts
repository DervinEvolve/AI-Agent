import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../tool_registry';

const schema = { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'], additionalProperties: false };

describe('ToolRegistry', () => {
  it('runs a tool', async () => {
    const r = new ToolRegistry();
    r.register('dbl', 'd', schema, async (x) => (x.a as number) * 2);
    const res = await r.call('dbl', { a: 2 });
    expect(res.status).toBe('ok');
    expect(res.output).toBe(4);
    expect(res.call_id).toBeTruthy();
  });
  it('rejects invalid args without starting', async () => {
    const r = new ToolRegistry();
    r.register('dbl', 'd', schema, async () => 1);
    const res = await r.call('dbl', { a: 'x' });
    expect(res.status).toBe('invalid_args');
    expect(res.started).toBe(false);
  });
  it('unknown tool errors', async () => {
    const res = await new ToolRegistry().call('nope', {});
    expect(res.status).toBe('error');
    expect(res.started).toBe(false);
  });
  it('rejects $ref, pattern, duplicates', () => {
    const r = new ToolRegistry();
    expect(() => r.register('x', 'd', { $ref: '#' }, async () => 1)).toThrow();
    expect(() => r.register('y', 'd', { type: 'string', pattern: 'a' }, async () => 1)).toThrow('regex_unavailable');
    r.register('z', 'd', schema, async () => 1);
    expect(() => r.register('z', 'd', schema, async () => 1)).toThrow('duplicate_tool');
  });
  it('times out with unconfirmed termination', async () => {
    const r = new ToolRegistry();
    r.register('slow', 'd', { type: 'object' }, () => new Promise(() => {}), false, 0.05);
    const res = await r.call('slow', {});
    expect(res.status).toBe('timeout');
    expect(res.termination_confirmed).toBe(false);
  });
});
