/**
 * cap_external_search_api_4.ts
 * 
 * Implements "Controlled external search and API gateway" (cap_external_search_api_4).
 * Features:
 * 1. Web search tool executed entirely on the host controller side (inaccessible to the run_python sandbox).
 * 2. Input/output sanitization, rate-limiting on a per-task basis, and content policy enforcement.
 * 3. Search-provenance envelope wrapping results and automatic memory taint marking.
 */

export interface SearchInput {
  query: string;
  provider?: 'google' | 'bing' | 'tavily';
  max_results?: number;
  safe_search?: boolean;
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  freshness_date: string;
}

export interface SearchOutput {
  results: SearchResultItem[];
  provider_used: string;
  truncated: boolean;
  rate_limit_remaining: number;
}

export interface SearchProvenanceEnvelope {
  source: 'web_search';
  timestamp: string;
  query: string;
  provider: string;
  data: SearchOutput;
  tainted: boolean;
}

// Basic Memory Store interface representing cap_long_term_memory_3 integration
export interface MemoryStore {
  storedItems: Array<{
    key: string;
    value: any;
    tainted: boolean;
    provenance?: string;
  }>;
}

export class SearchGateway {
  private rateLimits: Map<string, number> = new Map(); // task_id -> remaining requests
  private maxLimit = 10;
  private blockedKeywords = ['secret_key', 'private_key', 'password', 'api_key', 'drop table', 'untrusted_instruction_exploit'];

  constructor(maxLimit = 10) {
    this.maxLimit = maxLimit;
  }

  /**
   * Checks if query contains sensitive keys/patterns or violates content policies.
   */
  public validateQuery(query: string): boolean {
    const lower = query.toLowerCase();
    for (const keyword of this.blockedKeywords) {
      if (lower.includes(keyword)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Strips/sanitizes malicious payloads or script tags from retrieved snippets to prevent exploits.
   */
  public sanitizeSnippet(text: string): string {
    return text
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/on\w+=(["'])(.*?)\1/gi, '')
      .replace(/javascript:/gi, '');
  }

  /**
   * Checks and decrements rate limits for a given task.
   */
  public checkRateLimit(taskId: string): { remaining: number; allowed: boolean } {
    if (!this.rateLimits.has(taskId)) {
      this.rateLimits.set(taskId, this.maxLimit);
    }
    const remaining = this.rateLimits.get(taskId)!;
    if (remaining <= 0) {
      return { remaining: 0, allowed: false };
    }
    const nextRemaining = remaining - 1;
    this.rateLimits.set(taskId, nextRemaining);
    return { remaining: nextRemaining, allowed: true };
  }

  /**
   * Executes the search operation with strict rules.
   */
  public async performSearch(input: SearchInput, taskId: string): Promise<SearchOutput> {
    if (!this.validateQuery(input.query)) {
      throw new Error('Search query contains forbidden terms or violates safety policies');
    }

    const rateCheck = this.checkRateLimit(taskId);
    if (!rateCheck.allowed) {
      throw new Error(`Rate limit exceeded for task: ${taskId}. Please back off.`);
    }

    const provider = input.provider || 'google';
    const maxResults = Math.min(input.max_results || 5, 20);

    // Simulated retrieval with sanitization
    const rawSnippet = 'Check out <script>alert("xss")</script> this cool TypeScript search framework!';
    const sanitizedSnippet = this.sanitizeSnippet(rawSnippet);

    const results: SearchResultItem[] = [];
    for (let i = 0; i < maxResults; i++) {
      results.push({
        title: `Result ${i + 1} for ${input.query}`,
        url: `https://example.com/search?q=${encodeURIComponent(input.query)}&index=${i}`,
        snippet: sanitizedSnippet,
        freshness_date: new Date().toISOString().split('T')[0]
      });
    }

    return {
      results,
      provider_used: provider,
      truncated: false,
      rate_limit_remaining: rateCheck.remaining
    };
  }
}

export class ToolRegistry {
  private searchGateway: SearchGateway;

  constructor(searchGateway: SearchGateway) {
    this.searchGateway = searchGateway;
  }

  /**
   * Invokes the web search tool securely from the controller host side.
   */
  public async invokeTool(
    toolName: string,
    input: SearchInput,
    taskId: string,
    isSandbox: boolean
  ): Promise<SearchProvenanceEnvelope> {
    if (toolName !== 'web_search') {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    if (isSandbox) {
      throw new Error('Execution policy violation: web_search is not accessible from inside the run_python sandbox.');
    }

    const searchOutput = await this.searchGateway.performSearch(input, taskId);

    return {
      source: 'web_search',
      timestamp: new Date().toISOString(),
      query: input.query,
      provider: searchOutput.provider_used,
      data: searchOutput,
      tainted: true
    };
  }
}

/**
 * Persists the search results into memory_store, ensuring the permanent 'tainted' flag is set.
 */
export function persistToMemory(store: MemoryStore, key: string, envelope: SearchProvenanceEnvelope): void {
  store.storedItems.push({
    key,
    value: envelope.data,
    tainted: envelope.tainted,
    provenance: envelope.source
  });
}
