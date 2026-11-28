import {
  NON_SEARCHABLE_METADATA,
  OBSERVATION_SEARCH_REASON_CODES,
  SEARCH_OBSERVATIONS_TOOL_METADATA,
  SEARCH_OBSERVATIONS_TOOL_NAME,
  TRAJECTORY_SEARCH_CAPS,
  type ObservationSearchEntry,
  type ObservationSearchError,
  type ObservationSearchHit,
  type ObservationSearchInput,
  type ObservationSearchMetadata,
  type ObservationSearchResult,
  type ObservationSearchSuccess,
  type TrajectorySearchConfig,
} from './search_types.js';

export class TrajectorySearchConfigError extends Error {
  readonly reason_code = OBSERVATION_SEARCH_REASON_CODES.INVALID_CONFIG;
  constructor(message: string) {
    super(message);
    this.name = 'TrajectorySearchConfigError';
  }
}

function validatePositiveIntCap(
  value: unknown,
  name: string,
  hardMax: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new TrajectorySearchConfigError(`${name} must be a finite positive integer`);
  }
  if (value > hardMax) {
    throw new TrajectorySearchConfigError(`${name} (${value}) exceeds hard cap (${hardMax})`);
  }
  return value;
}

export function resolveTrajectorySearchConfig(
  partial?: Partial<TrajectorySearchConfig>,
): Readonly<TrajectorySearchConfig> {
  const enabled = partial?.enabled ?? false;
  if (typeof enabled !== 'boolean') {
    throw new TrajectorySearchConfigError('enabled must be a boolean');
  }

  const maxResults = validatePositiveIntCap(
    partial?.maxResults ?? TRAJECTORY_SEARCH_CAPS.DEFAULT_MAX_RESULTS,
    'maxResults',
    TRAJECTORY_SEARCH_CAPS.HARD_MAX_RESULTS,
  );
  const maxSnippetChars = validatePositiveIntCap(
    partial?.maxSnippetChars ?? TRAJECTORY_SEARCH_CAPS.DEFAULT_MAX_SNIPPET_CHARS,
    'maxSnippetChars',
    TRAJECTORY_SEARCH_CAPS.HARD_MAX_SNIPPET_CHARS,
  );
  const maxQueryBytes = validatePositiveIntCap(
    partial?.maxQueryBytes ?? TRAJECTORY_SEARCH_CAPS.DEFAULT_MAX_QUERY_BYTES,
    'maxQueryBytes',
    TRAJECTORY_SEARCH_CAPS.HARD_MAX_QUERY_BYTES,
  );
  const maxOutputBytes = validatePositiveIntCap(
    partial?.maxOutputBytes ?? TRAJECTORY_SEARCH_CAPS.DEFAULT_MAX_OUTPUT_BYTES,
    'maxOutputBytes',
    TRAJECTORY_SEARCH_CAPS.HARD_MAX_OUTPUT_BYTES,
  );

  return Object.freeze({
    enabled,
    maxResults,
    maxSnippetChars,
    maxQueryBytes,
    maxOutputBytes,
  });
}

interface NormalizedCodePointMap {
  origCodePoints: string[];
  normCodePoints: string[];
  normText: string;
  /** For each index in normCodePoints, the [start, end) span in origCodePoints. */
  normToOrigSpan: Array<[number, number]>;
}

export function buildNormalizedCodePointMap(input: string): NormalizedCodePointMap {
  const origCodePoints = Array.from(input);
  const normCodePoints: string[] = [];
  const normToOrigSpan: Array<[number, number]> = [];

  for (let i = 0; i < origCodePoints.length; i++) {
    const cp = origCodePoints[i]!;
    const normalized = cp.normalize('NFC').toLowerCase();
    for (const ncp of normalized) {
      normCodePoints.push(ncp);
      normToOrigSpan.push([i, i + 1]);
    }
  }

  return {
    origCodePoints,
    normCodePoints,
    normText: normCodePoints.join(''),
    normToOrigSpan,
  };
}

/**
 * Deterministic tokenizer: normalizes with NFC + toLowerCase and splits on
 * non-letter/non-number Unicode boundaries, deduplicating while preserving order.
 */
export function tokenizeQuery(query: string): string[] {
  const normalized = query.normalize('NFC').toLowerCase();
  const rawTokens = normalized.split(/[^\p{L}\p{N}_-]+/u).filter((t) => t.length > 0);
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const t of rawTokens) {
    if (!seen.has(t)) {
      seen.add(t);
      tokens.push(t);
    }
  }
  return tokens;
}

function countOccurrences(haystack: string, needle: string): { count: number; firstIndex: number } {
  if (needle.length === 0) return { count: 0, firstIndex: -1 };
  let count = 0;
  let firstIndex = -1;
  let pos = 0;
  while (pos <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    if (firstIndex === -1) firstIndex = idx;
    count++;
    pos = idx + needle.length;
  }
  return { count, firstIndex };
}

