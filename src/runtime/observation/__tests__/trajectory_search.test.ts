import {
  NON_SEARCHABLE_METADATA,
  OBSERVATION_SEARCH_REASON_CODES,
  SEARCH_OBSERVATIONS_TOOL_METADATA,
  SEARCH_OBSERVATIONS_TOOL_NAME,
  TRAJECTORY_SEARCH_CAPS,
  createSearchObservationsToolSpec,
  createSearchResultMetadata,
  resolveTrajectorySearchConfig,
  searchObservationSnapshot,
  type ObservationSearchEntry,
} from '../index.js';

describe('cap_trajectory_search_81', () => {
  it('resolves and freezes default configuration with disabled=true by default', () => {
    const cfg = resolveTrajectorySearchConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.maxResults).toBe(TRAJECTORY_SEARCH_CAPS.DEFAULT_MAX_RESULTS);
    expect(cfg.maxSnippetChars).toBe(TRAJECTORY_SEARCH_CAPS.DEFAULT_MAX_SNIPPET_CHARS);
    expect(cfg.maxQueryBytes).toBe(TRAJECTORY_SEARCH_CAPS.DEFAULT_MAX_QUERY_BYTES);
    expect(cfg.maxOutputBytes).toBe(TRAJECTORY_SEARCH_CAPS.DEFAULT_MAX_OUTPUT_BYTES);
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('rejects invalid or over-cap configuration at startup', () => {
    expect(() => resolveTrajectorySearchConfig({ maxResults: 0 })).toThrow();
    expect(() => resolveTrajectorySearchConfig({ maxResults: -1 })).toThrow();
    expect(() => resolveTrajectorySearchConfig({ maxResults: 21 })).toThrow();
    expect(() => resolveTrajectorySearchConfig({ maxSnippetChars: 401 })).toThrow();
    expect(() => resolveTrajectorySearchConfig({ maxQueryBytes: 513 })).toThrow();
    expect(() => resolveTrajectorySearchConfig({ maxOutputBytes: 16385 })).toThrow();
    expect(() => resolveTrajectorySearchConfig({ maxResults: 1.5 })).toThrow();
  });

  it('returns DISABLED when enabled is false', () => {
    const cfg = resolveTrajectorySearchConfig({ enabled: false });
    const res = searchObservationSnapshot(
      [{ call_id: 'c1', tool_name: 'read', status: 'ok', payload: 'hello world' }],
      { query: 'hello' },
      cfg,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason_code).toBe(OBSERVATION_SEARCH_REASON_CODES.DISABLED);
    }
  });

  it('excludes searchable=false entries while retaining normal entries', () => {
    const cfg = resolveTrajectorySearchConfig({ enabled: true });
    const entries: ObservationSearchEntry[] = [
      { call_id: 'c1', tool_name: 'read_file', status: 'ok', payload: 'secret token alpha' },
      {
        call_id: 'c2',
        tool_name: SEARCH_OBSERVATIONS_TOOL_NAME,
        status: 'ok',
        payload: 'secret token alpha from search',
        searchable: false,
      },
    ];

    const res = searchObservationSnapshot(entries, { query: 'alpha' }, cfg);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.total_matches).toBe(1);
      expect(res.hits.map((h) => h.call_id)).toEqual(['c1']);
    }
    expect(createSearchResultMetadata()).toBe(NON_SEARCHABLE_METADATA);
    expect(NON_SEARCHABLE_METADATA.searchable).toBe(false);
  });

  it('preserves exact Unicode code-point offsets for astral characters and normalization', () => {
    const cfg = resolveTrajectorySearchConfig({ enabled: true });
    const payload = '🚀✨ prefix Cafe\u0301 needleSuffix';
    const entries: ObservationSearchEntry[] = [
      { call_id: 'c_uni', tool_name: 'read_file', status: 'ok', payload },
    ];

    const res = searchObservationSnapshot(entries, { query: 'café' }, cfg);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.hits).toHaveLength(1);
      const hit = res.hits[0]!;
      const codePoints = Array.from(payload);
      expect(codePoints.slice(hit.char_start, hit.char_end).join('')).toBe(hit.snippet);
      expect(hit.snippet).toContain('Cafe\u0301');
    }
  });

  it('ranks deterministically by score, newest insertion index, then call_id', () => {
    const cfg = resolveTrajectorySearchConfig({ enabled: true });
    const entries: ObservationSearchEntry[] = [
      { call_id: 'c_b', tool_name: 't', status: 'ok', payload: 'alpha', insertion_index: 1 },
      { call_id: 'c_a', tool_name: 't', status: 'ok', payload: 'alpha', insertion_index: 1 },
      { call_id: 'c_new', tool_name: 't', status: 'ok', payload: 'alpha', insertion_index: 2 },
      { call_id: 'c_best', tool_name: 't', status: 'ok', payload: 'alpha alpha', insertion_index: 0 },
    ];

    const res = searchObservationSnapshot(entries, { query: 'alpha' }, cfg);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.hits.map((h) => h.call_id)).toEqual(['c_best', 'c_new', 'c_a', 'c_b']);
    }
  });

  it('enforces maxOutputBytes on complete UTF-8 JSON and errors if even one hit cannot fit', () => {
    const entries: ObservationSearchEntry[] = [
      { call_id: 'c1', tool_name: 't', status: 'ok', payload: 'x'.repeat(200) + ' needle' },
      { call_id: 'c2', tool_name: 't', status: 'ok', payload: 'y'.repeat(200) + ' needle' },
    ];

    const tightCfg = resolveTrajectorySearchConfig({ enabled: true, maxOutputBytes: 120 });
    const errRes = searchObservationSnapshot(entries, { query: 'needle' }, tightCfg);
    expect(errRes.ok).toBe(false);
    if (!errRes.ok) {
      expect(errRes.reason_code).toBe(OBSERVATION_SEARCH_REASON_CODES.OUTPUT_LIMIT_EXCEEDED);
    }

    const oneHitCfg = resolveTrajectorySearchConfig({ enabled: true, maxOutputBytes: 450 });
    const partialRes = searchObservationSnapshot(entries, { query: 'needle' }, oneHitCfg);
    expect(partialRes.ok).toBe(true);
    if (partialRes.ok) {
      expect(partialRes.total_matches).toBe(2);
      expect(partialRes.returned).toBe(1);
      expect(partialRes.has_more).toBe(true);
      expect(partialRes.next_offset).toBe(1);
      expect(Buffer.byteLength(JSON.stringify(partialRes), 'utf8')).toBeLessThanOrEqual(450);
    }
  });

  it('validates tool spec metadata as idempotent, concurrentSafe, readOnly, and ledgerExempt', () => {
    const cfg = resolveTrajectorySearchConfig({ enabled: true });
    const spec = createSearchObservationsToolSpec(cfg);
    expect(spec.name).toBe(SEARCH_OBSERVATIONS_TOOL_NAME);
    expect(spec.metadata).toBe(SEARCH_OBSERVATIONS_TOOL_METADATA);
    expect(spec.metadata.idempotent).toBe(true);
    expect(spec.metadata.concurrentSafe).toBe(true);
    expect(spec.metadata.readOnly).toBe(true);
    expect(spec.metadata.ledgerExempt).toBe(true);
  });
});
