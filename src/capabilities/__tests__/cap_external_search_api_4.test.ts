import { describe, it, expect } from 'vitest';
import {
  SearchGateway,
  ToolRegistry,
  persistToMemory,
  MemoryStore
} from '../cap_external_search_api_4';

describe('cap_external_search_api_4: Controlled external search and API gateway', () => {
  
  it('web_search returns structured results with title, URL, snippet, and freshness_date', async () => {
    const gateway = new SearchGateway();
    const registry = new ToolRegistry(gateway);
    
    const envelope = await registry.invokeTool('web_search', {
      query: 'TypeScript features',
      provider: 'google',
      max_results: 1
    }, 'task-123', false);

    expect(envelope.source).toBe('web_search');
    expect(envelope.tainted).toBe(true);
    expect(envelope.data.provider_used).toBe('google');
    expect(envelope.data.results).toHaveLength(1);
    
    const firstResult = envelope.data.results[0];
    expect(firstResult).toHaveProperty('title');
    expect(firstResult).toHaveProperty('url');
    expect(firstResult).toHaveProperty('snippet');
    expect(firstResult).toHaveProperty('freshness_date');
  });

  it('attempt to invoke web_search from inside run_python sandbox is blocked at the registry boundary', async () => {
    const gateway = new SearchGateway();
    const registry = new ToolRegistry(gateway);

    await expect(
      registry.invokeTool('web_search', { query: 'any' }, 'task-123', true) // isSandbox = true
    ).rejects.toThrow('Execution policy violation: web_search is not accessible from inside the run_python sandbox.');
  });

  it('search queries containing secrets or violating content policies are rejected before dispatch', async () => {
    const gateway = new SearchGateway();
    const registry = new ToolRegistry(gateway);

    await expect(
      registry.invokeTool('web_search', { query: 'retrieve my secret_key now' }, 'task-123', false)
    ).rejects.toThrow('Search query contains forbidden terms or violates safety policies');
  });

  it('results containing malicious payloads or scripts are sanitized', async () => {
    const gateway = new SearchGateway();
    const registry = new ToolRegistry(gateway);

    const envelope = await registry.invokeTool('web_search', {
      query: 'some normal query',
      provider: 'tavily'
    }, 'task-456', false);

    const firstResult = envelope.data.results[0];
    // The default simulated content contains '<script>alert("xss")</script>'
    // It must be stripped/sanitized before delivery.
    expect(firstResult.snippet).not.toContain('<script>');
    expect(firstResult.snippet).not.toContain('javascript:');
    expect(firstResult.snippet).toContain('Check out  this cool TypeScript');
  });

  it('gateway enforces rate-limiting and backoff behavior on a per-task basis', async () => {
    const gateway = new SearchGateway(2); // max 2 requests
    const registry = new ToolRegistry(gateway);

    // First and second requests succeed
    await registry.invokeTool('web_search', { query: 'test 1' }, 'task-limit', false);
    await registry.invokeTool('web_search', { query: 'test 2' }, 'task-limit', false);

    // Third request fails due to rate limit
    await expect(
      registry.invokeTool('web_search', { query: 'test 3' }, 'task-limit', false)
    ).rejects.toThrow('Rate limit exceeded for task: task-limit. Please back off.');
  });

  it('results are automatically tagged with search provenance and marked tainted when stored in memory', async () => {
    const gateway = new SearchGateway();
    const registry = new ToolRegistry(gateway);
    const store: MemoryStore = { storedItems: [] };

    const envelope = await registry.invokeTool('web_search', {
      query: 'untainted request'
    }, 'task-789', false);

    expect(envelope.tainted).toBe(true);

    persistToMemory(store, 'search_1', envelope);

    expect(store.storedItems).toHaveLength(1);
    expect(store.storedItems[0].key).toBe('search_1');
    expect(store.storedItems[0].tainted).toBe(true);
    expect(store.storedItems[0].provenance).toBe('web_search');
  });
});
