import { SafeWebTransport, createProductionWebTransport } from './web_research_transport.js';

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchAdapter {
  search(canonicalQuery: string, count: number, signal: AbortSignal): Promise<WebSearchResultItem[]>;
}

export interface BraveWebSearchAdapterOptions {
  apiKey?: string;
  endpoint?: string;
  transport?: SafeWebTransport;
  timeoutMs?: number;
  maxPageBytes?: number;
}

function redactToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join('[REDACTED]');
}

export class BraveWebSearchAdapter implements WebSearchAdapter {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly transport: SafeWebTransport;
  private readonly timeoutMs: number;
  private readonly maxPageBytes: number;

  constructor(options: BraveWebSearchAdapterOptions = {}) {
    this.apiKey = options.apiKey ?? '';
    this.endpoint = options.endpoint ?? 'https://api.search.brave.com/res/v1/web/search';
    this.transport = options.transport ?? createProductionWebTransport();
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.maxPageBytes = options.maxPageBytes ?? 2 * 1024 * 1024;
  }

  async search(canonicalQuery: string, count: number, signal: AbortSignal): Promise<WebSearchResultItem[]> {
    if (!this.apiKey) {
      throw new Error('Brave Search API credentials unavailable/blocked');
    }

    const url = new URL(this.endpoint);
    url.searchParams.set('q', canonicalQuery);
    url.searchParams.set('count', String(count));

    let resp;
    try {
      resp = await this.transport.fetch({
        url: url.toString(),
        timeoutMs: this.timeoutMs,
        maxPageBytes: this.maxPageBytes,
        signal,
        acceptContentTypes: ['application/json'],
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': this.apiKey,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(redactToken(msg, this.apiKey));
    }

    if (!resp.ok) {
      const detail = resp.error ? `: ${redactToken(resp.error, this.apiKey)}` : '';
      throw new Error(`Brave Search request failed (${resp.statusCode ?? resp.code ?? 'unknown'})${detail}`);
    }

    let parsed: { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
    try {
      parsed = JSON.parse(resp.bodyText ?? '{}');
    } catch {
      throw new Error('Brave Search returned invalid JSON');
    }

    const rawResults = parsed?.web?.results;
    if (!Array.isArray(rawResults)) {
      return [];
    }

    return rawResults.map((item) => ({
      title: typeof item.title === 'string' ? item.title : '',
      url: typeof item.url === 'string' ? item.url : '',
      snippet: typeof item.description === 'string' ? item.description : '',
    }));
  }
}
