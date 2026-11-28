import {
  OBSERVATION_SEARCH_REASON_CODES,
  TRAJECTORY_SEARCH_CAPS,
  TrajectorySearchConfigError,
  resolveTrajectorySearchConfig,
  searchObservationSnapshot,
  type ObservationSearchEntry,
} from '../index.js';

describe('trajectory_search edge cases and contract', () => {
  it('accepts hard-cap configuration and rejects non-boolean enabled', () => {
    const hardCfg = resolveTrajectorySearchConfig({
      enabled: true,
      maxResults: TRAJECTORY_SEARCH_CAPS.HARD_MAX_RESULTS,
      maxSnippetChars: TRAJECTORY_SEARCH_CAPS.HARD_MAX_SNIPPET_CHARS,
      maxQueryBytes: TRAJECTORY_SEARCH_CAPS.HARD_MAX_QUERY_BYTES,
      maxOutputBytes: TRAJECTORY_SEARCH_CAPS.HARD_MAX_OUTPUT_BYTES,
    });
    expect(hardCfg.enabled).toBe(true);
    expect(hardCfg.maxResults).toBe(TRAJECTORY_SEARCH_CAPS.HARD_MAX_RESULTS);
    expect(Object.isFrozen(hardCfg)).toBe(true);

    expect(() =>
      resolveTrajectorySearchConfig({ enabled: 'true' as unknown as boolean }),
    ).toThrow(TrajectorySearchConfigError);
  });

  it('validates query, byte limits, pagination, snippet_chars, and filters', () => {
    const cfg = resolveTrajectorySearchConfig({
      enabled: true,
      maxResults: 5,
      maxSnippetChars: 50,
      maxQueryBytes: 10,
      maxOutputBytes: 4096,
    });
    const entries: ObservationSearchEntry[] = [
      { call_id: 'c1', tool_name: 'read', status: 'ok', payload: 'alpha beta gamma' },
    ];

    const emptyQuery = searchObservationSnapshot(entries, { query: '   ' }, cfg);
    expect(emptyQuery.ok).toBe(false);
    if (!emptyQuery.ok) expect(emptyQuery.reason_code).toBe(OBSERVATION_SEARCH_REASON_CODES.INVALID_QUERY);

    // 4-byte emoji * 3 = 12 bytes > maxQueryBytes (10)
    const largeQuery = searchObservationSnapshot(entries, { query: '😀😀😀' }, cfg);
    expect(largeQuery.ok).toBe(false);
    if (!largeQuery.ok) expect(largeQuery.reason_code).toBe(OBSERVATION_SEARCH_REASON_CODES.QUERY_TOO_LARGE);

    const badLimit = searchObservationSnapshot(entries, { query: 'alpha', limit: 6 }, cfg);
    expect(badLimit.ok).toBe(false);
    if (!badLimit.ok) expect(badLimit.reason_code).toBe(OBSERVATION_SEARCH_REASON_CODES.INVALID_LIMIT);

    const badOffset = searchObservationSnapshot(entries, { query: 'alpha', offset: -1 }, cfg);
    expect(badOffset.ok).toBe(false);
    if (!badOffset.ok) expect(badOffset.reason_code).toBe(OBSERVATION_SEARCH_REASON_CODES.INVALID_OFFSET);

    const badSnippet = searchObservationSnapshot(entries, { query: 'alpha', snippet_chars: 51 }, cfg);
    expect(badSnippet.ok).toBe(false);
    if (!badSnippet.ok) expect(badSnippet.reason_code).toBe(OBSERVATION_SEARCH_REASON_CODES.INVALID_SNIPPET_CHARS);

    const badFilter = searchObservationSnapshot(entries, { query: 'alpha', tool_name: '' }, cfg);
    expect(badFilter.ok).toBe(false);
    if (!badFilter.ok) expect(badFilter.reason_code).toBe(OBSERVATION_SEARCH_REASON_CODES.INVALID_FILTER);
  });

  it('excludes searchable=false entries, applies exact filters, ranks deterministically, and slices astral code points', () => {
    const cfg = resolveTrajectorySearchConfig({ enabled: true, maxResults: 5, maxSnippetChars: 100 });
    const entries: ObservationSearchEntry[] = [
      {
        call_id: 'c_hidden',
        tool_name: 'read',
        status: 'ok',
        payload: 'needle needle needle',
        searchable: false,
        insertion_index: 0,
      },
      {
        call_id: 'c_old_one',
        tool_name: 'read',
        status: 'ok',
        payload: 'prefix 😀 needle suffix',
        insertion_index: 1,
      },
      {
        call_id: 'c_new_one',
        tool_name: 'read',
        status: 'ok',
        payload: 'another needle here',
        insertion_index: 2,
      },
      {
        call_id: 'c_two_hits',
        tool_name: 'read',
        status: 'ok',
        payload: 'Needle and NEEDLE',
        insertion_index: 0,
      },
      {
        call_id: 'c_other_tool',
        tool_name: 'grep',
        status: 'ok',
        payload: 'needle in grep',
        insertion_index: 3,
      },
    ];

    const res = searchObservationSnapshot(
      entries,
      { query: 'needle', tool_name: 'read', status: 'ok', limit: 2, offset: 0 },
      cfg,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.total_matches).toBe(3);
    expect(res.returned).toBe(2);
    expect(res.has_more).toBe(true);
    expect(res.next_offset).toBe(2);
    expect(res.hits.map((h) => h.call_id)).toEqual(['c_two_hits', 'c_new_one']);

    const page2 = searchObservationSnapshot(
      entries,
      { query: 'needle', tool_name: 'read', status: 'ok', limit: 2, offset: 2 },
      cfg,
    );
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;

    expect(page2.total_matches).toBe(3);
    expect(page2.returned).toBe(1);
    expect(page2.has_more).toBe(false);
    expect(page2.next_offset).toBe(3);
    expect(page2.hits[0].call_id).toBe('c_old_one');

    const hit = page2.hits[0];
    const codePoints = Array.from(entries[1].payload);
    expect(codePoints.slice(hit.char_start, hit.char_end).join('')).toBe(hit.snippet);
  });

  it('returns OUTPUT_LIMIT_EXCEEDED when even a single hit cannot fit in maxOutputBytes', () => {
    const cfg = resolveTrajectorySearchConfig({
      enabled: true,
      maxResults: 5,
      maxSnippetChars: 200,
      maxOutputBytes: 64,
    });
    const entries: ObservationSearchEntry[] = [
      {
        call_id: 'c_large',
        tool_name: 'read',
        status: 'ok',
        payload: 'needle ' + 'x'.repeat(150),
      },
    ];

    const res = searchObservationSnapshot(entries, { query: 'needle' }, cfg);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason_code).toBe(OBSERVATION_SEARCH_REASON_CODES.OUTPUT_LIMIT_EXCEEDED);
    }
  });
});
