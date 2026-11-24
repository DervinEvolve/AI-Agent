import { describe, it, expect } from 'vitest';
import { validateProgram, resolvePointer } from '../types';

describe('programs', () => {
  const ok = { version: 1, steps: [{ id: 'a', op: { kind: 'call', tool: 't', args: {} } }] };
  it('accepts valid', () => expect(validateProgram(ok).ok).toBe(true));
  it('rejects duplicate ids', () => {
    const p = { version: 1, steps: [ok.steps[0], ok.steps[0]] };
    expect(validateProgram(p).ok).toBe(false);
  });
  it('rejects too many calls', () => {
    const p = { version: 1, steps: [{ id: 'm', op: { kind: 'map', over: 1, tool: 't', args_template: {}, limit: 16 } }] };
    expect(validateProgram(p, { maxInnerCalls: 8 }).ok).toBe(false);
  });
  it('resolves pointers safely', () => {
    expect(resolvePointer({ 'a/b': [1, 2] }, '/a~1b/1')).toEqual({ ok: true, value: 2 });
    expect(resolvePointer({}, '/__proto__').ok).toBe(false);
    expect(resolvePointer([1], '/-').ok).toBe(false);
    expect(resolvePointer({}, '/toString').ok).toBe(false);
  });
});
