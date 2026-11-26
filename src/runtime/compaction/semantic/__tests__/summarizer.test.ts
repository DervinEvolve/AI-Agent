import { describe, it, expect } from 'vitest';
import { SemanticSummarizer, cutUtf8 } from '../summarizer';
import { resolveSemanticConfig } from '../types';

function make(resp: any, opts: any = {}) {
  let reserved = 0;
  let released = 0;
  const s = new SemanticSummarizer({
    config: resolveSemanticConfig({ enabled: true, ...opts }),
    admission: {
      reserve: () => {
        if (opts.refuse) return false;
        reserved++;
        return true;
      },
      release: () => {
        released++;
      },
    },
    call: async () => {
      if (resp instanceof Error) throw resp;
      return resp;
    },
    timeout: () => new Promise(() => {}),
  });
  return { s, counts: () => ({ reserved, released }) };
}
const groups = [{ callId: 'a', text: 'hello' }];

describe('semantic summarizer', () => {
  it('produces non-citable record and releases once', async () => {
    const { s, counts } = make({ text: 'sum' });
    const r = await s.summarize(groups);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.citable).toBe(false);
      expect(r.record.exposing).toBe(false);
      expect(r.record.coveredCallIds).toEqual(['a']);
    }
    expect(counts()).toEqual({ reserved: 1, released: 1 });
  });
  it('rejects tool_calls and empty', async () => {
    expect((await make({ text: 'x', tool_calls: [{}] }).s.summarize(groups)) as any).toMatchObject({ reason: 'summary_rejected' });
    expect((await make({ text: ' ' }).s.summarize(groups)) as any).toMatchObject({ reason: 'summary_rejected' });
  });
  it('falls back on failure with release', async () => {
    const m = make(new Error('x'));
    expect(await m.s.summarize(groups)).toEqual({ ok: false, reason: 'summary_failed' });
    expect(m.counts().released).toBe(1);
  });
  it('refuses on admission and enforces cap', async () => {
    expect(await make({ text: 'a' }, { refuse: true }).s.summarize(groups)).toEqual({ ok: false, reason: 'admission_refused' });
    const m = make({ text: '' }, { maxSummariesPerRun: 1 });
    await m.s.summarize(groups);
    expect(await m.s.summarize(groups)).toEqual({ ok: false, reason: 'cap_reached' });
  });
  it('cuts on utf8 boundary', () => {
    expect(cutUtf8('ééé', 3)).toBe('é');
  });
  it('rejects bad config', () => {
    expect(() => resolveSemanticConfig({ summaryMaxBytes: 99999 })).toThrow();
  });
});
