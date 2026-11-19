import {
  Bm25Index,
  KnowledgeBase,
  executeSearchKnowledge,
} from '../cap_knowledge_retrieval_mount_32';

describe('cap_knowledge_retrieval_mount_32 chunking', () => {
  it('uses code-point offsets with non-BMP characters and returns the full passage source span', () => {
    // 300 astral code points + 600 'x' code points = 900 code points before the needle.
    // The needle starts at code point 901, inside the second 512-code-point passage.
    const source = '\u{1F600}'.repeat(300) + 'x'.repeat(600) + ' needle';

    const kb = KnowledgeBase.ingest([{ source_id: 'doc', text: source }]);
    expect(kb.status).toBe('mounted');
    if (kb.status !== 'mounted') throw new Error('unreachable');

    const index = new Bm25Index(kb.knowledgeBase.corpus);
    const result = executeSearchKnowledge(index, { query: 'needle' });

    expect(result.started).toBe(true);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');

    expect(result.output.ok).toBe(true);
    const output = result.output as {
      ok: true;
      passages: Array<{
        source_id: string;
        char_start: number;
        char_end: number;
        passage_id: string;
        text: string;
      }>;
    };

    expect(output.passages).toHaveLength(1);
    const passage = output.passages[0];

    expect(passage.source_id).toBe('doc');
    expect(passage.char_start).toBe(512);
    expect(passage.char_end).toBe(907);
    expect(passage.passage_id).toBe('doc#512-907');

    // Independent code-point-aware slice of the source proves the passage text
    // is the exact source span, not a UTF-16 unit slice.
    const expectedText = Array.from(source).slice(512, 907).join('');
    expect(passage.text).toBe(expectedText);
  });
});
