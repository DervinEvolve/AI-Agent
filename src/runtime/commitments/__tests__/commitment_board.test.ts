import { describe, expect, it } from 'vitest';
import {
  BOARD_TOOL_NAMES,
  COMMITMENT_BOARD_FULL,
  COMMITMENT_BOARD_LABEL_END,
  COMMITMENT_BOARD_LABEL_START,
  COMMITMENT_INVALID_TRANSITION,
  COMMITMENT_NOT_ACTIVE,
  COMMITMENT_NOT_FOUND,
  COMMITMENT_REF_NOT_OBSERVED,
  CommitmentBoard,
  InMemoryFencedBoardJournal,
  createCommitmentBoardTools,
  filterBoardToolsForChild,
  renderCommitmentBoard,
  type ObservationLookup,
  type ObservationRecord,
} from '../index';

class MapObservationStore implements ObservationLookup {
  private readonly records = new Map<string, ObservationRecord>();

  add(rec: ObservationRecord): void {
    this.records.set(`${rec.logical_run_id}::${rec.call_id}`, rec);
  }

  getByCallId(callId: string, logicalRunId: string): ObservationRecord | undefined {
    return this.records.get(`${logicalRunId}::${callId}`);
  }
}

describe('cap_commitment_board_73', () => {
  it('records decision and open_question, renders newest-first with elided_count and untrusted label', async () => {
    const obs = new MapObservationStore();
    obs.add({
      logical_run_id: 'run_1',
      turn_id: 1,
      call_id: 'c1',
      tool_name: 'search',
      started: true,
      outcome: 'ok',
    });

    const board = new CommitmentBoard('run_1', {
      enabled: true,
      maxRenderedBytes: 360,
    });

    const r1 = await board.recordCommitment(
      { kind: 'open_question', summary: 'Which database engine should we use?' },
      { call_id: 'b1', turn_id: 1, observationStore: obs }
    );
    expect(r1.ok).toBe(true);

    const r2 = await board.recordCommitment(
      {
        kind: 'decision',
        summary: 'Use PostgreSQL for ACID transactions.',
        refs: [{ call_id: 'c1', detail: 'confirmed' }],
      },
      { call_id: 'b2', turn_id: 1, observationStore: obs }
    );
    expect(r2.ok).toBe(true);

    const rendered = renderCommitmentBoard(board.deriveProjection(), board.config);
    expect(rendered.text.startsWith(COMMITMENT_BOARD_LABEL_START)).toBe(true);
    expect(rendered.text.endsWith(COMMITMENT_BOARD_LABEL_END)).toBe(true);
    expect(rendered.bytes).toBeLessThanOrEqual(board.config.maxRenderedBytes);
    expect(rendered.elided_count).toBe(1);
    expect(rendered.rendered_count).toBe(1);
    expect(rendered.text).toContain('Use PostgreSQL');

    const page = board.readCommitments({ status: 'active', limit: 10, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.entries.map((e) => e.id)).toEqual(['cmt_1', 'cmt_2']);
  });

  it('enforces transitions, refs, caps, supersession at maxActiveEntries, and resolution after maxCreations', async () => {
    const obs = new MapObservationStore();
    obs.add({
      logical_run_id: 'run_1',
      turn_id: 1,
      call_id: 'c1',
      tool_name: 'read_file',
      started: true,
      outcome: 'ok',
    });
    obs.add({
      logical_run_id: 'run_1',
      turn_id: 1,
      call_id: 'b_obs',
      tool_name: 'record_commitment',
      started: true,
      outcome: 'ok',
    });

    const board = new CommitmentBoard('run_1', {
      enabled: true,
      maxActiveEntries: 2,
      maxCreations: 2,
      maxTotalEvents: 4,
      maxRefDetailBytes: 8,
    });

    // Decision with no refs -> started: false
    const noRefs = await board.recordCommitment(
      { kind: 'decision', summary: 'No refs' },
      { call_id: 'b1', turn_id: 1, observationStore: obs }
    );
    expect(noRefs.started).toBe(false);

    // Board-call ref -> commitment_ref_not_observed
    const boardRef = await board.recordCommitment(
      { kind: 'decision', summary: 'Board ref', refs: [{ call_id: 'b_obs' }] },
      { call_id: 'b2', turn_id: 1, observationStore: obs }
    );
    expect(boardRef).toMatchObject({ started: false, reason: COMMITMENT_REF_NOT_OBSERVED });

    // Unknown call_id -> commitment_ref_not_observed
    const unknownRef = await board.recordCommitment(
      { kind: 'decision', summary: 'Unknown ref', refs: [{ call_id: 'missing' }] },
      { call_id: 'b3', turn_id: 1, observationStore: obs }
    );
    expect(unknownRef).toMatchObject({ started: false, reason: COMMITMENT_REF_NOT_OBSERVED });

    // Oversized detail -> started: false
    const bigDetail = await board.recordCommitment(
      {
        kind: 'decision',
        summary: 'Big detail',
        refs: [{ call_id: 'c1', detail: '123456789' }],
      },
      { call_id: 'b4', turn_id: 1, observationStore: obs }
    );
    expect(bigDetail.started).toBe(false);

    // Create 2 entries (reaches maxActiveEntries=2 and maxCreations=2)
    const d1 = await board.recordCommitment(
      { kind: 'decision', summary: 'D1', refs: [{ call_id: 'c1' }] },
      { call_id: 'b5', turn_id: 1, observationStore: obs }
    );
    const q1 = await board.recordCommitment(
      { kind: 'open_question', summary: 'Q1' },
      { call_id: 'b6', turn_id: 1, observationStore: obs }
    );
    expect(d1.ok).toBe(true);
    expect(q1.ok).toBe(true);

    // Answered on a decision -> commitment_invalid_transition
    const ansDecision = await board.resolveCommitment(
      { commitment_id: 'cmt_1', resolution: 'answered', summary: 'nope' },
      { call_id: 'b7', turn_id: 1, observationStore: obs }
    );
    expect(ansDecision).toMatchObject({ started: false, reason: COMMITMENT_INVALID_TRANSITION });

    // Resolve Q1 after maxCreations is exhausted -> succeeds
    const ansQ1 = await board.resolveCommitment(
      { commitment_id: 'cmt_2', resolution: 'answered', summary: 'Resolved Q1' },
      { call_id: 'b8', turn_id: 1, observationStore: obs }
    );
    expect(ansQ1.ok).toBe(true);

    // Resolving terminal entry -> commitment_not_active
    const again = await board.resolveCommitment(
      { commitment_id: 'cmt_2', resolution: 'abandoned', summary: 'again' },
      { call_id: 'b9', turn_id: 1, observationStore: obs }
    );
    expect(again).toMatchObject({ started: false, reason: COMMITMENT_NOT_ACTIVE });

    // Missing entry -> commitment_not_found
    const missing = await board.resolveCommitment(
      { commitment_id: 'cmt_999', resolution: 'abandoned', summary: 'missing' },
      { call_id: 'b10', turn_id: 1, observationStore: obs }
    );
    expect(missing).toMatchObject({ started: false, reason: COMMITMENT_NOT_FOUND });
  });

  it('allows superseding at maxActiveEntries and serializes concurrent supersessions', async () => {
    const obs = new MapObservationStore();
    obs.add({
      logical_run_id: 'run_1',
      turn_id: 1,
      call_id: 'c1',
      tool_name: 'search',
      started: true,
      outcome: 'ok',
    });

    const board = new CommitmentBoard('run_1', {
      enabled: true,
      maxActiveEntries: 1,
      maxCreations: 4,
      maxTotalEvents: 8,
    });

    await board.recordCommitment(
      { kind: 'decision', summary: 'Initial', refs: [{ call_id: 'c1' }] },
      { call_id: 'b1', turn_id: 1, observationStore: obs }
    );

    // Non-superseding at maxActiveEntries -> commitment_board_full
    const full = await board.recordCommitment(
      { kind: 'open_question', summary: 'Extra' },
      { call_id: 'b2', turn_id: 1, observationStore: obs }
    );
    expect(full).toMatchObject({ started: false, reason: COMMITMENT_BOARD_FULL });

    // Two concurrent supersessions of cmt_1: one succeeds, one gets commitment_not_active
    const [s1, s2] = await Promise.all([
      board.recordCommitment(
        { kind: 'decision', summary: 'S1', refs: [{ call_id: 'c1' }], supersedes_id: 'cmt_1' },
        { call_id: 'b3', turn_id: 1, observationStore: obs }
      ),
      board.recordCommitment(
        { kind: 'decision', summary: 'S2', refs: [{ call_id: 'c1' }], supersedes_id: 'cmt_1' },
        { call_id: 'b4', turn_id: 1, observationStore: obs }
      ),
    ]);

    const okCount = [s1, s2].filter((r) => r.ok).length;
    const notActiveCount = [s1, s2].filter(
      (r) => !r.ok && r.reason === COMMITMENT_NOT_ACTIVE
    ).length;
    expect(okCount).toBe(1);
    expect(notActiveCount).toBe(1);
  });

  it('aborts cleanly before commit and reconciles journal intent/event crashes', async () => {
    const obs = new MapObservationStore();
    const journal = new InMemoryFencedBoardJournal();
    const board = new CommitmentBoard('run_1', { enabled: true }, [], journal);

    const ac = new AbortController();
    ac.abort();
    const aborted = await board.recordCommitment(
      { kind: 'open_question', summary: 'Aborted' },
      { call_id: 'b_abort', turn_id: 1, observationStore: obs, abortSignal: ac.signal }
    );
    expect(aborted.started).toBe(false);
    expect(board.getEvents()).toHaveLength(0);

    // Crash after intent without event -> unapplied
    await journal.appendIntent('b_crash_intent');
    const recIntent = await journal.reconcile('b_crash_intent');
    expect(recIntent.status).toBe('unapplied');
    expect(recIntent.events).toHaveLength(0);

    // Crash after event without settlement -> applied
    const committed = await board.recordCommitment(
      { kind: 'open_question', summary: 'Persisted' },
      { call_id: 'b_ok', turn_id: 1, observationStore: obs }
    );
    expect(committed.ok).toBe(true);
    const recEvent = await journal.reconcile('b_ok');
    expect(recEvent.status).toBe('applied');
    expect(recEvent.events).toHaveLength(1);
  });

  it('strips board tools for child/worker agents and marks mutations concurrentSafe=false', () => {
    const board = new CommitmentBoard('run_1', { enabled: true });
    const tools = createCommitmentBoardTools(board);
    expect(tools.map((t) => t.name)).toEqual([...BOARD_TOOL_NAMES]);
    expect(tools.find((t) => t.name === 'read_commitments')?.concurrentSafe).toBe(true);
    expect(tools.find((t) => t.name === 'record_commitment')?.concurrentSafe).toBe(false);
    expect(tools.find((t) => t.name === 'resolve_commitment')?.concurrentSafe).toBe(false);

    const childTools = filterBoardToolsForChild([
      ...tools,
      { name: 'search', concurrentSafe: true },
    ]);
    expect(childTools.map((t) => t.name)).toEqual(['search']);
  });
});
