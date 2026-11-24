import { createHash } from 'node:crypto';
import { rankCatalog } from './bm25.js';
import {
  DEFAULT_MAX_CATALOG_SEARCH_RESULTS,
  DEFAULT_MAX_LOADED_TOOLS,
  DEFAULT_MAX_TOOL_SCHEMA_BYTES,
  DEFAULT_SEARCH_LIMIT,
  DISCOVERY_REASON_CODES,
  HARD_MAX_CATALOG_SEARCH_RESULTS,
  HARD_MAX_LOADED_TOOLS,
  HARD_MAX_TOOL_SCHEMA_BYTES,
  LoadedToolState,
  MAX_QUERY_BYTES,
  NOT_LOADED_STUB_DESCRIPTION,
  PinContext,
  RenderedToolSchema,
  SchemaBudgetExceededResult,
  TOOL_NOT_LOADED_HINT,
  ToolCatalogEntry,
  ToolDiscoveryConfig,
  ToolNotLoadedResult,
  ToolSearchResult,
} from './types.js';

const FORBIDDEN_CO_MOUNTS = new Set([
  'cap_durable_runs_mount_41',
  'cap_interactive_session_49',
]);

export class DiscoveryManager {
  public readonly enabled: boolean;
  public readonly maxLoadedTools: number;
  public readonly maxCatalogSearchResults: number;
  public readonly maxToolSchemaBytes: number;
  public readonly alwaysVisibleTools: ReadonlySet<string>;
  private readonly catalog: Map<string, ToolCatalogEntry>;
  private state: LoadedToolState;
  private pendingLoadedTools: string[] | null = null;

  constructor(config: ToolDiscoveryConfig, rawCatalog: ToolCatalogEntry[]) {
    this.enabled = config.enabled ?? false;
    this.maxLoadedTools = config.maxLoadedTools ?? DEFAULT_MAX_LOADED_TOOLS;
    this.maxCatalogSearchResults = config.maxCatalogSearchResults ?? DEFAULT_MAX_CATALOG_SEARCH_RESULTS;
    this.maxToolSchemaBytes = config.maxToolSchemaBytes ?? DEFAULT_MAX_TOOL_SCHEMA_BYTES;

    if (config.mountedCapabilities) {
      for (const cap of config.mountedCapabilities) {
        if (FORBIDDEN_CO_MOUNTS.has(cap)) {
          throw new Error(`Discovery cannot co-mount with ${cap}`);
        }
      }
    }

    if (this.maxLoadedTools < 1 || this.maxLoadedTools > HARD_MAX_LOADED_TOOLS) {
      throw new Error(`maxLoadedTools must be between 1 and ${HARD_MAX_LOADED_TOOLS}`);
    }
    if (this.maxCatalogSearchResults < 1 || this.maxCatalogSearchResults > HARD_MAX_CATALOG_SEARCH_RESULTS) {
      throw new Error(`maxCatalogSearchResults must be between 1 and ${HARD_MAX_CATALOG_SEARCH_RESULTS}`);
    }
    if (this.maxToolSchemaBytes < 1 || this.maxToolSchemaBytes > HARD_MAX_TOOL_SCHEMA_BYTES) {
      throw new Error(`maxToolSchemaBytes must be between 1 and ${HARD_MAX_TOOL_SCHEMA_BYTES}`);
    }

    this.catalog = new Map();
    for (const entry of rawCatalog) {
      if (entry.registered === false) continue;
      if (entry.approval_tier === 'deny') continue;
      if (entry.mode_excluded === true) continue;
      this.catalog.set(entry.tool_name, entry);
    }

    this.alwaysVisibleTools = new Set(config.alwaysVisibleTools);
    const initialLoaded = config.initialLoadedTools ?? [];

    if (this.enabled) {
      if (!this.alwaysVisibleTools.has('search_tools')) {
        throw new Error('alwaysVisibleTools must include search_tools when discovery is enabled');
      }
      for (const req of config.requiredAlwaysVisible ?? []) {
        if (this.catalog.has(req) && !this.alwaysVisibleTools.has(req)) {
          throw new Error(`alwaysVisibleTools must include registered required tool: ${req}`);
        }
      }
      for (const name of initialLoaded) {
        if (!this.catalog.has(name)) {
          throw new Error(`initialLoadedTools names a tool outside the catalog: ${name}`);
        }
      }
      const combined = new Set([...this.alwaysVisibleTools, ...initialLoaded]);
      if (combined.size > this.maxLoadedTools) {
        throw new Error('alwaysVisibleTools union initialLoadedTools exceeds maxLoadedTools');
      }
      const combinedBytes = this.computeSchemaBytes([...combined]);
      if (combinedBytes > this.maxToolSchemaBytes) {
        throw new Error('alwaysVisibleTools union initialLoadedTools exceeds maxToolSchemaBytes');
      }
    }

    const digest = createHash('sha256')
      .update(JSON.stringify([...this.catalog.keys()].sort()))
      .digest('hex');

    this.state = {
      loadedTools: [...initialLoaded],
      lastUpdatedTurn: 0,
      catalogDigest: digest,
    };
  }

