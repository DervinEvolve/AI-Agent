/*
 * cap_knowledge_retrieval_mount_32
 *
 * Repository-backed, zero-dependency lexical knowledge retrieval over a host-supplied
 * knowledge base. This module is deterministic and standard-library-only. It does not
 * perform network access or embed any external inference dependency.
 *
 * The mount is intentionally repository-safe: unlike isolated Python or Docker mounts,
 * it can run anywhere the TypeScript runtime runs, including CI.
 */

/** Maximum number of Unicode code points in a single passage. */
export const MAX_PASSAGE_CODE_POINTS = 512;

/** Maximum accepted query length in code points. */
export const MAX_QUERY_CODE_POINTS = 512;

/** Default number of passages returned by search_knowledge. */
export const DEFAULT_TOP_K = 5;

/** Minimum accepted top_k. */
export const MIN_TOP_K = 1;

/** Maximum accepted top_k. */
export const MAX_TOP_K = 20;

/** Host-pinned corpus bounds, kept as constants so tests and callers can import them. */
export const CORPUS_LIMITS = Object.freeze({
  maxCorpusBytes: 1024 * 1024,
  maxDocuments: 64,
  maxDocumentBytes: 256 * 1024,
  maxPassages: 4096,
} as const);

const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Pinned tokenizer: lowercase then Unicode letters, numbers, and underscore. */
const TOKEN_PATTERN = /[\p{L}\p{N}_]+/gu;

function tokenize(input: string): string[] {
  return input.toLowerCase().match(TOKEN_PATTERN) ?? [];
}

