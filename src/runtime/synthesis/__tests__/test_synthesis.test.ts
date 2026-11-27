import { describe, expect, it, vi } from 'vitest';
import {
  SYNTHESIS_ASSERTION_EXIT_CODE,
  SYNTHESIS_REASON_CODES,
  SynthesisBudgetPort,
  TestSynthesisController,
  resolveTestSynthesisConfig,
  validateTestSynthesisStartup,
} from '../index';

function makeBudget(overrides: Partial<SynthesisBudgetPort> = {}): SynthesisBudgetPort {
  return {
    reserveSynthesisAttempt: vi.fn(() => true),
    releaseSynthesisAttempt: vi.fn(),
    reserveCheckStepsAndDeadline: vi.fn(() => true),
    releaseCheckReserve: vi.fn(),
    hasActiveBlocker: vi.fn(() => false),
    ...overrides,
  };
}

describe('TestSynthesisConfig & startup validation', () => {
  it('rejects invalid attemptShare and incompatible co-mounts', () => {
    expect(() => resolveTestSynthesisConfig({ attemptShare: 0 })).toThrow();
    expect(() => resolveTestSynthesisConfig({ attemptShare: 0.51 })).toThrow();
    const cfg = resolveTestSynthesisConfig({ enabled: true, attemptShare: 0.25 });
    expect(() =>
      validateTestSynthesisStartup(cfg, {
        hasRunCodeTool: false,
        hasFiniteBudgets: true,
        coMountedFeatures: {},
      }),
    ).toThrow(/run_code/);
    expect(() =>
      validateTestSynthesisStartup(cfg, {
        hasRunCodeTool: true,
        hasFiniteBudgets: true,
        coMountedFeatures: { deliberation: true },
      }),
    ).toThrow(/deliberation/);
  });
});

describe('TestSynthesisController state machine', () => {
  it('reconciles a failing candidate and passes on reserved recheck', async () => {
    const cfg = resolveTestSynthesisConfig({ enabled: true, maxSynthesisRounds: 1 });
    const budget = makeBudget();
    let callNum = 0;
    const dispatch = vi.fn(async () => {
      callNum += 1;
      if (callNum === 1) {
        return {
          exitCode: SYNTHESIS_ASSERTION_EXIT_CODE,
          output: 'expected 42, got 41',
          durationMs: 12,
        };
      }
      return { exitCode: 0, output: 'ok', durationMs: 8 };
    });
    const infer = vi.fn(async () => ({
      rawText: JSON.stringify({
        checks: [
          {
            id: 'chk_1',
            kind: 'property',
            hypothesis: 'answer equals 42',
            code: 'synth_assert(CANDIDATE == "42")',
          },
        ],
      }),
    }));

    const ctrl = new TestSynthesisController('run_1', cfg, budget, dispatch, infer);
    const first = await ctrl.onCandidateFinalAnswer('41');
    expect(first.action).toBe('reconcile');
    if (first.action === 'reconcile') {
      expect(first.feedback.label).toBe('UNTRUSTED_SYNTHESIS_FEEDBACK');
      expect(first.feedback.rendered).toContain('chk_1');
    }
    expect(budget.releaseSynthesisAttempt).toHaveBeenCalledTimes(1);

    const second = await ctrl.onCandidateFinalAnswer('42');
    expect(second.action).toBe('proceed_to_finalizer');
    expect(second.record.outcome).toBe(SYNTHESIS_REASON_CODES.PASSED);
    expect(infer).toHaveBeenCalledTimes(1);
  });

  it('applies unreconciledPolicy without recheck when candidate is unchanged', async () => {
    const cfg = resolveTestSynthesisConfig({
      enabled: true,
      unreconciledPolicy: 'warn',
    });
    const budget = makeBudget();
    const dispatch = vi.fn(async () => ({
      exitCode: SYNTHESIS_ASSERTION_EXIT_CODE,
      output: 'still wrong',
      durationMs: 5,
    }));
    const infer = vi.fn(async () => ({
      rawText: JSON.stringify({
        checks: [{ id: 'c1', kind: 'differential', hypothesis: 'h', code: 'synth_assert(False)' }],
      }),
    }));

    const ctrl = new TestSynthesisController('run_2', cfg, budget, dispatch, infer);
    await ctrl.onCandidateFinalAnswer('bad');
    const second = await ctrl.onCandidateFinalAnswer('bad');
    expect(second.action).toBe('proceed_to_finalizer');
    if (second.action === 'proceed_to_finalizer') {
      expect(second.warning).toBe(SYNTHESIS_REASON_CODES.CHECKS_FAILED_WARN);
    }
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('treats non-assertion exits as check_error and all-error as inconclusive', async () => {
    const cfg = resolveTestSynthesisConfig({ enabled: true });
    const budget = makeBudget();
    const dispatch = vi.fn(async () => ({
      exitCode: 1,
      output: 'SyntaxError',
      durationMs: 5,
    }));
    const infer = vi.fn(async () => ({
      rawText: JSON.stringify({
        checks: [{ id: 'c1', kind: 'property', hypothesis: 'h', code: 'bad syntax(' }],
      }),
    }));

    const ctrl = new TestSynthesisController('run_3', cfg, budget, dispatch, infer);
    const res = await ctrl.onCandidateFinalAnswer('ok');
    expect(res.action).toBe('proceed_to_finalizer');
    expect(res.record.outcome).toBe(SYNTHESIS_REASON_CODES.INCONCLUSIVE);
  });

  it('handles blocked checks, malformed inference, and unknown usage', async () => {
    const cfg = resolveTestSynthesisConfig({ enabled: true });
    const budget = makeBudget();
    const dispatch = vi.fn(async () => ({
      blockedBy: 'approval_denied' as const,
      output: 'denied',
      durationMs: 1,
    }));
    const infer = vi.fn(async () => ({
      rawText: JSON.stringify({
        checks: [{ id: 'c1', kind: 'property', hypothesis: 'h', code: 'pass' }],
      }),
    }));

    const ctrl1 = new TestSynthesisController('run_4', cfg, budget, dispatch, infer);
    const blocked = await ctrl1.onCandidateFinalAnswer('x');
    expect(blocked.action).toBe('proceed_to_finalizer');
    expect(blocked.record.outcome).toBe(SYNTHESIS_REASON_CODES.BLOCKED);

    const ctrl2 = new TestSynthesisController(
      'run_5',
      cfg,
      budget,
      dispatch,
      vi.fn(async () => ({ rawText: 'not-json' })),
    );
    const rejected = await ctrl2.onCandidateFinalAnswer('x');
    expect(rejected.action).toBe('proceed_to_finalizer');
    expect(rejected.record.outcome).toBe(SYNTHESIS_REASON_CODES.REJECTED);

    const ctrl3 = new TestSynthesisController(
      'run_6',
      cfg,
      budget,
      dispatch,
      vi.fn(async () => ({ rawText: '{}', usageUnknown: true })),
    );
    const unknownUsage = await ctrl3.onCandidateFinalAnswer('x');
    expect(unknownUsage.action).toBe('publish_incomplete');
    expect(unknownUsage.record.outcome).toBe(SYNTHESIS_REASON_CODES.USAGE_UNKNOWN);
  });
});
