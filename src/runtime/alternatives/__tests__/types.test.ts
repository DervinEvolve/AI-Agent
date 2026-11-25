import { describe, it, expect } from 'vitest';
import {
  ALTERNATIVES_CAPS,
  ALTERNATIVES_REASONS,
  boundAttemptResult,
  classifyDiff,
  classifyScore,
  computeEligibility,
  discardRefusal,
  isPublicationUnresolved,
  isValidTask,
  matchProtectedPath,
  normalizePathComponents,
  parentUnchanged,
  planAttemptReservation,
  rankAlternatives,
  reconcilePublication,
  resolveAlternativesCaps,
  startupRejections,
  truncateUtf8Bytes,
  utf8ByteLength,
  type AttemptReport,
  type PublicationRecord,
} from '../types';

const encoder = new TextEncoder();

function report(overrides: Partial<AttemptReport> = {}): AttemptReport {
  return {
    sealed: true,
    alt_id: 'alt_1',
    child_outcome: 'completed',
    snapshot_digest: 'sha256:aaa',
    check_manifest_digest: 'sha256:mmm',
    changed_bytes: 10,
    changed_paths: ['src/a.ts'],
    protected_path_modified: false,
    unsafe_entry: false,
    tainted: false,
    score: { status: 'passed', passed_count: 3, failed_count: 0 },
    child_citations: [],
    cleanup_confirmed: false,
    ...overrides,
  };
}

describe('truncateUtf8Bytes', () => {
  it('agrees with TextEncoder on byte length', () => {
    for (const s of ['', 'abc', '目录', 'a😀b', 'é', '\ud800x']) {
      expect(utf8ByteLength(s)).toBe(encoder.encode(s).length);
    }
  });

  it('never splits a code point or surrogate pair', () => {
    expect(truncateUtf8Bytes('a😀b', 4)).toEqual({ text: 'a', bytes: 1, truncated: true });
    expect(truncateUtf8Bytes('a😀b', 5)).toEqual({ text: 'a😀', bytes: 5, truncated: true });
    expect(truncateUtf8Bytes('a😀b', 6)).toEqual({ text: 'a😀b', bytes: 6, truncated: false });
    expect(truncateUtf8Bytes('目录', 5).text).toBe('目');
  });

  it('treats non-positive or non-finite budgets as zero', () => {
    expect(truncateUtf8Bytes('abc', 0).text).toBe('');
    expect(truncateUtf8Bytes('abc', -1).text).toBe('');
    expect(truncateUtf8Bytes('abc', Number.NaN).text).toBe('');
  });

  it('validates task byte length', () => {
    expect(isValidTask('')).toBe(false);
    expect(isValidTask('x'.repeat(ALTERNATIVES_CAPS.taskMaxBytes))).toBe(true);
    expect(isValidTask('x'.repeat(ALTERNATIVES_CAPS.taskMaxBytes + 1))).toBe(false);
    expect(isValidTask('目'.repeat(1366))).toBe(false);
    expect(isValidTask(42)).toBe(false);
  });
});

describe('matchProtectedPath', () => {
  it('matches by component, not string prefix', () => {
    expect(matchProtectedPath('tests2/x.ts', ['tests/'])).toBe(false);
    expect(matchProtectedPath('tests/x.ts', ['tests/'])).toBe(true);
    expect(matchProtectedPath('tests', ['tests'])).toBe(true);
    expect(matchProtectedPath('src/tests/x.ts', ['tests'])).toBe(false);
    expect(matchProtectedPath('vitest.config.ts.bak', ['vitest.config.ts'])).toBe(false);
  });

  it('normalizes before matching', () => {
    expect(matchProtectedPath('tests/../tests/x', ['tests'])).toBe(true);
    expect(matchProtectedPath('./tests//x', ['tests'])).toBe(true);
    expect(matchProtectedPath('tests\\x', ['tests'])).toBe(true);
    expect(matchProtectedPath('src/../tests/x', ['./tests/'])).toBe(true);
    expect(matchProtectedPath('tests/../src/x', ['tests'])).toBe(false);
  });

  it('fails closed on escapes', () => {
    expect(normalizePathComponents('a/../../b')).toBeNull();
    expect(matchProtectedPath('../outside', ['tests'])).toBe(true);
    expect(matchProtectedPath('src/x', ['../bad'])).toBe(true);
  });

  it('detects renames into protected paths, symlinks and mode changes', () => {
    const prot = ['tests', 'vitest.config.ts'];
    expect(classifyDiff([{ kind: 'renamed', from_path: 'src/a.ts', path: 'tests/a.ts' }], prot)).toEqual({
      protected_path_modified: true,
      unsafe_entry: false,
    });
    expect(classifyDiff([{ kind: 'renamed', from_path: 'tests/a.ts', path: 'src/a.ts' }], prot).protected_path_modified).toBe(true);
    expect(classifyDiff([{ kind: 'mode_changed', path: 'vitest.config.ts' }], prot).protected_path_modified).toBe(true);
    expect(classifyDiff([{ kind: 'added', path: 'src/link', entry_type: 'symlink' }], prot)).toEqual({
      protected_path_modified: false,
      unsafe_entry: true,
    });
    expect(classifyDiff([{ kind: 'modified', path: 'src/a.ts', entry_type: 'file' }], prot)).toEqual({
      protected_path_modified: false,
      unsafe_entry: false,
    });
  });
});

