import { describe, it, expect } from 'vitest';
import {
  buildFeedback,
  canStartRound,
  computeReserve,
  isRepairable,
  isStale,
  renderFeedback,
  validateRepairConfig,
} from '../policy';
import { RepairConfig } from '../types';

const base = (over: Partial<RepairConfig> = {}): RepairConfig => ({
  enabled: true,
  maxRepairRounds: 2,
  verifierKind: 'model_backed',
  perCheck: { steps: 1, attempts: 1, tokens: 100, cost: 0.01, timeoutMs: 1000 },
  verifierReserveShare: 0.2,
  maxFeedbackBytes: 64,
  maxRecordBytes: 4096,
  criteria: {
    a: { exposed: true, diagnostic_template: 'file a is wrong' },
    b: { exposed: false, diagnostic_template: 'secret expected' },
  },
  ...over,
});
const rem = { steps: 50, attempts: 40, tokens: 10000, cost: 1, timeoutMs: 60000 };

describe('repair policy', () => {
  it('model-backed reserve uses ceil(share) and per-check floor', () => {
    const r = computeReserve(base(), rem);
    expect(r.steps).toBe(10);
    expect(r.attempts).toBe(8);
    expect(r.tokens).toBe(2000);
    expect(r.timeoutMs).toBe(2000);
    const small = computeReserve(base(), { ...rem, steps: 3 });
    expect(small.steps).toBe(2);
  });
  it('deterministic reserve is zero except deadline', () => {
    const r = computeReserve(
      base({ verifierKind: 'deterministic', perCheck: { steps: 0, attempts: 0, tokens: 0, cost: 0, timeoutMs: 500 } }),
      rem,
    );
    expect([r.steps, r.attempts, r.tokens, r.cost]).toEqual([0, 0, 0, 0]);
    expect(r.timeoutMs).toBe(1000);
  });
  it('skips a round that cannot fund reserve plus one step', () => {
    const r = computeReserve(base(), rem);
    expect(canStartRound(rem, r)).toBe(true);
    expect(canStartRound({ ...rem, steps: 10 }, r)).toBe(false);
  });
  it('validates config and co-mounts', () => {
    const ok = { hasTaskContract: true, finiteBudgets: true };
    expect(validateRepairConfig(base(), ok)).toEqual([]);
    expect(validateRepairConfig(base({ maxRepairRounds: 3 }), ok)).toContain('bad_max_repair_rounds');
    expect(validateRepairConfig(base(), { ...ok, hasTaskContract: false })).toContain('missing_task_contract');
    expect(validateRepairConfig(base(), { ...ok, mounted: [60, 74] })).toEqual(['forbidden_comount_60', 'forbidden_comount_74']);
  });
  it('only fail is repairable; stale detection', () => {
    expect(isRepairable('fail')).toBe(true);
    for (const v of ['pass', 'unverifiable', 'infrastructure_error', 'abort'] as const) {
      expect(isRepairable(v)).toBe(false);
    }
    const b = { candidateDigest: 'x', workspaceGeneration: 1, contractDigest: 'c' };
    expect(isStale(b, { ...b })).toBe(false);
    expect(isStale(b, { ...b, workspaceGeneration: 2 })).toBe(true);
    expect(isStale(b, { ...b, candidateDigest: 'y' })).toBe(true);
  });
  it('feedback exposes only exposed ids, counts the rest, caps bytes', () => {
    const f = buildFeedback(['a', 'b', 'zzz'], base(), 1);
    expect(f.entries.map((e) => e.criterion_id)).toEqual(['a']);
    expect(f.unexposedFailedCount).toBe(2);
    const text = renderFeedback(f);
    expect(text).not.toContain('secret expected');
    expect(text).toContain('UNTRUSTED DATA');
    const tiny = buildFeedback(['a'], base({ maxFeedbackBytes: 8 }), 1);
    const total = tiny.entries.reduce((n, e) => n + e.criterion_id.length + 1 + e.diagnostic.length, 0);
    expect(total).toBeLessThanOrEqual(8);
  });
});
