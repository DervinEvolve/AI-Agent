export const TRAJECTORY_SEARCH_CAPS = Object.freeze({
  DEFAULT_MAX_RESULTS: 5,
  HARD_MAX_RESULTS: 20,
  DEFAULT_MAX_SNIPPET_CHARS: 200,
  HARD_MAX_SNIPPET_CHARS: 400,
  DEFAULT_MAX_QUERY_BYTES: 256,
  HARD_MAX_QUERY_BYTES: 512,
  DEFAULT_MAX_OUTPUT_BYTES: 4096,
  HARD_MAX_OUTPUT_BYTES: 16384,
} as const);

export const OBSERVATION_SEARCH_REASON_CODES = Object.freeze({
  INVALID_CONFIG: 'INVALID_CONFIG',
  DISABLED: 'DISABLED',
  INVALID_QUERY: 'INVALID_QUERY',
  QUERY_TOO_LARGE: 'QUERY_TOO_LARGE',
  INVALID_LIMIT: 'INVALID_LIMIT',
  INVALID_OFFSET: 'INVALID_OFFSET',
  INVALID_SNIPPET_CHARS: 'INVALID_SNIPPET_CHARS',
  INVALID_FILTER: 'INVALID_FILTER',
  OUTPUT_LIMIT_EXCEEDED: 'OUTPUT_LIMIT_EXCEEDED',
} as const);

export type ObservationSearchReasonCode =
  (typeof OBSERVATION_SEARCH_REASON_CODES)[keyof typeof OBSERVATION_SEARCH_REASON_CODES];

export interface TrajectorySearchConfig {
  enabled: boolean;
  maxResults: number;
  maxSnippetChars: number;
  maxQueryBytes: number;
  maxOutputBytes: number;
}

export interface ObservationSearchMetadata {
  readonly searchable: false;
}

export const NON_SEARCHABLE_METADATA: ObservationSearchMetadata = Object.freeze({
  searchable: false,
});

export interface ObservationSearchEntry {
  call_id: string;
  tool_name: string;
  status: string;
  payload: string;
  truncated_entry?: boolean;
  searchable?: boolean;
  insertion_index?: number;
}

export interface ObservationSearchInput {
  query: string;
  tool_name?: string;
  status?: string;
  limit?: number;
  offset?: number;
  snippet_chars?: number;
}

export interface ObservationSearchHit {
  call_id: string;
  tool_name: string;
  status: string;
  match_count: number;
  char_start: number;
  char_end: number;
  snippet: string;
  truncated_entry: boolean;
}

export interface ObservationSearchSuccess {
  ok: true;
  query: string;
  total_matches: number;
  returned: number;
  offset: number;
  hits: ObservationSearchHit[];
  has_more: boolean;
  next_offset: number;
}

export interface ObservationSearchError {
  ok: false;
  error: string;
  reason_code: ObservationSearchReasonCode;
  max_output_bytes?: number;
  required_bytes?: number;
}

export type ObservationSearchResult = ObservationSearchSuccess | ObservationSearchError;

export const SEARCH_OBSERVATIONS_TOOL_NAME = 'search_observations' as const;

export const SEARCH_OBSERVATIONS_TOOL_METADATA = Object.freeze({
  idempotent: true,
  concurrentSafe: true,
  readOnly: true,
  ledgerExempt: true,
} as const);
