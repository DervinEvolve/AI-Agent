import {
  MAX_UNTRUSTED_DESCRIPTION_BYTES,
  ToolCatalogEntry,
  ToolSearchResultItem,
  UNTRUSTED_ORIGIN_BEHAVIOR,
} from './types.js';

export function tokenizeIdentifier(text: string): string[] {
  if (!text) return [];
  const split = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-./:]+/g, ' ');
  return split
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

export function computeBm25FieldScore(
  queryTokens: string[],
  docsTokens: string[][],
  docIndex: number,
  k1 = 1.2,
  b = 0.75
): number {
  const N = docsTokens.length;
  if (N === 0 || queryTokens.length === 0) return 0;

  const doc = docsTokens[docIndex] ?? [];
  if (doc.length === 0) return 0;

  let totalLen = 0;
  for (const d of docsTokens) totalLen += d.length;
  const avgdl = totalLen / N;
  if (avgdl === 0) return 0;

  const tfMap = new Map<string, number>();
  for (const t of doc) {
    tfMap.set(t, (tfMap.get(t) ?? 0) + 1);
  }

  let score = 0;
  const uniqueQuery = new Set(queryTokens);
  for (const qt of uniqueQuery) {
    const tf = tfMap.get(qt) ?? 0;
    if (tf === 0) continue;

    let df = 0;
    for (const d of docsTokens) {
      if (d.includes(qt)) df++;
    }
    // Lucene-style smoothed IDF to avoid negative values on small corpora
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const denom = tf + k1 * (1 - b + b * (doc.length / avgdl));
    score += idf * ((tf * (k1 + 1)) / denom);
  }
  return score;
}

export function truncateUtf8Bytes(input: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(input);
  if (bytes.length <= maxBytes) return input;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return decoder.decode(bytes.subarray(0, maxBytes));
}

export function rankCatalog(
  query: string,
  entries: ToolCatalogEntry[],
  loadedSet: Set<string>,
  limit: number
): { items: ToolSearchResultItem[]; totalMatches: number } {
  const queryTokens = tokenizeIdentifier(query);
  const qLower = query.toLowerCase();

  const nameDocs = entries.map((e) => tokenizeIdentifier(e.tool_name));
  const tagDocs = entries.map((e) => (e.host_tags ?? []).flatMap(tokenizeIdentifier));
  const propDocs = entries.map((e) => {
    const props = e.property_names ?? Object.keys((e.parameters?.properties as Record<string, unknown>) ?? {});
    return props.flatMap(tokenizeIdentifier);
  });

  const scored = entries.map((entry, idx) => {
    const nameLower = entry.tool_name.toLowerCase();
    const nameHit = nameLower === qLower || nameLower.includes(qLower) ? 1 : 0;
    const bm25Name = computeBm25FieldScore(queryTokens, nameDocs, idx);
    const bm25Tags = computeBm25FieldScore(queryTokens, tagDocs, idx);
    const bm25Props = computeBm25FieldScore(queryTokens, propDocs, idx);
    const score = 8 * bm25Name + 4 * bm25Tags + 1 * bm25Props;
    return { entry, nameHit, score };
  });

  const matches = scored.filter((s) => s.nameHit > 0 || s.score > 0);
  matches.sort((a, b) => {
    if (b.nameHit !== a.nameHit) return b.nameHit - a.nameHit;
    if (b.score !== a.score) return b.score - a.score;
    return a.entry.tool_name.localeCompare(b.entry.tool_name);
  });

  const sliced = matches.slice(0, limit).map((m) => ({
    tool_name: m.entry.tool_name,
    score: Number(m.score.toFixed(6)),
    loaded: loadedSet.has(m.entry.tool_name),
    untrusted_metadata: {
      origin: UNTRUSTED_ORIGIN_BEHAVIOR,
      description: truncateUtf8Bytes(m.entry.description ?? '', MAX_UNTRUSTED_DESCRIPTION_BYTES),
    },
  }));

  return { items: sliced, totalMatches: matches.length };
}
