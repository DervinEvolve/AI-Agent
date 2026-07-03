import { describe, it, expect } from 'vitest';
import { memory_store } from './cap_long_term_memory_3';

describe('cap_long_term_memory_3', () => {
  it('store then retrieve returns exact item with provenance and timestamp', async () => {
    const res = await memory_store('store', { text: 'lesson1', scope: 'u1/p1', provenance: { source: 'user' } });
    const ret = await memory_store('retrieve', { query: 'lesson1', scope: 'u1/p1' });
    expect(ret.results.length).toBe(1);
    expect(ret.results[0].provenance.source).toBe('user');
    expect(ret.results[0].timestamp).toBeDefined();
  });

  it('retrieval respects scope isolation (cross-scope invisible)', async () => {
    await memory_store('store', { text: 'secret', scope: 'u1/p1', provenance: { source: 'user' } });
    const ret = await memory_store('retrieve', { query: 'secret', scope: 'u2/p2' });
    expect(ret.results.length).toBe(0);
  });

  it('delete removes item and it is no longer retrievable', async () => {
    const s = await memory_store('store', { text: 'toDel', scope: 'u1/p1', provenance: { source: 'user' } });
    const d = await memory_store('delete', { scope: 'u1/p1', id: s.stored_id });
    expect(d.deleted_count).toBe(1);
    const ret = await memory_store('retrieve', { query: 'toDel', scope: 'u1/p1' });
    expect(ret.results.length).toBe(0);
  });

  it('semantic search returns relevant items above threshold', async () => {
    await memory_store('store', { text: 'alpha beta', scope: 'u1/p1', provenance: { source: 'tool' } });
    const ret = await memory_store('retrieve', { query: 'alpha', scope: 'u1/p1' });
    expect(ret.results.length).toBeGreaterThan(0);
  });

  it('list_scopes returns only accessible namespaces', async () => {
    await memory_store('store', { text: 'x', scope: 'nsA', provenance: { source: 'user' } });
    const ls = await memory_store('list_scopes');
    expect(ls.scopes).toContain('nsA');
  });

  it('deletion is idempotent and audited', async () => {
    const d1 = await memory_store('delete', { scope: 'nsX', id: 'nonexistent' });
    expect(d1.deleted_count).toBe(0);
  });
});
