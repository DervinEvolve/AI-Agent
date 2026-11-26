import { describe, it, expect } from 'vitest';
import { cutUtf8 } from '../summarizer';
import {
  resolveSemanticConfig,
  DEFAULT_SEMANTIC_COMPACTION_CONFIG,
  SEMANTIC_COMPACTION_HARD_CAPS,
  MAX_COVERED_CALL_IDS,
} from '../types';

describe('cutUtf8', () => {
  it('returns input unchanged when within limit', () => {
    expect(cutUtf8('héllo', 6)).toBe('héllo');
  });
  it('never splits a multibyte character', () => {
    expect(cutUtf8('héllo', 2)).toBe('h');
    expect(cutUtf8('héllo', 3)).toBe('hé');
    expect(cutUtf8('😀', 3)).toBe('');
  });
  it('output never exceeds byte cap', () => {
    const out = cutUtf8('ééééé', 5);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(5);
    expect(out).toBe('éé');
  });
});

describe('semantic config', () => {
  it('is disabled by default with spec defaults', () => {
    expect(DEFAULT_SEMANTIC_COMPACTION_CONFIG.enabled).toBe(false);
    expect(DEFAULT_SEMANTIC_COMPACTION_CONFIG.summaryMaxBytes).toBe(2048);
    expect(DEFAULT_SEMANTIC_COMPACTION_CONFIG.maxSummariesPerRun).toBe(8);
    expect(MAX_COVERED_CALL_IDS).toBe(32);
  });
  it('rejects values above hard caps or non-positive', () => {
    expect(() => resolveSemanticConfig({ summaryMaxBytes: SEMANTIC_COMPACTION_HARD_CAPS.summaryMaxBytes + 1 })).toThrow();
    expect(() => resolveSemanticConfig({ maxRetainedSummaries: 9 })).toThrow();
    expect(() => resolveSemanticConfig({ summarizerInferenceShare: 0.51 })).toThrow();
    expect(() => resolveSemanticConfig({ maxSummariesPerRun: 0 })).toThrow();
  });
});