function utf8ByteLength(input: string): number {
  let bytes = 0;
  for (const ch of input) {
    const codePoint = ch.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}

function hasLoneSurrogate(input: string): boolean {
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareSourceIds(a: string, b: string): number {
  // ECMAScript < and > compare UTF-16 code units, which is the pinned tie order.
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export interface KnowledgeBaseSource {
  source_id: string;
  text: string;
}

export interface Passage {
  passage_id: string;
  source_id: string;
  char_start: number;
  char_end: number;
  text: string;
}

export interface KnowledgeBaseCorpus {
  readonly sources: readonly KnowledgeBaseSource[];
  readonly passages: readonly Passage[];
}

export type KnowledgeBaseBlockerCode =
  | 'duplicate_source_id'
  | 'invalid_source_id'
  | 'text_not_string'
  | 'text_empty'
  | 'text_contains_nul'
  | 'text_contains_lone_surrogate'
  | 'corpus_too_large'
  | 'document_too_large'
  | 'too_many_documents'
  | 'too_many_passages';

export type KnowledgeBaseMountResult =
  | { status: 'mounted'; knowledgeBase: KnowledgeBase }
  | { status: 'unavailable'; blockerCode: KnowledgeBaseBlockerCode };

export class KnowledgeBase {
  readonly corpus: KnowledgeBaseCorpus;
  private readonly passageById: Map<string, Passage>;

  constructor(corpus: KnowledgeBaseCorpus) {
    this.corpus = corpus;
    this.passageById = new Map();
    for (const passage of corpus.passages) {
      this.passageById.set(passage.passage_id, passage);
    }
  }

  resolve(passage_id: string): Passage | undefined {
    return this.passageById.get(passage_id);
  }

  /**
   * Ingest a host-supplied corpus. Inputs are copied and frozen, so later mutation of
   * the caller's arrays or objects has no effect on search or recall.
   */
  static ingest(input: unknown): KnowledgeBaseMountResult {
    if (!Array.isArray(input)) {
      return { status: 'unavailable', blockerCode: 'invalid_source_id' };
    }

    if (input.length > CORPUS_LIMITS.maxDocuments) {
      return { status: 'unavailable', blockerCode: 'too_many_documents' };
    }

    const sources: KnowledgeBaseSource[] = [];
    const seenSourceIds = new Set<string>();
    let totalCorpusBytes = 0;
    let totalPassageCount = 0;

    for (const entry of input) {
      if (!isRecord(entry)) {
        return { status: 'unavailable', blockerCode: 'invalid_source_id' };
      }

      const source_id = entry.source_id;
      const text = entry.text;

      if (typeof source_id !== 'string' || !SOURCE_ID_PATTERN.test(source_id)) {
        return { status: 'unavailable', blockerCode: 'invalid_source_id' };
      }

      if (seenSourceIds.has(source_id)) {
        return { status: 'unavailable', blockerCode: 'duplicate_source_id' };
      }
      seenSourceIds.add(source_id);

      if (typeof text !== 'string') {
        return { status: 'unavailable', blockerCode: 'text_not_string' };
      }

      if (text.length === 0) {
        return { status: 'unavailable', blockerCode: 'text_empty' };
      }

      if (text.includes('\u0000')) {
        return { status: 'unavailable', blockerCode: 'text_contains_nul' };
      }

      if (hasLoneSurrogate(text)) {
        return { status: 'unavailable', blockerCode: 'text_contains_lone_surrogate' };
      }

      const documentBytes = utf8ByteLength(text);
      if (documentBytes > CORPUS_LIMITS.maxDocumentBytes) {
        return { status: 'unavailable', blockerCode: 'document_too_large' };
      }

      totalCorpusBytes += documentBytes;
      if (totalCorpusBytes > CORPUS_LIMITS.maxCorpusBytes) {
        return { status: 'unavailable', blockerCode: 'corpus_too_large' };
      }

      const codePoints = Array.from(text);
      const passageCount = Math.ceil(codePoints.length / MAX_PASSAGE_CODE_POINTS);
      totalPassageCount += passageCount;
      if (totalPassageCount > CORPUS_LIMITS.maxPassages) {
        return { status: 'unavailable', blockerCode: 'too_many_passages' };
      }

      sources.push({ source_id, text });
    }

    const passages: Passage[] = [];
    for (const source of sources) {
      const codePoints = Array.from(source.text);
      for (let start = 0; start < codePoints.length; start += MAX_PASSAGE_CODE_POINTS) {
        const end = Math.min(start + MAX_PASSAGE_CODE_POINTS, codePoints.length);
        const passageText = codePoints.slice(start, end).join('');
        const passage: Passage = Object.freeze({
          passage_id: `${source.source_id}#${start}-${end}`,
          source_id: source.source_id,
          char_start: start,
          char_end: end,
          text: passageText,
        });
        passages.push(passage);
      }
    }

    const frozenSources: readonly KnowledgeBaseSource[] = Object.freeze(
      sources.map((source) => Object.freeze({ ...source })),
    );
    const frozenPassages: readonly Passage[] = Object.freeze(passages);
    const corpus: KnowledgeBaseCorpus = Object.freeze({
      sources: frozenSources,
      passages: frozenPassages,
    });

    return { status: 'mounted', knowledgeBase: new KnowledgeBase(corpus) };
  }
}

/** Exported alias to match the spec's language around ingestion. */
export const ingestKnowledgeBase = KnowledgeBase.ingest.bind(KnowledgeBase);

export interface PassageMatch extends Passage {
  score: number;
}

export interface RetrievalIndex {
  search(query: string, topK: number): PassageMatch[];
}

/**
 * Deterministic lexical BM25 index.
 *
 * k1 = 1.2, b = 0.75. IDF is ln(1 + (N - df + 0.5)/(df + 0.5)), where N is the
 * number of passages. Query terms are deduplicated and each counted once.
 */
export class Bm25Index implements RetrievalIndex {
  private readonly passages: readonly Passage[];
  private readonly documentFrequency: Map<string, number>;
  private readonly termFrequencyByPassage: Map<string, number>[];
  private readonly documentLengths: number[];
  private readonly averageDocumentLength: number;
  private readonly passageCount: number;
  private readonly k1 = 1.2;
  private readonly b = 0.75;

  constructor(corpus: KnowledgeBaseCorpus) {
    this.passages = corpus.passages;
    this.passageCount = this.passages.length;
    this.documentFrequency = new Map();
    this.termFrequencyByPassage = [];
    this.documentLengths = [];

    let totalLength = 0;
    for (const passage of this.passages) {
      const terms = tokenize(passage.text);
      this.documentLengths.push(terms.length);
      totalLength += terms.length;

      const termCounts = new Map<string, number>();
      const localTerms = new Set<string>();
      for (const term of terms) {
        termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
        localTerms.add(term);
      }
      this.termFrequencyByPassage.push(termCounts);

      for (const term of localTerms) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      }
    }

    this.averageDocumentLength =
      this.passageCount === 0 ? 0 : totalLength / this.passageCount;
  }

  search(query: string, topK: number): PassageMatch[] {
    const queryTerms = Array.from(new Set(tokenize(query)));
    if (queryTerms.length === 0 || this.passageCount === 0) {
      return [];
    }

    const matches: PassageMatch[] = [];
    const avgdl = this.averageDocumentLength;

    for (let index = 0; index < this.passages.length; index += 1) {
      const passage = this.passages[index];
      const termCounts = this.termFrequencyByPassage[index];
      const dl = this.documentLengths[index];
      let score = 0;

      for (const term of queryTerms) {
        const df = this.documentFrequency.get(term);
        const tf = termCounts.get(term);
        if (df === undefined || tf === undefined) continue;

        const idf = Math.log(1 + (this.passageCount - df + 0.5) / (df + 0.5));
        const denominator = tf + this.k1 * (1 - this.b + this.b * (dl / avgdl));
        score += idf * ((tf * (this.k1 + 1)) / denominator);
      }

      if (score > 0) {
        matches.push({
          ...passage,
          score,
        });
      }
    }

    matches.sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (scoreDelta !== 0) return scoreDelta;
      const sourceDelta = compareSourceIds(a.source_id, b.source_id);
      if (sourceDelta !== 0) return sourceDelta;
      return a.char_start - b.char_start;
    });

    return matches.slice(0, topK);
  }
}

