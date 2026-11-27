import { describe, expect, it } from 'vitest';
import {
  SYNTHESIS_ASSERTION_EXIT_CODE,
  TEST_SYNTHESIS_CAPS,
  buildSynthesisFeedback,
  computeDigest,
  resolveTestSynthesisConfig,
  truncateUtf8,
  validateTestSynthesisStartup,
  wrapCheckWithHostHarness,
} from '../index';

describe('TestSynthesisConfig resolution & startup', () => {
  it('applies defaults, freezes config, and clamps to hard caps', () => {
    const def = resolveTestSynthesisConfig();
    expect(Object.isFrozen(def)).toBe(true);
    expect(def.enabled).toBe(false);
    expect(def.maxSynthesisRounds).toBe(TEST_SYNTHESIS_CAPS.maxSynthesisRounds.default);
    expect(def.maxChecksPerRound).toBe(TEST_SYNTHESIS_CAPS.maxChecksPerRound.default);
    expect(def.unreconciledPolicy).toBe('incomplete');
    expect(def.attemptShare).toBe(TEST_SYNTHESIS_CAPS.attemptShare.default);

    const clamped = resolveTestSynthesisConfig({
      enabled: true,
      maxSynthesisRounds: 99,
      maxChecksPerRound: 99,
      unreconciledPolicy: 'warn',
    });
    expect(clamped.maxSynthesisRounds).toBe(TEST_SYNTHESIS_CAPS.maxSynthesisRounds.hard);
    expect(clamped.maxChecksPerRound).toBe(TEST_SYNTHESIS_CAPS.maxChecksPerRound.hard);
    expect(clamped.unreconciledPolicy).toBe('warn');
  });

  it('rejects invalid integer bounds and invalid unreconciledPolicy', () => {
    expect(() => resolveTestSynthesisConfig({ maxSynthesisRounds: 0 })).toThrow();
    expect(() => resolveTestSynthesisConfig({ maxChecksPerRound: 1.5 })).toThrow();
    expect(() =>
      resolveTestSynthesisConfig({ unreconciledPolicy: 'invalid' as 'incomplete' }),
    ).toThrow();
  });

  it('validates finite budgets on startup when enabled', () => {
    const cfg = resolveTestSynthesisConfig({ enabled: true });
    expect(() =>
      validateTestSynthesisStartup(cfg, {
        hasRunCodeTool: true,
        hasFiniteBudgets: false,
        coMountedFeatures: {},
      }),
    ).toThrow();

    expect(() =>
      validateTestSynthesisStartup(cfg, {
        hasRunCodeTool: true,
        hasFiniteBudgets: true,
        coMountedFeatures: {},
      }),
    ).not.toThrow();
  });
});

describe('TestSynthesis harness helpers', () => {
  it('computes deterministic sha256 digests', () => {
    const d1 = computeDigest('candidate-a');
    const d2 = computeDigest('candidate-a');
    const d3 = computeDigest('candidate-b');
    expect(d1).toHaveLength(64);
    expect(d1).toBe(d2);
    expect(d1).not.toBe(d3);
  });

  it('truncates utf8 strings within maxBytes with marker', () => {
    const short = truncateUtf8('hello', 32);
    expect(short).toEqual({ text: 'hello', truncated: false });

    const long = truncateUtf8('a'.repeat(100), 30);
    expect(long.truncated).toBe(true);
    expect(long.text.endsWith('...[truncated]')).toBe(true);
    expect(Buffer.byteLength(long.text, 'utf8')).toBeLessThanOrEqual(30);

    const tiny = truncateUtf8('abcdefghij', 4);
    expect(tiny.truncated).toBe(true);
    expect(Buffer.byteLength(tiny.text, 'utf8')).toBeLessThanOrEqual(4);
  });

  it('wraps check code with host-pinned CANDIDATE and assertion exit code', () => {
    const wrapped = wrapCheckWithHostHarness('{"answer":42}', 'synth_assert(True)');
    expect(wrapped).toContain('CANDIDATE = json.loads(');
    expect(wrapped).toContain(`SYNTHESIS_ASSERTION_EXIT_CODE = ${SYNTHESIS_ASSERTION_EXIT_CODE}`);
    expect(wrapped).toContain('def synth_assert(cond, msg="assertion failed"):');
    expect(wrapped).toContain('synth_assert(True)');
  });

  it('builds untrusted-labeled synthesis feedback within maxFeedbackBytes', () => {
    const feedback = buildSynthesisFeedback(
      1,
      [
        {
          id: 'chk-1',
          hypothesis: 'answer must be positive',
          result: {
            id: 'chk-1',
            kind: 'property',
            outcome: 'check_failed',
            call_id: 'call-1',
            output: 'got -1',
            durationMs: 5,
          },
        },
      ],
      512,
    );
    expect(feedback.round).toBe(1);
    expect(feedback.text).toContain('[UNTRUSTED_SYNTHESIS_FEEDBACK round=1]');
    expect(feedback.text).toContain('[/UNTRUSTED_SYNTHESIS_FEEDBACK]');
    expect(Buffer.byteLength(feedback.text, 'utf8')).toBeLessThanOrEqual(512);
  });
});
