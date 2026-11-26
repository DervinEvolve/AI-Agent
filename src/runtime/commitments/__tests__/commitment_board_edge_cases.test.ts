import { describe, expect, it } from 'vitest';
import {
  BOARD_TOOL_NAMES,
  COMMITMENT_INVALID_TRANSITION,
  COMMITMENT_NOT_ACTIVE,
  COMMITMENT_NOT_FOUND,
  COMMITMENT_REF_NOT_OBSERVED,
  CommitmentBoard,
  InMemoryFencedBoardJournal,
  createCommitmentBoardTools,
  filterBoardToolsForChild,
  resolveCommitmentBoardConfig,
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

describe('cap_commitment_board_73 edge cases & durability', () => {
  it('validates CommitmentBoardConfig caps and 2x maxCreations invariant', () => {
    expect(() =>
      resolveCommitmentBoardConfig({ maxCreations: 10, maxTotalEvents: 19 })
    ).toThrow();
    expect(() =>
      resolveCommitmentBoardConfig({ maxActiveEntries: 0 })
    ).toThrow();
    expect(() =>
      resolveCommitmentBoardConfig({ maxActiveEntries: 33 })
    ).toThrow();

    const valid = resolveCommitmentBoardConfig({
      enabled: true,
      maxCreations: 10,
      maxTotalEvents: 20,
    });
    expect(valid.enabled).toBe(true);
    expect(valid.maxCreations).toBe(10);
    expect(valid.maxTotalEvents).toBe(20);
  });

  it('reconciles InMemoryFencedBoardJournal intents and idempotent event appends', async () => {
    const journal = new InMemoryFencedBoardJournal();
    expect(await journal.reconcile('missing_call')).toEqual({
      status: 'none',
      events: [],
    });

    await journal.appendIntent('call_intent_only');
    expect(await journal.reconcile('call_intent_only')).toEqual({
      status: 'unapplied',
      events: [],
    });

    const sampleEvent = {
      seq: 1,
      type: 'created' as const,
      call_id: 'call_applied',
      logical_run_id: 'run_j',
      turn_id: 1,
      commitment_id: 'c_1',
      timestamp: 1000,
      kind: 'open_question' as const,
      summary: 'Need confirmation?',
      refs: [],
    };

    await journal.appendIntent('call_applied');
    await journal.appendEvents('call_applied', [sampleEvent]);
    await journal.appendEvents('call_applied', [sampleEvent]);

    const reconciled = await journal.reconcile('call_applied');
    expect(reconciled.status).toBe('applied');
    expect(reconciled.events).toHaveLength(1);
    expect(journal.getCommittedEvents()).toHaveLength(1);
  });

  it('handles supersession, terminal transition guards, and deterministic pagination', async () => {
    const obs = new MapObservationStore();
    obs.add({
      logical_run_id: 'run_2',
      turn_id: 1,
      call_id: 'obs_1',
      tool_name: 'read_file',
      started: true,
      outcome: 'ok',
    });

    const board = new CommitmentBoard('run_2', { enabled: true });

    const q1 = await board.recordCommitment(
      { kind: 'open_question', summary: 'First question' },
      { call_id: 'b_1', turn_id: 1, observationStore: obs }
    );
    expect(q1.ok).toBe(true);

    const d1 = await board.recordCommitment(
      {
        kind: 'decision',
        summary: 'First decision',
        refs: [{ call_id: 'obs_1' }],
        supersedes_id: q1.commitment_id,
      },
      { call_id: 'b_2', turn_id: 1, observationStore: obs }
    );
    expect(d1.ok).toBe(true);

    const resolveSuperseded = await board.resolveCommitment(
      {
        commitment_id: q1.commitment_id!,
        resolution: 'answered',
        summary: 'Too late',
      },
      { call_id: 'b_3', turn_id: 1, observationStore: obs }
    );
    expect(resolveSuperseded.ok).toBe(false);
    expect(resolveSuperseded.reason).toBe(COMMITMENT_NOT_ACTIVE);

    const invalidDecisionAnswer = await board.resolveCommitment(
      {
        commitment_id: d1.commitment_id!,
        resolution: 'answered',
        summary: 'Decisions cannot be answered',
      },
      { call_id: 'b_4', turn_id: 1, observationStore: obs }
    );
    expect(invalidDecisionAnswer.ok).toBe(false);
    expect(invalidDecisionAnswer.reason).toBe(COMMITMENT_INVALID_TRANSITION);

    const missingResolve = await board.resolveCommitment(
      {
        commitment_id: 'does_not_exist',
        resolution: 'abandoned',
        summary: 'Missing',
      },
      { call_id: 'b_5', turn_id: 1, observationStore: obs }
    );
    expect(missingResolve.ok).toBe(false);
    expect(missingResolve.reason).toBe(COMMITMENT_NOT_FOUND);

    const unknownRef = await board.recordCommitment(
      {
        kind: 'decision',
        summary: 'Unobserved ref',
        refs: [{ call_id: 'unknown_obs' }],
      },
      { call_id: 'b_6', turn_id: 1, observationStore: obs }
    );
    expect(unknownRef.ok).toBe(false);
    expect(unknownRef.reason).toBe(COMMITMENT_REF_NOT_OBSERVED);

    const activePage = board.readCommitments({ status: 'active', limit: 10, offset: 0 });
    expect(activePage.total).toBe(1);
    expect(activePage.entries[0]?.id).toBe(d1.commitment_id);

    const allPage1 = board.readCommitments({ status: 'all', limit: 1, offset: 0 });
    expect(allPage1.total).toBe(2);
    expect(allPage1.entries).toHaveLength(1);
    expect(allPage1.next_offset).toBe(1);
  });

  it('exposes tool metadata and filters board tools from child toolsets', () => {
    const board = new CommitmentBoard('run_3', { enabled: true });
    const boardTools = createCommitmentBoardTools(board);
    expect(boardTools.map((t) => t.name)).toEqual([...BOARD_TOOL_NAMES]);

    for (const tool of boardTools) {
      expect(tool.recoveryNeutral).toBe(true);
      expect(tool.alwaysVisible).toBe(true);
      if (tool.name === 'read_commitments') {
        expect(tool.idempotent).toBe(true);
        expect(tool.concurrentSafe).toBe(true);
      } else {
        expect(tool.idempotent).toBe(false);
        expect(tool.concurrentSafe).toBe(false);
      }
    }

    const filtered = filterBoardToolsForChild([
      ...boardTools,
      { name: 'read_file' },
      { name: 'search' },
    ]);
    expect(filtered.map((t) => t.name)).toEqual(['read_file', 'search']);
  });
});