export const searchKnowledgeSchema = Object.freeze({
  type: 'object',
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_QUERY_CODE_POINTS,
    },
    top_k: {
      type: 'integer',
      minimum: MIN_TOP_K,
      maximum: MAX_TOP_K,
    },
  },
  required: ['query'],
  additionalProperties: false,
} as const);

export interface SearchKnowledgeSuccessOutput {
  ok: true;
  passages: PassageMatch[];
}

export interface SearchKnowledgeNoTokensOutput {
  ok: false;
  code: 'no_query_tokens';
}

export type SearchKnowledgeOutput =
  | SearchKnowledgeSuccessOutput
  | SearchKnowledgeNoTokensOutput;

export type SearchKnowledgeExecutionResult =
  | {
      started: false;
      status: 'invalid_args';
      output: { ok: false; code: 'invalid_args' };
    }
  | {
      started: true;
      status: 'ok';
      output: SearchKnowledgeOutput;
    };

export interface SearchKnowledgeToolResult {
  call_id: string;
  tool_name: 'search_knowledge';
  started: boolean;
  status: string;
  output?: SearchKnowledgeOutput | { ok: false; code: string };
}

function isPassageMatch(value: unknown): value is PassageMatch {
  if (!isRecord(value)) return false;
  return (
    typeof value.passage_id === 'string' &&
    typeof value.source_id === 'string' &&
    typeof value.char_start === 'number' &&
    Number.isInteger(value.char_start) &&
    typeof value.char_end === 'number' &&
    Number.isInteger(value.char_end) &&
    typeof value.score === 'number' &&
    Number.isFinite(value.score) &&
    typeof value.text === 'string'
  );
}

export type SearchKnowledgeClassification = 'success' | 'known_failure' | 'unknown';

/**
 * Classifier registered on the shared OutcomeClassifier for search_knowledge.
 *
 * Success requires outer status = ok and output.ok === true with a well-formed
 * passages array. Outer ok with output.ok === false or a malformed report is a
 * known failure. An outer timeout is unknown.
 */