describe('scoring and eligibility', () => {
  it('zero or too few executed checks is no_tests, never a pass', () => {
    expect(classifyScore({ passed_count: 0, failed_count: 0 }).status).toBe('no_tests');
    expect(classifyScore({ passed_count: 2, failed_count: 0, minExpectedChecks: 3 }).status).toBe('no_tests');
    expect(classifyScore({ passed_count: 3, failed_count: 0, minExpectedChecks: 3 }).status).toBe('passed');
    expect(classifyScore({ passed_count: 3, failed_count: 1 }).status).toBe('failed');
    expect(classifyScore({ passed_count: 3, failed_count: 0, infra_error: true }).status).toBe('infra_error');
  });

  it('requires every eligibility condition', () => {
    expect(computeEligibility(report())).toBe(true);
    expect(computeEligibility(report({ sealed: false }))).toBe(false);
    expect(computeEligibility(report({ tainted: true }))).toBe(false);
    expect(computeEligibility(report({ protected_path_modified: true }))).toBe(false);
    expect(computeEligibility(report({ unsafe_entry: true }))).toBe(false);
    expect(computeEligibility(report({ unresolved_unknown: true }))).toBe(false);
    expect(computeEligibility(report({ score: { status: 'no_tests', passed_count: 0, failed_count: 0 } }))).toBe(false);
  });
});

describe('rankAlternatives', () => {
  const mk = (alt_id: string, eligible: boolean, failed_count: number, changed_bytes: number) => ({
    alt_id,
    eligible,
    changed_bytes,
    score: { failed_count },
  });

  it('orders eligible first, then fewer failed, then fewer bytes', () => {
    const ranked = rankAlternatives([
      mk('alt_1', false, 0, 1),
      mk('alt_2', true, 0, 500),
      mk('alt_3', true, 0, 100),
      mk('alt_4', false, 2, 1),
    ]);
    expect(ranked.map((a) => a.alt_id)).toEqual(['alt_3', 'alt_2', 'alt_1', 'alt_4']);
  });

  it('is deterministic at ties and does not mutate its input', () => {
    const a = mk('alt_a', true, 0, 10);
    const b = mk('alt_b', true, 0, 10);
    const input = [b, a];
    expect(rankAlternatives(input).map((x) => x.alt_id)).toEqual(['alt_a', 'alt_b']);
    expect(rankAlternatives([a, b]).map((x) => x.alt_id)).toEqual(['alt_a', 'alt_b']);
    expect(input[0]).toBe(b);
  });
});

