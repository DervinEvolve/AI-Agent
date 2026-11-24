export const DEFAULT_MAX_LOADED_TOOLS = 12;
export const HARD_MAX_LOADED_TOOLS = 24;

export const DEFAULT_MAX_CATALOG_SEARCH_RESULTS = 8;
export const HARD_MAX_CATALOG_SEARCH_RESULTS = 16;

export const DEFAULT_MAX_TOOL_SCHEMA_BYTES = 32768;
export const HARD_MAX_TOOL_SCHEMA_BYTES = 262144;

export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_QUERY_BYTES = 256;
export const MAX_SEARCH_OUTPUT_BYTES = 8192;
export const MAX_UNTRUSTED_DESCRIPTION_BYTES = 512;

export const NOT_LOADED_STUB_DESCRIPTION = 'Schema not loaded. Call search_tools.';
export const TOOL_NOT_LOADED_HINT = 'Tool schema is not loaded. Call search_tools to discover and load it.';
export const UNTRUSTED_ORIGIN_BEHAVIOR = 'beh_north_51_mwroaf9r';

export const DISCOVERY_REASON_CODES = {
  TOOL_NOT_LOADED: 'tool_not_loaded',
  SCHEMA_BUDGET_EXCEEDED: 'schema_budget_exceeded',
  TOOL_SCHEMA_BUDGET_EXCEEDED: 'tool_schema_budget_exceeded',
  INVALID_ARGS: 'invalid_args',
  DEADLINE_BEFORE_COMMIT: 'deadline_before_commit',
  UNKNOWN_TOOL: 'unknown_tool',
} as const;

export type DiscoveryReasonCode =
  (typeof DISCOVERY_REASON_CODES)[keyof typeof DISCOVERY_REASON_CODES];

export interface ToolDiscoveryConfig {
  enabled: boolean;
  alwaysVisibleTools: string[];
  initialLoadedTools?: string[];
  maxLoadedTools?: number;
  maxCatalogSearchResults?: number;
  maxToolSchemaBytes?: number;
  mountedCapabilities?: string[];
  requiredAlwaysVisible?: string[];
}

export interface ToolCatalogEntry {
  tool_name: string;
  description: string;
  parameters?: Record<string, unknown>;
  host_tags?: string[];
  property_names?: string[];
  schema_bytes?: number;
  approval_tier?: 'allow' | 'ask' | 'deny';
  mode_excluded?: boolean;
  registered?: boolean;
}

export interface ToolSearchResultItem {
  tool_name: string;
  score: number;
  loaded: boolean;
  untrusted_metadata?: {
    origin: string;
    description: string;
  };
}

export interface ToolSearchResult {
  ok: true;
  found_count: number;
  results: ToolSearchResultItem[];
  elided_count: number;
}

export interface SchemaBudgetExceededResult {
  started: true;
  status: 'ok';
  output: {
    ok: false;
    reason: typeof DISCOVERY_REASON_CODES.SCHEMA_BUDGET_EXCEEDED;
  };
  slotExempt: true;
}

export interface ToolNotLoadedResult {
  status: typeof DISCOVERY_REASON_CODES.TOOL_NOT_LOADED;
  started: false;
  reason: typeof DISCOVERY_REASON_CODES.TOOL_NOT_LOADED;
  tool_name: string;
  hint: string;
  slotExempt: true;
  tripsBatchLatch: false;
}

export interface LoadedToolState {
  loadedTools: string[];
  lastUpdatedTurn: number;
  catalogDigest: string;
}

export interface RenderedToolSchema {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  isStub?: boolean;
}

export interface PinContext {
  openRecoverySlots?: Set<string>;
  unresolvedUnknownTools?: Set<string>;
  needsObservation?: boolean;
  deadlineExceeded?: boolean;
}