export function classifySearchKnowledge(result: unknown): SearchKnowledgeClassification {
  if (!isRecord(result)) return 'unknown';

  if (result.status === 'timeout') return 'unknown';
  if (result.status !== 'ok') return 'unknown';

  const output = result.output;
  if (!isRecord(output) || typeof output.ok !== 'boolean') return 'known_failure';
  if (output.ok === false) return 'known_failure';
  if (!Array.isArray(output.passages)) return 'known_failure';
  if (!output.passages.every(isPassageMatch)) return 'known_failure';
  return 'success';
}

function invalidArgsResult(): SearchKnowledgeExecutionResult {
  return {
    started: false,
    status: 'invalid_args',
    output: { ok: false, code: 'invalid_args' },
  };
}

export function normalizeTopK(topK: unknown): number | undefined {
  if (topK === undefined) return DEFAULT_TOP_K;
  if (typeof topK !== 'number' || !Number.isInteger(topK)) return undefined;
  if (topK < MIN_TOP_K || topK > MAX_TOP_K) return undefined;
  return topK;
}

/**
 * Execute a search_knowledge call against an index. The result is deterministic for
 * a given index and query. Schema violations produce started=false invalid_args.
 */
export function executeSearchKnowledge(
  index: RetrievalIndex,
  args: unknown,
): SearchKnowledgeExecutionResult {
  if (!isRecord(args) || typeof args.query !== 'string') {
    return invalidArgsResult();
  }

  const queryCodePoints = Array.from(args.query).length;
  if (queryCodePoints < 1 || queryCodePoints > MAX_QUERY_CODE_POINTS) {
    return invalidArgsResult();
  }

  const topK = normalizeTopK(args.top_k);
  if (topK === undefined) {
    return invalidArgsResult();
  }

  if (tokenize(args.query).length === 0) {
    return {
      started: true,
      status: 'ok',
      output: { ok: false, code: 'no_query_tokens' },
    };
  }

  return {
    started: true,
    status: 'ok',
    output: {
      ok: true,
      passages: index.search(args.query, topK),
    },
  };
}

/**
 * Tool definition compatible with the runtime's registry shape. It is intentionally
 * read-only and idempotent: repeated calls with the same query return the same result.
 */
export function createSearchKnowledgeTool(index: RetrievalIndex) {
  return {
    name: 'search_knowledge',
    description:
      'Search a read-only, host-supplied knowledge base with BM25 lexical retrieval. ' +
      'Returns ranked complete passages. The result is provenance-only evidence and ' +
      'does not grade entailment.',
    schema: searchKnowledgeSchema,
    idempotent: true,
    call: (args: unknown): Promise<SearchKnowledgeExecutionResult> =>
      Promise.resolve(executeSearchKnowledge(index, args)),
  };
}

export interface RecordedSearchResult {
  call_id: string;
  tool_name?: string;
  started?: boolean;
  status?: string;
  output?: unknown;
}

export interface CitationShape2Context {
  getToolResult(callId: string): RecordedSearchResult | undefined;
  resolvePassage(passageId: string): Passage | undefined;
}

export type CitationShape2FailureReason =
  | 'invalid_citation'
  | 'unknown_call_id'
  | 'tool_mismatch'
  | 'search_failed'
  | 'unknown_passage_id'
  | 'passage_mismatch';

export type CitationShape2ValidationResult =
  | { valid: true; passage: Passage; result: RecordedSearchResult }
  | { valid: false; reason: CitationShape2FailureReason };

/**
 * Citation shape 2 is provenance-only, never entailment.
 *
 * { call_id, passage_id } is valid iff the call is a successful search_knowledge
 * result in the current run, the passage appears in that result, and the knowledge
 * base resolves the passage to the same frozen content.
 */