describe('boundAttemptResult', () => {
  it('keeps 300 long multibyte paths within the transcript cap', () => {
    const paths = Array.from({ length: 300 }, (_, i) => `源代码/${'目录'.repeat(45)}/文件${i}.ts`);
    const citations = Array.from({ length: 20 }, (_, i) => ({
      child_call_id: `child_call_${i}`,
      tool: 'write_file',
      success: true,
      workspace_scope: { alt_id: 'alt_1', snapshot_digest: 'sha256:aaa' },
    }));
    const view = boundAttemptResult(report({ changed_paths: paths, child_citations: citations }));
    const serialized = JSON.stringify(view);

    expect(encoder.encode(serialized).length).toBeLessThanOrEqual(ALTERNATIVES_CAPS.transcriptMaxBytes);
    expect(serialized).not.toContain('\ufffd');
    expect(view.changed_path_count).toBe(300);
    expect(view.changed_paths.length).toBeGreaterThan(0);
    expect(view.changed_paths.length).toBeLessThan(ALTERNATIVES_CAPS.changedPathsMaxItems);
    expect(view.elided_count).toBe(300 - view.changed_paths.length);
    view.changed_paths.forEach((p, i) => {
      expect(encoder.encode(p).length).toBeLessThanOrEqual(ALTERNATIVES_CAPS.changedPathMaxBytes);
      expect((paths[i] as string).startsWith(p)).toBe(true);
    });
    expect(view.child_citations.length).toBeLessThanOrEqual(ALTERNATIVES_CAPS.citationsMaxItems);
    expect(view.citation_elided_count).toBe(20 - view.child_citations.length);
    for (const c of view.child_citations) {
      expect(c.workspace_scope).toEqual({ alt_id: 'alt_1', snapshot_digest: 'sha256:aaa' });
    }
  });

  it('elides oversized citation descriptors whole and counts them', () => {
    const big = {
      child_call_id: 'x'.repeat(600),
      tool: 'edit_file',
      success: true,
      workspace_scope: { alt_id: 'alt_1', snapshot_digest: 'sha256:aaa' },
    };
    const small = { ...big, child_call_id: 'c1' };
    const view = boundAttemptResult(report({ child_citations: [big, small] }));
    expect(view.child_citations).toEqual([small]);
    expect(view.citation_elided_count).toBe(1);
  });

  it('passes small reports through and derives ok and eligible', () => {
    const view = boundAttemptResult(report());
    expect(view.ok).toBe(true);
    expect(view.eligible).toBe(true);
    expect(view.elided_count).toBe(0);
    expect(view.citation_elided_count).toBe(0);
    expect(view.changed_paths).toEqual(['src/a.ts']);

    const tainted = boundAttemptResult(report({ sealed: false, tainted: true }));
    expect(tainted.ok).toBe(false);
    expect(tainted.eligible).toBe(false);
  });

  it('drops citations only after all paths when still over budget', () => {
    const citations = Array.from({ length: 16 }, (_, i) => ({
      child_call_id: `${i}`.padStart(2, '0') + 'y'.repeat(400),
      tool: 'write_file',
      success: true,
      workspace_scope: { alt_id: 'alt_1', snapshot_digest: 'sha256:aaa' },
    }));
    const paths = Array.from({ length: 32 }, (_, i) => `src/${'p'.repeat(240)}${i}`);
    const view = boundAttemptResult(report({ changed_paths: paths, child_citations: citations }));
    expect(encoder.encode(JSON.stringify(view)).length).toBeLessThanOrEqual(ALTERNATIVES_CAPS.transcriptMaxBytes);
    expect(view.elided_count + view.changed_paths.length).toBe(32);
    expect(view.citation_elided_count + view.child_citations.length).toBe(16);
    if (view.citation_elided_count > 0) expect(view.changed_paths.length).toBe(0);
  });
});