/**
 * Converts a UTF-16 code-unit index in `normText` to a code-point index in `normCodePoints`.
 */
function utf16IndexToCodePointIndex(normCodePoints: string[], utf16Index: number): number {
  let utf16Pos = 0;
  for (let cpIdx = 0; cpIdx < normCodePoints.length; cpIdx++) {
    if (utf16Pos >= utf16Index) return cpIdx;
    utf16Pos += normCodePoints[cpIdx]!.length;
  }
  return normCodePoints.length;
}

function makeError(
  reason_code: ObservationSearchError['reason_code'],
  error: string,
  extra?: Partial<Pick<ObservationSearchError, 'max_output_bytes' | 'required_bytes'>>,
): ObservationSearchError {
  return {
    ok: false,
    error,
    reason_code,
    ...extra,
  };
}

interface RankedCandidate {
  entry: ObservationSearchEntry;
  insertionIndex: number;
  score: number;
  matchCount: number;
  charStart: number;
  charEnd: number;
  snippet: string;
}

/**
 * Searches a consistent snapshot of ObservationStore entries.
 * Entries with `searchable === false` are excluded.
 * Ranking: score desc, newest insertionIndex desc, call_id asc.
 */
export function searchObservationSnapshot(
  entries: ReadonlyArray<ObservationSearchEntry>,
  input: ObservationSearchInput,
  config: Readonly<TrajectorySearchConfig>,
): ObservationSearchResult {
  if (!config.enabled) {
    return makeError(OBSERVATION_SEARCH_REASON_CODES.DISABLED, 'Trajectory search is disabled');
  }

  if (typeof input !== 'object' || input === null || typeof input.query !== 'string') {
    return makeError(OBSERVATION_SEARCH_REASON_CODES.INVALID_QUERY, 'query must be a non-empty string');
  }

  const trimmedQuery = input.query.trim();
  if (trimmedQuery.length === 0) {
    return makeError(OBSERVATION_SEARCH_REASON_CODES.INVALID_QUERY, 'query must be a non-empty string');
  }

  const queryBytes = Buffer.byteLength(input.query, 'utf8');
  if (queryBytes > config.maxQueryBytes) {
    return makeError(
      OBSERVATION_SEARCH_REASON_CODES.QUERY_TOO_LARGE,
      `query exceeds maxQueryBytes (${queryBytes} > ${config.maxQueryBytes})`,
    );
  }

  if (input.tool_name !== undefined && (typeof input.tool_name !== 'string' || input.tool_name.length === 0)) {
    return makeError(OBSERVATION_SEARCH_REASON_CODES.INVALID_FILTER, 'tool_name must be a non-empty string');
  }
  if (input.status !== undefined && (typeof input.status !== 'string' || input.status.length === 0)) {
    return makeError(OBSERVATION_SEARCH_REASON_CODES.INVALID_FILTER, 'status must be a non-empty string');
  }

  const limit = input.limit ?? config.maxResults;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0 || limit > config.maxResults) {
    return makeError(
      OBSERVATION_SEARCH_REASON_CODES.INVALID_LIMIT,
      `limit must be an integer between 1 and ${config.maxResults}`,
    );
  }

  const offset = input.offset ?? 0;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    return makeError(OBSERVATION_SEARCH_REASON_CODES.INVALID_OFFSET, 'offset must be a non-negative integer');
  }

  const snippetChars = input.snippet_chars ?? config.maxSnippetChars;
  if (
    typeof snippetChars !== 'number' ||
    !Number.isInteger(snippetChars) ||
    snippetChars <= 0 ||
    snippetChars > config.maxSnippetChars
  ) {
    return makeError(
      OBSERVATION_SEARCH_REASON_CODES.INVALID_SNIPPET_CHARS,
      `snippet_chars must be an integer between 1 and ${config.maxSnippetChars}`,
    );
  }

  const normQuery = trimmedQuery.normalize('NFC').toLowerCase();
  const tokens = tokenizeQuery(trimmedQuery);

  const candidates: RankedCandidate[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.searchable === false) continue;
    if (input.tool_name !== undefined && entry.tool_name !== input.tool_name) continue;
    if (input.status !== undefined && entry.status !== input.status) continue;
    if (typeof entry.payload !== 'string' || entry.payload.length === 0) continue;

    const map = buildNormalizedCodePointMap(entry.payload);
    const exactMatch = countOccurrences(map.normText, normQuery);

    let tokenMatchCount = 0;
    let distinctTokensMatched = 0;
    let bestUtf16Start = exactMatch.firstIndex;
    let bestUtf16Len = exactMatch.firstIndex !== -1 ? normQuery.length : 0;

    for (const token of tokens) {
      const tm = countOccurrences(map.normText, token);
      if (tm.count > 0) {
        distinctTokensMatched++;
        tokenMatchCount += tm.count;
        if (bestUtf16Start === -1) {
          bestUtf16Start = tm.firstIndex;
          bestUtf16Len = token.length;
        }
      }
    }

    const totalMatches = exactMatch.count > 0 ? Math.max(exactMatch.count, tokenMatchCount) : tokenMatchCount;
    if (totalMatches === 0 || bestUtf16Start === -1) continue;

    // Deterministic score: exact phrase bonus + distinct token coverage + total matches
    const score = (exactMatch.count > 0 ? 100 : 0) + distinctTokensMatched * 10 + totalMatches;

    const normCpStart = utf16IndexToCodePointIndex(map.normCodePoints, bestUtf16Start);
    const normCpEnd = Math.min(
      map.normCodePoints.length,
      utf16IndexToCodePointIndex(map.normCodePoints, bestUtf16Start + Math.max(1, bestUtf16Len)),
    );

    const origMatchStart = map.normToOrigSpan[normCpStart]?.[0] ?? 0;
    const origMatchEnd = map.normToOrigSpan[Math.max(normCpStart, normCpEnd - 1)]?.[1] ?? origMatchStart + 1;

    const matchLen = origMatchEnd - origMatchStart;
    const halfPadding = Math.max(0, Math.floor((snippetChars - matchLen) / 2));
    let charStart = Math.max(0, origMatchStart - halfPadding);
    let charEnd = Math.min(map.origCodePoints.length, charStart + snippetChars);
    if (charEnd - charStart < snippetChars && charStart > 0) {
      charStart = Math.max(0, charEnd - snippetChars);
    }

    const snippet = map.origCodePoints.slice(charStart, charEnd).join('');

    candidates.push({
      entry,
      insertionIndex: entry.insertion_index ?? i,
      score,
      matchCount: totalMatches,
      charStart,
      charEnd,
      snippet,
    });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.insertionIndex !== a.insertionIndex) return b.insertionIndex - a.insertionIndex;
    return a.entry.call_id < b.entry.call_id ? -1 : a.entry.call_id > b.entry.call_id ? 1 : 0;
  });

  const totalMatches = candidates.length;
  const page = candidates.slice(offset, offset + limit);

  const emittedHits: ObservationSearchHit[] = [];
  for (const cand of page) {
    const hit: ObservationSearchHit = {
      call_id: cand.entry.call_id,
      tool_name: cand.entry.tool_name,
      status: cand.entry.status,
      match_count: cand.matchCount,
      char_start: cand.charStart,
      char_end: cand.charEnd,
      snippet: cand.snippet,
      truncated_entry: cand.entry.truncated_entry === true,
    };

    const nextHits = [...emittedHits, hit];
    const candidateResult: ObservationSearchSuccess = {
      ok: true,
      query: input.query,
      total_matches: totalMatches,
      returned: nextHits.length,
      offset,
      hits: nextHits,
      has_more: offset + nextHits.length < totalMatches,
      next_offset: offset + nextHits.length,
    };

    const byteLen = Buffer.byteLength(JSON.stringify(candidateResult), 'utf8');
    if (byteLen > config.maxOutputBytes) {
      if (emittedHits.length === 0) {
        return makeError(
          OBSERVATION_SEARCH_REASON_CODES.OUTPUT_LIMIT_EXCEEDED,
          `Single hit exceeds maxOutputBytes (${byteLen} > ${config.maxOutputBytes})`,
          { max_output_bytes: config.maxOutputBytes, required_bytes: byteLen },
        );
      }
      break;
    }
    emittedHits.push(hit);
  }

  return {
    ok: true,
    query: input.query,
    total_matches: totalMatches,
    returned: emittedHits.length,
    offset,
    hits: emittedHits,
    has_more: offset + emittedHits.length < totalMatches,
    next_offset: offset + emittedHits.length,
  };
}

export function createSearchResultMetadata(): ObservationSearchMetadata {
  return NON_SEARCHABLE_METADATA;
}

export function createSearchObservationsToolSpec(config: Readonly<TrajectorySearchConfig>) {
  return {
    name: SEARCH_OBSERVATIONS_TOOL_NAME,
    description:
      'Read-only lexical search over earlier tool observations in the current run. Returns navigational snippets and call_ids; recall the underlying call_id to inspect full evidence.',
    metadata: SEARCH_OBSERVATIONS_TOOL_METADATA,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: `Search query (max ${config.maxQueryBytes} UTF-8 bytes).`,
        },
        tool_name: {
          type: 'string',
          description: 'Optional exact tool_name filter.',
        },
        status: {
          type: 'string',
          description: 'Optional exact status filter.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: config.maxResults,
          description: `Maximum hits to return (default ${config.maxResults}, max ${config.maxResults}).`,
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'Pagination offset (default 0).',
        },
        snippet_chars: {
          type: 'integer',
          minimum: 1,
          maximum: config.maxSnippetChars,
          description: `Maximum code points per snippet (default ${config.maxSnippetChars}, max ${config.maxSnippetChars}).`,
        },
      },
    },
  };
}