  public getState(): Readonly<LoadedToolState> {
    return {
      loadedTools: [...this.state.loadedTools],
      lastUpdatedTurn: this.state.lastUpdatedTurn,
      catalogDigest: this.state.catalogDigest,
    };
  }

  public getCatalogEntry(toolName: string): ToolCatalogEntry | undefined {
    return this.catalog.get(toolName);
  }

  private computeSchemaBytes(toolNames: string[]): number {
    let total = 0;
    for (const name of toolNames) {
      const entry = this.catalog.get(name);
      if (!entry) continue;
      if (typeof entry.schema_bytes === 'number') {
        total += entry.schema_bytes;
      } else {
        total += Buffer.byteLength(
          JSON.stringify({ name: entry.tool_name, description: entry.description, parameters: entry.parameters ?? {} }),
          'utf8'
        );
      }
    }
    return total;
  }

  public checkToolCall(toolName: string): { allowed: true } | ToolNotLoadedResult | { status: 'error'; started: false; reason: 'unknown_tool' } {
    if (!this.catalog.has(toolName)) {
      return { status: 'error', started: false, reason: DISCOVERY_REASON_CODES.UNKNOWN_TOOL };
    }
    if (!this.enabled) {
      return { allowed: true };
    }
    if (this.alwaysVisibleTools.has(toolName) || this.state.loadedTools.includes(toolName)) {
      return { allowed: true };
    }
    return {
      status: DISCOVERY_REASON_CODES.TOOL_NOT_LOADED,
      started: false,
      reason: DISCOVERY_REASON_CODES.TOOL_NOT_LOADED,
      tool_name: toolName,
      hint: TOOL_NOT_LOADED_HINT,
      slotExempt: true,
      tripsBatchLatch: false,
    };
  }

