import { describe, expect, it } from 'vitest';
import {
  buildFeedback,
  canStartRound,
  computeReserve,
  isRepairable,
  isStale,
  renderFeedback,
  validateRepairConfig,
} from '../policy';
import type { RepairConfig, VerdictBinding } from '../types';

const cfg = (over: Partial<RepairConfig> = {}): RepairConfig => ({
  enabled: true,
  maxRepairRounds: 2,
  verifierKind: 'model_backed',
  perCheck: { steps: 2, attempts: 1, tokens: 50, cost: 0.05, timeoutMs: 250 },
  verifierReserveShare: 0.2,
  maxFeedbackBytes: 48,
  maxRecordBytes: 4096,
  criteria: {
    visible: { exposed: true, diagnostic_template: 'visible diagnostic text here' },
    hidden: { exposed: false, diagnostic_template: 'SECRET_EXPECTED_42' },
  },
  ...over,
});

const bind = (over: Partial<VerdictBinding> = {}): VerdictBinding => ({
  candidateDigest: 'dig-a',
  workspaceGeneration: 1,
  contractDigest: 'ctr-1',
  ...over,
});

describe('repair feedback and stale verdicts', () => {
  it('renders only exposed criterion ids and truncates diagnostics to the byte budget', () => {
    const fb = buildFeedback(
      cfg(),
      [
        { criterion_id: 'visible', passed: false },
        { criterion_id: 'hidden', passed: false },
        { criterion_id: 'also_hidden', passed: false },
      ],
      1,
    );
    expect(fb.entries.map((e) => e.criterion_id)).toEqual(['visible']);
    expect(fb.entries.every((e) => e.passed === false)).toBe(true);
    expect(fb.unexposedFailedCount).toBe(2);
    expect(fb.roundsUsed).toBe(1);
    expect(fb.maxRounds).toBe(2);
    const text = renderFeedback(fb);
    expect(text).toContain('visible');
    expect(text).not.toContain('SECRET_EXPECTED_42');
    expect(text).not.toContain('hidden');
    const used = new TextEncoder().encode(
      fb.entries.map((e) => e.diagnostic).join(''),
    ).length;
    expect(used).toBeLessThanOrEqual(48);
    expect(fb.omittedCount).toBeGreaterThanOrEqual(0);
  });

  it('treats a digest or generation mismatch as stale and withholds non-fail verdicts from repair', () => {
    const current = bind();
    expect(isStale(bind(), current)).toBe(false);
    expect(isStale(bind({ candidateDigest: 'dig-b' }), current)).toBe(true);
    expect(isStale(bind({ workspaceGeneration: 2 }), current)).toBe(true);
    expect(isStale(bind({ contractDigest: 'other' }), current)).toBe(true);

    expect(isRepairable('fail', true)).toBe(true);
    expect(isRepairable('pass', true)).toBe(false);
    expect(isRepairable('fail', false)).toBe(false);
    for (const kind of ['unverifiable', 'infrastructure_error', 'abort'] as const) {
      expect(isRepairable(kind, true)).toBe(false);
    }
  });

  it('rejects a round when remaining cannot cover the frozen reserve plus one repair step', () => {
    const remaining = { steps: 20, attempts: 10, tokens: 1000, cost: 1, timeoutMs: 5000 };
    const reserve = computeReserve(cfg(), remaining);
    expect(reserve.steps).toBe(Math.max(Math.ceil(20 * 0.2), 2 * 2));
    expect(reserve.timeoutMs).toBe(2 * 250);
    expect(canStartRound(remaining, reserve)).toBe(true);
    expect(canStartRound({ ...remaining, steps: reserve.steps }, reserve)).toBe(false);
    expect(canStartRound({ ...remaining, timeoutMs: reserve.timeoutMs }, reserve)).toBe(false);

    const errs = validateRepairConfig(cfg({ verifierKind: 'deterministic' }), {
      hasTaskContract: true,
      finiteBudgets: true,
      mounted: [60, 74],
    });
    expect(errs).toEqual(
      expect.arrayContaining([
        'deterministic_check_must_be_free',
        'forbidden_comount_60',
        'forbidden_comount_74',
      ]),
    );
  });
});
