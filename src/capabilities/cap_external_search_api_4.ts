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
   * Strips/sanitizes malicious payloads or script tags from retrieved snippets to prevent injection.
   */
  public sanitizeText(text: string): string {
    // Remove script tags, javascript: URIs, and HTML tag bounds
    return text
      .replace(/<script[^>]*?>[\s\S]*?<\/script>/gi, '')
      .replace(/javascript:/gi, '')
      .replace(/[<>]/g, '');
  }

  /**
   * Evaluates rate limits on a per-task basis.
   */
  public checkRateLimit(taskId: string): number {
    if (!this.rateLimits.has(taskId)) {
      this.rateLimits.set(taskId, this.maxLimit);
    }
    const remaining = this.rateLimits.get(taskId)!;
    if (remaining <= 0) {
      throw new Error(`Rate limit exceeded for task ${taskId}`);
    }
    this.rateLimits.set(taskId, remaining - 1);
    return remaining - 1;
  }

  /**
   * Mocked API gateway fetch that acts as the secure, host-side search client.
   */
  public async executeSearch(input: SearchInput, taskId: string): Promise<SearchOutput> {
    if (!input.query || input.query.trim() === '') {
      throw new Error('Search query cannot be empty');
    }

    if (!this.validateQuery(input.query)) {
      throw new Error('Search query contains forbidden terms or violates safety policies');
    }

    const remaining = this.checkRateLimit(taskId);
    const provider = input.provider || 'google';
    const maxResults = Math.min(input.max_results || 5, 20);

    // Simulated real-world external search integration satisfying specifications
    const rawResults: SearchResultItem[] = [
      {
        title: `Search Result for ${input.query}`,
        url: `https://www.example-search.com/q=${encodeURIComponent(input.query)}`,
        snippet: `Here is a safe snippet about <script>alert("malicious")</script> ${input.query} details.`,
        freshness_date: new Date().toISOString().split('T')[0]
      },
      {
        title: 'Another Related Post',
        url: 'https://blog.example.com/post-123',
        snippet: 'A secondary result containing safe, useful context.',
        freshness_date: '2023-10-01'
      }
    ];

    const sanitizedResults = rawResults.slice(0, maxResults).map(item => ({
      title: this.sanitizeText(item.title),
      url: item.url,
      snippet: this.sanitizeText(item.snippet),
      freshness_date: item.freshness_date
    }));

    return {
      results: sanitizedResults,
      provider_used: provider,
      truncated: rawResults.length > maxResults,
      rate_limit_remaining: remaining
    };
  }
}

export class ToolRegistry {
  private gateway: SearchGateway;
  private sandboxInaccessibleTools: Set<string> = new Set(['web_search']);

  constructor(gateway: SearchGateway) {
    this.gateway = gateway;
  }

  /**
   * Safe invocation interface. Ensures sandbox cannot invoke web_search directly.
   */
  public async invokeTool(toolName: string, input: any, taskId: string, isSandbox: boolean = false): Promise<any> {
    if (this.sandboxInaccessibleTools.has(toolName) && isSandbox) {
      throw new Error(`Execution policy violation: ${toolName} is not accessible from inside the run_python sandbox.`);
    }

    if (toolName === 'web_search') {
      const searchOutput = await this.gateway.executeSearch(input, taskId);
      
      // Wrap in search-provenance envelope
      const envelope: SearchProvenanceEnvelope = {
        source: 'web_search',
        timestamp: new Date().toISOString(),
        query: input.query,
        provider: searchOutput.provider_used,
        data: searchOutput,
        tainted: true // Always tainted to prevent execution of untrusted system instructions
      };
      return envelope;
    }

    throw new Error(`Unknown tool: ${toolName}`);
  }
}

/**
 * Persists search results to MemoryStore, ensuring taint-tracking is propagated.
 */
export function persistToMemory(store: MemoryStore, key: string, envelope: SearchProvenanceEnvelope): void {
  store.storedItems.push({
    key,
    value: envelope.data,
    tainted: envelope.tainted,
    provenance: envelope.source
  });
}