describe('publication record helpers', () => {
  const base = { base_generation: 1, base_digest: 'sha256:base' };
  const prepared: PublicationRecord = { state: 'prepared', alt_id: 'alt_1', digest: 'd', expected_base: base };
  const published: PublicationRecord = { state: 'published', alt_id: 'alt_1', digest: 'd', new_generation: 2 };

  it('reconciles from the record only', () => {
    expect(reconcilePublication(published)).toBe('published');
    expect(reconcilePublication({ state: 'not_published' })).toBe('not_published');
    expect(reconcilePublication(prepared)).toBe('unresolved');
    expect(reconcilePublication({ state: 'unresolved' })).toBe('unresolved');
    expect(reconcilePublication({ state: 'none' })).toBe('unresolved');
  });

  it('blocks abandon while prepared or unresolved', () => {
    expect(isPublicationUnresolved(prepared)).toBe(true);
    expect(isPublicationUnresolved({ state: 'unresolved' })).toBe(true);
    expect(isPublicationUnresolved(published)).toBe(false);
    expect(isPublicationUnresolved({ state: 'none' })).toBe(false);
  });

  it('reports parent_unchanged only for none or not_published', () => {
    expect(parentUnchanged({ state: 'none' })).toBe(true);
    expect(parentUnchanged({ state: 'not_published' })).toBe(true);
    expect(parentUnchanged(published)).toBe(false);
    expect(parentUnchanged(prepared)).toBe(false);
  });

  it('refuses to discard a snapshot the record names', () => {
    expect(discardRefusal(published, 'alt_1')).toBe(ALTERNATIVES_REASONS.snapshot_owned);
    expect(discardRefusal(published, 'alt_2')).toBeNull();
    expect(discardRefusal(prepared, 'alt_1')).toBe(ALTERNATIVES_REASONS.snapshot_owned);
    expect(discardRefusal({ state: 'unresolved' }, 'alt_2')).toBe(ALTERNATIVES_REASONS.snapshot_owned);
    expect(discardRefusal({ state: 'unresolved', alt_id: 'alt_1' }, 'alt_2')).toBeNull();
    expect(discardRefusal({ state: 'none' }, 'alt_1')).toBeNull();
  });
});

describe('caps, reservation and startup', () => {
  it('resolves defaults and rejects out-of-range overrides', () => {
    const res = resolveAlternativesCaps();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.caps.maxAlternatives).toBe(ALTERNATIVES_CAPS.maxAlternatives.default);
    expect(res.caps.maxSteps).toBe(ALTERNATIVES_CAPS.maxSteps.default);
    expect(resolveAlternativesCaps({ maxAlternatives: 3 })).toEqual({
      ok: false,
      reason: ALTERNATIVES_REASONS.config_invalid,
      field: 'maxAlternatives',
    });
    expect(resolveAlternativesCaps({ parentStepReserve: 1 }).ok).toBe(false);
    expect(resolveAlternativesCaps({ checkTimeoutMs: ALTERNATIVES_CAPS.checkTimeoutMs.max }).ok).toBe(true);
    expect(resolveAlternativesCaps({ maxSteps: 1.5 }).ok).toBe(false);
  });

  it('reserves steps and allowance or refuses holding nothing', () => {
    const res = resolveAlternativesCaps();
    if (!res.ok) throw new Error('defaults must resolve');
    const caps = res.caps;
    expect(planAttemptReservation({ parentStepsRemaining: 16, recoveryPoolRemaining: 2, caps })).toEqual({
      ok: true,
      reserved_steps: 12,
      reserved_allowance: 1,
    });
    expect(planAttemptReservation({ parentStepsRemaining: 15, recoveryPoolRemaining: 2, caps })).toEqual({
      ok: false,
      started: false,
      reason: ALTERNATIVES_REASONS.alternative_budget_exceeded,
    });
    expect(planAttemptReservation({ parentStepsRemaining: 100, recoveryPoolRemaining: 0, caps })).toMatchObject({
      ok: false,
      reason: ALTERNATIVES_REASONS.alternative_budget_exceeded,
    });
    expect(
      planAttemptReservation({ parentStepsRemaining: 9, recoveryPoolRemaining: 2, requestedMaxSteps: 5, caps }),
    ).toMatchObject({ ok: true, reserved_steps: 5 });
    expect(
      planAttemptReservation({ parentStepsRemaining: 100, recoveryPoolRemaining: 2, requestedMaxSteps: 25, caps }),
    ).toMatchObject({ ok: false, reason: ALTERNATIVES_REASONS.config_invalid });
  });

  it('rejects co-mounts and a missing isolated check backend at startup', () => {
    expect(startupRejections({ isolatedCheckBackend: true })).toEqual([]);
    expect(startupRejections({ isolatedCheckBackend: true, egressProfile: 'none' })).toEqual([]);
    expect(startupRejections({})).toEqual(['isolated_check_backend_missing']);
    expect(
      startupRejections({ isolatedCheckBackend: true, durableRun: true, guiControl: true, egressProfile: 'web' }),
    ).toEqual(['durable_run', 'gui_control', 'egress_profile']);
  });
});
