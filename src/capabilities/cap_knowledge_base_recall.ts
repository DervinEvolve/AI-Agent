/**
 * Capability: Knowledge Base Recall (cap_knowledge_base_recall)
 *
 * A pure, deterministic retrieval ranker for the agent's KnowledgeBase.
 * Design follows the BM25-style relevanceRanker pattern: the ENTIRE corpus is
 * scored before sorting (stable tiebreak on document id), so ranking is never
 * vulnerable to first-match / early-exit bias. When the correct answer lives
 * in a later document, it must still win on relevance score.
 *
 * Scoring per query term t in document d:
 *   idf(t) = ln(1 + (N - df + 0.5) / (df + 0.5))
 *   tf_component = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * len/avgLen))
 *   score += idf(t) * tf_component
 *
 * A margin-ratio discrimination guard suppresses ambiguous returns: if the
 * top score is not clearly separated from the runner-up, retrieval reports a
 * low-confidence result rather than pretending a noisy hit is the answer.
 */

export interface KnowledgeDocument {
  id: string;
  content: string;
  /** Optional metadata bag; not used in scoring. */
  metadata?: Record<string, unknown>;
}

export interface ScoredDocument {
  id: string;
  content: string;
  score: number;
  rank: number;
}

export interface RecallResult {
  /** Top-1 document, or null when nothing clears the discrimination guard. */
  top: ScoredDocument | null;
  ranked: ScoredDocument[];
  /** True when the top result cleared the margin guard. */
  confident: boolean;
  query: string;
}

export interface RankOptions {
  /** BM25 term-frequency saturation (default 1.2). */
  k1?: number;
  /** BM25 length normalization (default 0.75). */
  b?: number;
  /** Minimum idf-weighted coverage of the query by the top doc. */
  minScore?: number;
  /** Required score ratio top/(runner-up) to be "confident" (default 1.25). */
  marginRatio?: number;
}

const DEFAULT_K1 = 1.2;
const DEFAULT_B = 0.75;
const DEFAULT_MIN_SCORE = 0.35;
const DEFAULT_MARGIN_RATIO = 1.25;

const STOPWORDS = new Set([
  "a", "an", "the", "of", "is", "are", "was", "were", "in", "on", "at",
  "to", "and", "or", "for", "with", "by", "as", "it", "its", "that",
  "this", "be", "been", "what", "which", "who", "how", "when", "where",
  "why", "do", "does", "did", "can", "could", "will", "would", "from",
]);

/** Lowercase, strip non-alphanumerics, drop stopwords. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Score the whole corpus against the query. Pure and deterministic:
 * every document is scored, then sorted by (score desc, id asc).
 */
export function rankDocuments(
  query: string,
  corpus: KnowledgeDocument[],
  options: RankOptions = {},
): ScoredDocument[] {
  const k1 = options.k1 ?? DEFAULT_K1;
  const b = options.b ?? DEFAULT_B;
  const queryTerms = tokenize(query);

  if (queryTerms.length === 0 || corpus.length === 0) return [];

  // Precompute document term frequencies and lengths.
  const docTerms = corpus.map((doc) => tokenize(doc.content));
  const docTfs = docTerms.map((terms) => {
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    return tf;
  });
  const docLens = docTerms.map((terms) => terms.length);
  const avgLen =
    docLens.reduce((sum, l) => sum + l, 0) / Math.max(docLens.length, 1) || 1;

  // Document frequency per unique query term.
  const uniqueQueryTerms = Array.from(new Set(queryTerms));
  const df = new Map<string, number>();
  for (const term of uniqueQueryTerms) {
    let count = 0;
    for (const tfs of docTfs) if (tfs.has(term)) count += 1;
    df.set(term, count);
  }

  const N = corpus.length;
  const scores = corpus.map((doc, i) => {
    let score = 0;
    const len = docLens[i];
    const norm = k1 * (1 - b + (b * len) / avgLen);
    for (const term of uniqueQueryTerms) {
      const tf = docTfs[i].get(term) ?? 0;
      if (tf === 0) continue;
      const dfT = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - dfT + 0.5) / (dfT + 0.5));
      const tfComponent = (tf * (k1 + 1)) / (tf + norm);
      score += idf * tfComponent;
    }
    return score;
  });

  const scored: ScoredDocument[] = corpus.map((doc, i) => ({
    id: doc.id,
    content: doc.content,
    score: scores[i],
    rank: 0,
  }));

  // Full-corpus sort: score desc, then stable tiebreak on id asc.
  scored.sort((x, y) =>
    y.score - x.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  );
  scored.forEach((doc, i) => (doc.rank = i + 1));
  return scored;
}

/**
 * Recall the most relevant passage for a query. Never returns on first
 * match: the entire corpus is scored and sorted before selection.
 */
export function recall(
  query: string,
  corpus: KnowledgeDocument[],
  options: RankOptions = {},
): RecallResult {
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const marginRatio = options.marginRatio ?? DEFAULT_MARGIN_RATIO;

  const ranked = rankDocuments(query, corpus, options);
  if (ranked.length === 0) {
    return { top: null, ranked, confident: false, query };
  }

  const top = ranked[0];
  const runnerUp = ranked[1];

  const clearsFloor = top.score >= minScore;
  const clearsMargin =
    runnerUp === undefined ||
    top.score >= marginRatio * Math.max(runnerUp.score, Number.EPSILON);

  return {
    top: clearsFloor ? top : null,
    ranked,
    confident: clearsFloor && clearsMargin,
    query,
  };
}

/**
 * KnowledgeBase: a tiny in-memory corpus wrapper around the ranker.
 */
export class KnowledgeBase {
  private docs: KnowledgeDocument[] = new Map<string, KnowledgeDocument>() as never;
  private store: Map<string, KnowledgeDocument> = new Map<string, KnowledgeDocument>();

  constructor(initial: KnowledgeDocument[] = []) {
    for (const doc of initial) this.add(doc);
  }

  add(doc: KnowledgeDocument): void {
    this.store.set(doc.id, doc);
  }

  get(id: string): KnowledgeDocument | undefined {
    return this.store.get(id);
  }

  all(): KnowledgeDocument[] {
    return Array.from(this.store.values());
  }

  get size(): number {
    return this.store.size;
  }

  recall(query: string, options?: RankOptions): RecallResult {
    return recall(query, this.all(), options);
  }

  rank(query: string, options?: RankOptions): ScoredDocument[] {
    return rankDocuments(query, this.all(), options);
  }
}
