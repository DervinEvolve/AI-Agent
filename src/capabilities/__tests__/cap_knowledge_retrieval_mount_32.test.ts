import {
  Bm25Index,
  CORPUS_LIMITS,
  KnowledgeBase,
  classifySearchKnowledge,
  createSearchKnowledgeTool,
  executeSearchKnowledge,
  mountKnowledgeRetrievalMount,
  normalizeTopK,
  searchKnowledgeSchema,
  validateCitationShape2,
  validateCitationShape2AgainstRun,
} from '../cap_knowledge_retrieval_mount_32';

describe('cap_knowledge_retrieval_mount_32', () => {
  describe('KnowledgeBase ingestion', () => {
    it('mounts an empty valid corpus and returns passages=[] for any query', () => {
      const ingested = KnowledgeBase.ingest([]);
      expect(ingested.status).toBe('mounted');
      if (ingested.status !== 'mounted') throw new Error('unreachable');

      const index = new Bm25Index(ingested.knowledgeBase.corpus);
      const result = executeSearchKnowledge(index, { query: 'anything' });
      expect(result.started).toBe(true);
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.output).toEqual({ ok: true, passages: [] });
      }
    });

    it('rejects invalid corpora whole with bounded blocker codes', () => {
      expect(KnowledgeBase.ingest([
        { source_id: 'dup', text: 'a' },
        { source_id: 'dup', text: 'b' },
      ])).toEqual({ status: 'unavailable', blockerCode: 'duplicate_source_id' });

      expect(KnowledgeBase.ingest([{ source_id: 'ok', text: 'has \u0000 nul' }]))
        .toEqual({ status: 'unavailable', blockerCode: 'text_contains_nul' });

      expect(KnowledgeBase.ingest([{ source_id: 'ok', text: 'lone \ud800 surrogate' }]))
        .toEqual({ status: 'unavailable', blockerCode: 'text_contains_lone_surrogate' });

      expect(KnowledgeBase.ingest([{ source_id: 'ok', text: '' }]))
        .toEqual({ status: 'unavailable', blockerCode: 'text_empty' });

      expect(KnowledgeBase.ingest([{ source_id: 'ok', text: 123 }]))
        .toEqual({ status: 'unavailable', blockerCode: 'text_not_string' });

      expect(KnowledgeBase.ingest([{ source_id: 'bad space', text: 'a' }]))
        .toEqual({ status: 'unavailable', blockerCode: 'invalid_source_id' });

      expect(KnowledgeBase.ingest(new Array(CORPUS_LIMITS.maxDocuments + 1).fill(0).map((_, i) => ({
        source_id: `doc${i}`,
        text: 'a',
      })))).toEqual({ status: 'unavailable', blockerCode: 'too_many_documents' });
    });

    it('freezes inputs so later caller mutation has no effect', () => {
      const sources = [{ source_id: 'mutable', text: 'original content here' }];
      const ingested = KnowledgeBase.ingest(sources);
      expect(ingested.status).toBe('mounted');
      if (ingested.status !== 'mounted') throw new Error('unreachable');

      sources[0].text = 'mutated';
      sources.push({ source_id: 'sneaky', text: 'should not exist' });

      const resolved = ingested.knowledgeBase.resolve('mutable#0-20');
      expect(resolved?.text).toBe('original content here');
      expect(ingested.knowledgeBase.corpus.sources).toHaveLength(1);
      expect(ingested.knowledgeBase.corpus.passages).toHaveLength(1);
    });
  });

  describe('chunking', () => {
    it('tiles a document with no overlap and no gap', () => {
      const text = 'x'.repeat(1000);
      const ingested = KnowledgeBase.ingest([{ source_id: 'tile', text }]);
      expect(ingested.status).toBe('mounted');
      if (ingested.status !== 'mounted') throw new Error('unreachable');

      const { passages } = ingested.knowledgeBase.corpus;
      expect(passages.map((p) => p.text).join('')).toBe(text);
      expect(passages[0].char_start).toBe(0);
      expect(passages[0].char_end).toBe(512);
      expect(passages[1].char_start).toBe(512);
      expect(passages[1].char_end).toBe(1000);
    });

    it('keeps code-point accurate offsets with non-BMP characters before a span', () => {
      const prefix = '😀'.repeat(10);
      const source = `${prefix}${'x'.repeat(890)}needle${'y'.repeat(1000)}`;
      const ingested = KnowledgeBase.ingest([{ source_id: 'codepoint', text: source }]);
      expect(ingested.status).toBe('mounted');
      if (ingested.status !== 'mounted') throw new Error('unreachable');

      const index = new Bm25Index(ingested.knowledgeBase.corpus);
      const result = executeSearchKnowledge(index, { query: 'needle' });
      expect(result.started).toBe(true);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error('unreachable');
      expect(result.output).toHaveProperty('ok', true);
      if (result.output.ok !== true) throw new Error('unreachable');

      const [match] = result.output.passages;
      expect(match).toBeDefined();
      expect(match.char_start).toBe(900);
      expect(match.char_end).toBe(906);
      expect(Array.from(match.text)[0]).toBe('x');
      expect(Array.from(match.text).slice(388, 394).join('')).toBe('needle');
    });
  });

  describe('BM25 search', () => {
    it('matches a hand-computed BM25 score within 1e-9', () => {
      const source = 'the quick brown fox jumps over the lazy dog';
      const ingested = KnowledgeBase.ingest([{ source_id: 'bm25', text: source }]);
      expect(ingested.status).toBe('mounted');
      if (ingested.status !== 'mounted') throw new Error('unreachable');

      const index = new Bm25Index(ingested.knowledgeBase.corpus);
      const matches = index.search('quick fox brown', 20);
      expect(matches).toHaveLength(1);
      expect(matches[0].score).toBeCloseTo(0.8630462173553427, 9);
    });

    it('ranks a relevant later document above an irrelevant earlier one', () => {
      const ingested = KnowledgeBase.ingest([
        { source_id: 'earlier', text: 'apple banana' },
        { source_id: 'later', text: 'apple cherry' },
      ]);
      expect(ingested.status).toBe('mounted');
      if (ingested.status !== 'mounted') throw new Error('unreachable');

      const index = new Bm25Index(ingested.knowledgeBase.corpus);
      const result = executeSearchKnowledge(index, { query: 'cherry' });
      expect(result.started).toBe(true);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok' || result.output.ok !== true) throw new Error('unreachable');
      expect(result.output.passages[0].source_id).toBe('later');
    });

    it('pins tie order by source_id then char_start', () => {
      const ingested = KnowledgeBase.ingest([
        { source_id: 'z', text: 'same' },
        { source_id: 'a', text: 'same' },
      ]);
      expect(ingested.status).toBe('mounted');
      if (ingested.status !== 'mounted') throw new Error('unreachable');

      const index = new Bm25Index(ingested.knowledgeBase.corpus);
      const matches = index.search('same', 20);
      expect(matches.map((p) => p.source_id)).toEqual(['a', 'z']);
    });

    it('returns [] for a no-match query and no_query_tokens for punctuation-only', () => {
      const ingested = KnowledgeBase.ingest([{ source_id: 'doc', text: 'alpha beta gamma' }]);
      expect(ingested.status).toBe('mounted');
      if (ingested.status !== 'mounted') throw new Error('unreachable');

      const index = new Bm25Index(ingested.knowledgeBase.corpus);
      const noMatch = executeSearchKnowledge(index, { query: 'missingword' });
      expect(noMatch).toEqual({ started: true, status: 'ok', output: { ok: true, passages: [] } });

      const noTokens = executeSearchKnowledge(index, { query: '!!! ???' });
      expect(noTokens).toEqual({
        started: true,
        status: 'ok',
        output: { ok: false, code: 'no_query_tokens' },
      });
    });

    it('matches a non-ASCII word query', () => {
      const source = 'naïve café is open';
      const ingested = KnowledgeBase.ingest([{ source_id: 'unicode', text: source }]);
      expect(ingested.status).toBe('mounted');
      if (ingested.status !== 'mounted') throw new Error('unreachable');

      const index = new Bm25Index(ingested.knowledgeBase.corpus);
      const result = executeSearchKnowledge(index, { query: 'café' });
      expect(result.started).toBe(true);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok' || result.output.ok !== true) throw new Error('unreachable');
      expect(result.output.passages).toHaveLength(1);
      expect(result.output.passages[0].text).toContain('café');
    });
  });

  describe('search_knowledge tool shape', () => {
    it('has a schema in the JSON-Schema subset and is read-only/idempotent', () => {
      expect(searchKnowledgeSchema.additionalProperties).toBe(false);
      expect(searchKnowledgeSchema.required).toEqual(['query']);
      expect(searchKnowledgeSchema.properties.query).toMatchObject({ type: 'string', minLength: 1, maxLength: 512 });
      expect(searchKnowledgeSchema.properties.top_k).toMatchObject({ type: 'integer', minimum: 1, maximum: 20 });
    });

    it('enforces query and top_k bounds as invalid_args', () => {
      const ingested = KnowledgeBase.ingest([{ source_id: 'doc', text: 'hello' }]);
      expect(ingested.status).toBe('mounted');
      if (ingested.status !== 'mounted') throw new Error('unreachable');
      const index = new Bm25Index(ingested.knowledgeBase.corpus);

      expect(executeSearchKnowledge(index, { query: '', top_k: 5 })).toEqual({
        started: false,
        status: 'invalid_args',
        output: { ok: false, code: 'invalid_args' },
      });
      expect(executeSearchKnowledge(index, { query: 'hello', top_k: 0 })).toEqual({
        started: false,
        status: 'invalid_args',
        output: { ok: false, code: 'invalid_args' },
      });
      expect(executeSearchKnowledge(index, { query: 'hello', top_k: 21 })).toEqual({
        started: false,
        status: 'invalid_args',
        output: { ok: false, code: 'invalid_args' },
      });
      expect(executeSearchKnowledge(index, { query: 'hello', top_k: 1.5 })).toEqual({
        started: false,
        status: 'invalid_args',
        output: { ok: false, code: 'invalid_args' },
      });
      expect(normalizeTopK(undefined)).toBe(5);
      expect(normalizeTopK(3)).toBe(3);
      expect(normalizeTopK(21)).toBeUndefined();
    });

    it('carries complete passage text, max 20 x 512 code points per request', async () => {
      const text = `${'a'.repeat(511)} target`;
      const ingested = KnowledgeBase.ingest([{ source_id: 'full', text }]);
      expect(ingested.status).toBe('mounted');
      if (ingested.status !== 'mounted') throw new Error('unreachable');

      const tool = createSearchKnowledgeTool(new Bm25Index(ingested.knowledgeBase.corpus));
      const result = await tool.call({ query: 'target' });
      expect(result.started).toBe(true);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok' || result.output.ok !== true) throw new Error('unreachable');
      expect(result.output.passages).toHaveLength(1);
      expect(result.output.passages[0].text).toHaveLength(512);
      expect(result.output.passages[0].text).toContain('target');
    });
  });

  describe('shape-2 citation validation', () => {
    const corpus = [
      { source_id: 'source_a', text: 'alpha beta gamma delta' },
    ];

    function setup() {
      const ingested = KnowledgeBase.ingest(corpus);
      expect(ingested.status).toBe('mounted');
      if (ingested.status !== 'mounted') throw new Error('unreachable');
      const index = new Bm25Index(ingested.knowledgeBase.corpus);
      const execution = executeSearchKnowledge(index, { query: 'alpha' });
      expect(execution.started).toBe(true);
      expect(execution.status).toBe('ok');
      if (execution.status !== 'ok' || execution.output.ok !== true) throw new Error('unreachable');
      const [match] = execution.output.passages;
      expect(match).toBeDefined();

      const result = {
        call_id: 'call-1',
        tool_name: 'search_knowledge' as const,
        started: true,
        status: 'ok',
        output: execution.output,
      };

      return { ingested, match, result };
    }

    it('accepts a valid provenance-only citation', () => {
      const { ingested, match, result } = setup();
      const validated = validateCitationShape2AgainstRun(
        { call_id: 'call-1', passage_id: match.passage_id },
        [result],
        ingested.knowledgeBase,
      );
      expect(validated.valid).toBe(true);
      if (validated.valid) {
        expect(validated.passage.text).toBe(match.text);
      }
    });

    it('rejects malformed citations and unknown/wrong/failed/unresolvable sources', () => {
      const { ingested, match, result } = setup();
      const assertFailure = (
        citation: unknown,
        results: unknown[] = [result],
        base: KnowledgeBase = ingested.knowledgeBase,
        expected: string,
      ) => {
        const validated = validateCitationShape2AgainstRun(citation, results as never[], base);
        expect(validated.valid).toBe(false);
        if (!validated.valid) expect(validated.reason).toBe(expected);
      };

      assertFailure({ call_id: 'call-1' }, [result], ingested.knowledgeBase, 'invalid_citation');
      assertFailure({ call_id: 'missing', passage_id: match.passage_id }, [result], ingested.knowledgeBase, 'unknown_call_id');
      assertFailure(
        { call_id: 'call-1', passage_id: match.passage_id },
        [{ ...result, tool_name: 'other_tool' }],
        ingested.knowledgeBase,
        'tool_mismatch',
      );
      assertFailure(
        { call_id: 'call-1', passage_id: match.passage_id },
        [{ ...result, started: false }],
        ingested.knowledgeBase,
        'search_failed',
      );
      assertFailure(
        { call_id: 'call-1', passage_id: 'source_a#999-9999' },
        [result],
        ingested.knowledgeBase,
        'unknown_passage_id',
      );
    });

    it('rejects passage mismatch when recorded content differs from frozen corpus', () => {
      const { ingested, match, result } = setup();
      const tamperedResult = {
        ...result,
        output: {
          ok: true,
          passages: [{ ...match, text: 'tampered text' }],
        },
      };
      const validated = validateCitationShape2AgainstRun(
        { call_id: 'call-1', passage_id: match.passage_id },
        [tamperedResult],
        ingested.knowledgeBase,
      );
      expect(validated).toEqual({ valid: false, reason: 'passage_mismatch' });
    });

    it('registers shape 2 through the mount host without registering shapes 3-7', () => {
      const registered: number[] = [];
      const host = {
        registerCitationShape: (shape: number) => {
          registered.push(shape);
        },
      };
      const mounted = mountKnowledgeRetrievalMount(host, corpus);
      expect(mounted.status).toBe('mounted');
      expect(registered).toEqual([2]);
    });

    it('keeps unavailable status for an invalid corpus', () => {
      const capabilityStatus: Record<string, string> = {};
      const host = {
        setCapability: (key: string, status: string) => {
          capabilityStatus[key] = status;
        },
      };
      const mounted = mountKnowledgeRetrievalMount(host, [
        { source_id: 'doc', text: 'bad \u0000 corpus' },
      ]);
      expect(mounted.status).toBe('unavailable');
      expect(capabilityStatus.search_knowledge).toBe('unavailable');
    });
  });

  describe('classifier', () => {
    it('classifies outer ok with output ok=true and valid passages as success', () => {
      expect(classifySearchKnowledge({
        status: 'ok',
        output: { ok: true, passages: [] },
      })).toBe('success');
    });

    it('classifies output ok=false and malformed reports as known_failure', () => {
      expect(classifySearchKnowledge({
        status: 'ok',
        output: { ok: false, code: 'no_query_tokens' },
      })).toBe('known_failure');
      expect(classifySearchKnowledge({
        status: 'ok',
        output: { ok: true, passages: 'not an array' },
      })).toBe('known_failure');
      expect(classifySearchKnowledge({
        status: 'ok',
        output: { ok: true, passages: [{ passage_id: 'x' }] },
      })).toBe('known_failure');
    });

    it('classifies outer timeout as unknown', () => {
      expect(classifySearchKnowledge({ status: 'timeout' })).toBe('unknown');
    });
  });

  describe('full passage text survives truncation-style recall', () => {
    it('retains the complete selected passage text, not a clipped transcript view', async () => {
      const prefix = 'p'.repeat(600);
      const term = 'needle';
      const suffix = 's'.repeat(600);
      const text = `${prefix} ${term} ${suffix}`;
      const ingested = KnowledgeBase.ingest([{ source_id: 'recall', text }]);
      expect(ingested.status).toBe('mounted');
      if (ingested.status !== 'mounted') throw new Error('unreachable');

      const tool = createSearchKnowledgeTool(new Bm25Index(ingested.knowledgeBase.corpus));
      const result = await tool.call({ query: term, top_k: 1 });
      expect(result.started).toBe(true);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok' || result.output.ok !== true) throw new Error('unreachable');

      const [match] = result.output.passages;
      expect(match.text.length).toBeGreaterThanOrEqual(512);

      // Simulate the runtime's transcript truncation: the full ToolResult was stored
      // before this clipped view was produced.
      const truncatedTranscriptView = match.text.slice(0, 40);
      expect(truncatedTranscriptView).not.toContain(term);

      const recovered = ingested.knowledgeBase.resolve(match.passage_id)?.text;
      expect(recovered).toBe(match.text);
      expect(recovered).toContain(term);
    });
  });
});