  public searchTools(
    args: { query: string; limit?: number },
    pinContext: PinContext = {}
  ): 
    | { started: true; status: 'ok'; output: ToolSearchResult; slotExempt: false }
    | SchemaBudgetExceededResult
    | { started: false; status: 'error'; reason: 'invalid_args' | 'deadline_before_commit'; slotExempt: true } {
    const query = typeof args?.query === 'string' ? args.query : '';
    const queryBytes = Buffer.byteLength(query, 'utf8');
    const limit = args?.limit ?? DEFAULT_SEARCH_LIMIT;

    if (queryBytes < 1 || queryBytes > MAX_QUERY_BYTES || !Number.isInteger(limit) || limit < 1 || limit > this.maxCatalogSearchResults) {
      return { started: false, status: 'error', reason: DISCOVERY_REASON_CODES.INVALID_ARGS, slotExempt: true };
    }
    if (pinContext.deadlineExceeded) {
      return { started: false, status: 'error', reason: DISCOVERY_REASON_CODES.DEADLINE_BEFORE_COMMIT, slotExempt: true };
    }

    const currentLoadedSet = new Set([...this.alwaysVisibleTools, ...this.state.loadedTools]);
    const { items, totalMatches } = rankCatalog(query, [...this.catalog.values()], currentLoadedSet, limit);

    if (items.length === 0) {
      return {
        started: true,
        status: 'ok',
        output: { ok: true, found_count: 0, results: [], elided_count: 0 },
        slotExempt: false,
      };
    }

    const pinned = new Set<string>(this.alwaysVisibleTools);
    for (const s of pinContext.openRecoverySlots ?? []) pinned.add(s);
    for (const u of pinContext.unresolvedUnknownTools ?? []) pinned.add(u);
    if (pinContext.needsObservation && this.catalog.has('gui_observe')) {
      pinned.add('gui_observe');
    }

    const newlyMatched = items.map((i) => i.tool_name).filter((n) => !this.alwaysVisibleTools.has(n));
    let nextLoaded = [...this.state.loadedTools.filter((n) => !newlyMatched.includes(n)), ...newlyMatched];

    // Evict LRU non-pinned tools if over maxLoadedTools or maxToolSchemaBytes
    const fits = (candidate: string[]): boolean => {
      const union = [...new Set([...this.alwaysVisibleTools, ...candidate])];
      return union.length <= this.maxLoadedTools && this.computeSchemaBytes(union) <= this.maxToolSchemaBytes;
    };

    let idx = 0;
    while (!fits(nextLoaded) && idx < nextLoaded.length) {
      const candidateName = nextLoaded[idx];
      if (!pinned.has(candidateName) && !newlyMatched.includes(candidateName)) {
        nextLoaded.splice(idx, 1);
      } else {
        idx++;
      }
    }

    if (!fits(nextLoaded)) {
      return {
        started: true,
        status: 'ok',
        output: { ok: false, reason: DISCOVERY_REASON_CODES.SCHEMA_BUDGET_EXCEEDED },
        slotExempt: true,
      };
    }

    this.pendingLoadedTools = nextLoaded;
    const updatedSet = new Set([...this.alwaysVisibleTools, ...nextLoaded]);
    const resultItems = items.map((i) => ({ ...i, loaded: updatedSet.has(i.tool_name) }));

    return {
      started: true,
      status: 'ok',
      output: {
        ok: true,
        found_count: totalMatches,
        results: resultItems,
        elided_count: Math.max(0, totalMatches - resultItems.length),
      },
      slotExempt: false,
    };
  }

  public commitTurnBoundary(turnNumber: number): void {
    if (this.pendingLoadedTools !== null) {
      this.state = {
        loadedTools: [...this.pendingLoadedTools],
        lastUpdatedTurn: turnNumber,
        catalogDigest: this.state.catalogDigest,
      };
      this.pendingLoadedTools = null;
    }
  }

  public renderToolsForContext(historicalToolCallNames: string[]):
    | { ok: true; tools: RenderedToolSchema[]; totalBytes: number }
    | { ok: false; reason: typeof DISCOVERY_REASON_CODES.TOOL_SCHEMA_BUDGET_EXCEEDED } {
    if (!this.enabled) {
      const allTools: RenderedToolSchema[] = [...this.catalog.values()].map((e) => ({
        name: e.tool_name,
        description: e.description,
        parameters: e.parameters,
      }));
      const totalBytes = Buffer.byteLength(JSON.stringify(allTools), 'utf8');
      return { ok: true, tools: allTools, totalBytes };
    }

    const activeNames = new Set([...this.alwaysVisibleTools, ...this.state.loadedTools]);
    const tools: RenderedToolSchema[] = [];

    for (const name of activeNames) {
      const entry = this.catalog.get(name);
      if (entry) {
        tools.push({
          name: entry.tool_name,
          description: entry.description,
          parameters: entry.parameters,
        });
      }
    }

    const stubbed = new Set<string>();
    for (const histName of historicalToolCallNames) {
      if (!activeNames.has(histName) && !stubbed.has(histName)) {
        stubbed.add(histName);
        tools.push({
          name: histName,
          description: NOT_LOADED_STUB_DESCRIPTION,
          isStub: true,
        });
      }
    }

    const totalBytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
    if (totalBytes > this.maxToolSchemaBytes) {
      return { ok: false, reason: DISCOVERY_REASON_CODES.TOOL_SCHEMA_BUDGET_EXCEEDED };
    }
    return { ok: true, tools, totalBytes };
  }

  public getChildTools(childAllowlist: string[]): RenderedToolSchema[] {
    return childAllowlist
      .filter((name) => name !== 'search_tools' && this.catalog.has(name))
      .map((name) => {
        const entry = this.catalog.get(name)!;
        return {
          name: entry.tool_name,
          description: entry.description,
          parameters: entry.parameters,
        };
      });
  }
}
