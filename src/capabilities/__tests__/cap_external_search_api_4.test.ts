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

  it('results containing malicious payloads or executable scripts are stripped/sanitized before observation delivery', async () => {
    const gateway = new SearchGateway();
    const registry = new ToolRegistry(gateway);

    const envelope = await registry.invokeTool('web_search', {
      query: 'exploit testing'
    }, 'task-123', false);

    const snippet = envelope.data.results[0].snippet;
    // The mock raw snippet contains script tags: <script>alert("malicious")</script>
    expect(snippet).not.toContain('<script>');
    expect(snippet).not.toContain('</script>');
  });

  it('gateway enforces strict rate-limits and backoff behavior on a per-task basis', async () => {
    const gateway = new SearchGateway(2); // Limit to 2 requests
    const registry = new ToolRegistry(gateway);

    // Request 1
    await registry.invokeTool('web_search', { query: 'query1' }, 'task-rate', false);
    // Request 2
    await registry.invokeTool('web_search', { query: 'query2' }, 'task-rate', false);
    
    // Request 3 should fail
    await expect(
      registry.invokeTool('web_search', { query: 'query3' }, 'task-rate', false)
    ).rejects.toThrow('Rate limit exceeded for task task-rate');
  });

  it('results are automatically tagged with search provenance and marked tainted when stored in memory', async () => {
    const gateway = new SearchGateway();
    const registry = new ToolRegistry(gateway);
    
    const envelope = await registry.invokeTool('web_search', {
      query: 'safe search query'
    }, 'task-999', false);

    const mockMemoryStore: MemoryStore = { storedItems: [] };
    persistToMemory(mockMemoryStore, 'search_cache_1', envelope);

    expect(mockMemoryStore.storedItems).toHaveLength(1);
    const stored = mockMemoryStore.storedItems[0];
    expect(stored.key).toBe('search_cache_1');
    expect(stored.tainted).toBe(true);
    expect(stored.provenance).toBe('web_search');
  });
});