export function validateCitationShape2(
  citation: unknown,
  context: CitationShape2Context,
): CitationShape2ValidationResult {
  if (!isRecord(citation)) {
    return { valid: false, reason: 'invalid_citation' };
  }

  const call_id = citation.call_id;
  const passage_id = citation.passage_id;
  if (typeof call_id !== 'string' || call_id.length === 0 || typeof passage_id !== 'string' || passage_id.length === 0) {
    return { valid: false, reason: 'invalid_citation' };
  }

  const result = context.getToolResult(call_id);
  if (!result) {
    return { valid: false, reason: 'unknown_call_id' };
  }

  if (result.tool_name !== 'search_knowledge') {
    return { valid: false, reason: 'tool_mismatch' };
  }

  const classification = classifySearchKnowledge(result);
  if (result.started !== true || classification !== 'success') {
    return { valid: false, reason: 'search_failed' };
  }

  const output = result.output;
  if (!isRecord(output) || output.ok !== true || !Array.isArray(output.passages)) {
    return { valid: false, reason: 'search_failed' };
  }

  const matchedPassage = output.passages.find(
    (passage): passage is PassageMatch =>
      isPassageMatch(passage) && passage.passage_id === passage_id,
  );
  if (!matchedPassage) {
    return { valid: false, reason: 'unknown_passage_id' };
  }

  const resolved = context.resolvePassage(passage_id);
  if (!resolved) {
    return { valid: false, reason: 'unknown_passage_id' };
  }

  if (
    matchedPassage.source_id !== resolved.source_id ||
    matchedPassage.char_start !== resolved.char_start ||
    matchedPassage.char_end !== resolved.char_end ||
    matchedPassage.text !== resolved.text
  ) {
    return { valid: false, reason: 'passage_mismatch' };
  }

  return { valid: true, passage: resolved, result };
}

/**
 * Convenience validation path for tests and adapters that already have an array of
 * recorded results and a KnowledgeBase, rather than a general CitationShape2Context.
 */
export function validateCitationShape2AgainstRun(
  citation: unknown,
  results: readonly RecordedSearchResult[],
  knowledgeBase: KnowledgeBase,
): CitationShape2ValidationResult {
  const byCallId = new Map<string, RecordedSearchResult>();
  for (const result of results) {
    if (typeof result.call_id === 'string') {
      byCallId.set(result.call_id, result);
    }
  }
  return validateCitationShape2(citation, {
    getToolResult: (callId) => byCallId.get(callId),
    resolvePassage: (passageId) => knowledgeBase.resolve(passageId),
  });
}

export interface KnowledgeRetrievalMountHost {
  registerTool?(tool: unknown): void;
  registerCitationShape?(shape: number, validator: unknown): void;
  registerClassifier?(toolName: string, classifier: (result: unknown) => SearchKnowledgeClassification): void;
  setCapability?(key: string, status: string): void;
  publishToolSchema?(toolName: string, schema: unknown): void;
}

/**
 * Mount the retrieval capability when a HostConfig.knowledgeBase corpus is supplied.
 *
 * The implementation here is host-agnostic so it can be wired into the runtime's
 * existing boundary without importing internals from this capability module. On an
 * invalid corpus, search_knowledge must remain unavailable and nothing is partially
 * ingested.
 */
export function mountKnowledgeRetrievalMount(
  host: KnowledgeRetrievalMountHost | undefined | null,
  corpusInput: unknown,
): KnowledgeBaseMountResult {
  const ingestResult = KnowledgeBase.ingest(corpusInput);

  if (!host) {
    return ingestResult;
  }

  if (ingestResult.status === 'unavailable') {
    host.setCapability?.('search_knowledge', 'unavailable');
    return ingestResult;
  }

  host.setCapability?.('search_knowledge', 'mounted');
  host.publishToolSchema?.('search_knowledge', searchKnowledgeSchema);
  host.registerClassifier?.('search_knowledge', classifySearchKnowledge);
  host.registerCitationShape?.(2, validateCitationShape2);
  host.registerTool?.(
    createSearchKnowledgeTool(new Bm25Index(ingestResult.knowledgeBase.corpus)),
  );

  return ingestResult;
}

export type { RecordedSearchResult as KnowledgeSearchRecord };
