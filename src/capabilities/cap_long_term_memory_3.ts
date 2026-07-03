type Scope = string;
type Provenance = { source: string; [key: string]: any };
type MemoryItem = {
  id: string;
  text: string;
  scope: Scope;
  provenance: Provenance;
  created_at: string;
  last_verified_at: string;
  tags?: string[];
};

const store = new Map<Scope, MemoryItem[]>();

function getNamespace(scope: Scope): MemoryItem[] {
  if (!store.has(scope)) store.set(scope, []);
  return store.get(scope)!;
}

export async function memory_store(operation: 'store' | 'retrieve' | 'delete' | 'list_scopes', payload: any = {}) {
  if (operation === 'store') {
    const { text, scope, provenance, tags } = payload;
    if (!text || !scope || !provenance) throw new Error('Missing required fields');
    if (!provenance.source) throw new Error('Provenance must include source');
    const now = new Date().toISOString();
    const item: MemoryItem = {
      id: Math.random().toString(36).slice(2),
      text,
      scope,
      provenance,
      created_at: now,
      last_verified_at: now,
      tags,
    };
    getNamespace(scope).push(item);
    return { stored_id: item.id };
  }
  if (operation === 'retrieve') {
    const { query, scope, max_results = 10 } = payload;
    let items: MemoryItem[] = scope ? (store.get(scope) || []) : ([] as MemoryItem[]).concat(...store.values());
    // simple semantic: filter by query inclusion
    if (typeof query === 'string') {
      items = items.filter(i => i.text.includes(query));
    }
    items = items.slice(0, max_results);
    return {
      results: items.map(i => ({
        id: i.id,
        text: i.text,
        scope: i.scope,
        provenance: i.provenance,
        timestamp: i.created_at,
        freshness_score: 1.0,
      })),
    };
  }
  if (operation === 'delete') {
    const { scope, id } = payload;
    const ns = store.get(scope) || [];
    const before = ns.length;
    const filtered = ns.filter(i => i.id !== id);
    store.set(scope, filtered);
    return { deleted_count: before - filtered.length };
  }
  if (operation === 'list_scopes') {
    return { scopes: Array.from(store.keys()) };
  }
  throw new Error('Unknown operation');
}

export const cap_long_term_memory_3 = {
  id: 'cap_long_term_memory_3',
  name: 'Scoped long-term memory and retrieval',
  tool_name: 'memory_store',
  invoke: memory_store,
};
