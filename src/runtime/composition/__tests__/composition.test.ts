import { describe, it, expect, vi } from 'vitest';
import {
  COMPOSITION_CAPS,
  COMPOSITION_REASON_CODES,
  ComposedJobPort,
  CompositionCoordinator,
  InMemoryJournalStore,
  rebuildEnvelopeFromJournal,
  validateCompositionConfig,
} from '../index';

describe('cap_composed_runtime_65', () => {
  it('returns null coordinator when disabled or absent (baseline parity)', () => {
    expect(CompositionCoordinator.createIfEnabled(undefined, 'run-1')).toBeNull();
    expect(CompositionCoordinator.createIfEnabled({ enabled: false }, 'run-1')).toBeNull();
    expect(validateCompositionConfig(undefined)).toEqual({ valid: true });
  });

  it('rejects invalid reserves, durable without JournalStore, and incompatible co-mounts', () => {
    expect(validateCompositionConfig({ enabled: true, drainDeadlineMs: 1 })).toMatchObject({
      valid: false,
      reason: COMPOSITION_REASON_CODES.INVALID_DRAIN_DEADLINE,
    });
    expect(validateCompositionConfig({ enabled: true, teardownReserveMs: 999_999 })).toMatchObject({
      valid: false,
      reason: COMPOSITION_REASON_CODES.INVALID_TEARDOWN_RESERVE,
    });
    expect(validateCompositionConfig({ enabled: true, durable: true })).toMatchObject({
      valid: false,
      reason: COMPOSITION_REASON_CODES.DURABLE_REQUIRES_JOURNAL_STORE,
    });
    expect(
      validateCompositionConfig({
        enabled: true,
        sessionMode: true,
        modelRouter: true,
      }),
    ).toMatchObject({
      valid: false,
      reason: COMPOSITION_REASON_CODES.INCOMPATIBLE_SUBSYSTEM_COMOUNT,
    });
  });

  it('restores unsettled intent as outcome unknown without replay, and settled members in order', async () => {
    const journal = new InMemoryJournalStore();
    const coord = CompositionCoordinator.createIfEnabled(
      { enabled: true, durable: true, journalStore: journal },
      'run-crash',
      'user-1',
    )!;

    await coord.journalDispatchIntent(
      { call_id: 'c1', tool_name: 'read_file', args_digest: 'd1' },
      100,
    );
    await coord.journalBatchSettlement('c1', 'success', 'res1', 110);
    await coord.journalDispatchIntent(
      { call_id: 'c2', tool_name: 'write_file', args_digest: 'd2' },
      120,
    );

    const restoredCoord = CompositionCoordinator.createIfEnabled(
      { enabled: true, durable: true, journalStore: journal },
      'run-crash',
      'user-1',
    )!;
    const { envelope, resumeNotice } = await restoredCoord.restoreFromJournal();

    expect(envelope.batch_members.map((m) => m.call_id)).toEqual(['c1', 'c2']);
    expect(envelope.batch_members[0].outcome).toBe('success');
    expect(envelope.batch_members[1].outcome).toBe('unknown');
    expect(envelope.batch_members[1].reason_code).toBe(
      COMPOSITION_REASON_CODES.OUTCOME_UNKNOWN_UNSETTLED,
    );
    expect(resumeNotice.unknown_call_ids).toEqual(['c2']);
    expect(JSON.stringify(resumeNotice)).not.toContain('res1');
  });

  it('blocks job family until cleanup_confirmed on restore with surviving container', async () => {
    const journal = new InMemoryJournalStore();
    const coord = CompositionCoordinator.createIfEnabled(
      { enabled: true, durable: true, journalStore: journal },
      'run-jobs',
    )!;

    const jobPort: ComposedJobPort = {
      listContainersByRunId: vi.fn(async () => [
        { job_id: 'job-1', run_id: 'run-jobs', state: 'running' },
      ]),
      removeContainersByRunId: vi.fn(async () => false),
    };

    const { envelope, resumeNotice } = await coord.restoreFromJournal(jobPort);
    expect(coord.isJobFamilyBlocked()).toBe(true);
    expect(resumeNotice.job_family_blocked).toBe(true);
    expect(envelope.job_records[0].status).toBe('lost');
    expect(jobPort.removeContainersByRunId).toHaveBeenCalledWith('run-jobs');
  });

  it('enforces shared teardown reserve and journals teardown_unconfirmed on overrun', async () => {
    const journal = new InMemoryJournalStore();
    const coord = CompositionCoordinator.createIfEnabled(
      {
        enabled: true,
        durable: true,
        journalStore: journal,
        teardownReserveMs: COMPOSITION_CAPS.MIN_TEARDOWN_RESERVE_MS,
      },
      'run-abort',
    )!;

    let now = 900;
    const emitted: string[] = [];
    const env = await coord.abortAndFinalize({
      clock: () => now,
      runDeadlineMs: 1000,
      cancelInFlightJobs: async () => {},
      drainStartedCalls: async () => {},
      teardownJobs: async () => {
        now = 1050; // overrun past runDeadlineMs
      },
      emitFinalEvent: (state) => {
        emitted.push(state);
      },
    });

    expect(env.teardown_unconfirmed).toBe(true);
    expect(env.active_turn_state).toBe('teardown_unconfirmed');
    expect(emitted).toEqual(['teardown_unconfirmed']);
  });

  it('prevents consumed approval reuse and rebuilds envelope matching persisted view', async () => {
    const journal = new InMemoryJournalStore();
    const coord = CompositionCoordinator.createIfEnabled(
      { enabled: true, durable: true, journalStore: journal },
      'run-view',
    )!;

    await coord.consumeApproval('digest-abc', 200);
    await expect(coord.consumeApproval('digest-abc', 201)).rejects.toThrow();

    const persisted = await coord.runTurnBoundary([]);
    const rebuilt = rebuildEnvelopeFromJournal(
      'run-view',
      'default',
      journal.readAll('run-view'),
    );
    expect(rebuilt.consumed_approval_digests).toEqual(persisted.consumed_approval_digests);
    expect(rebuilt.active_turn_state).toBe(persisted.active_turn_state);
    expect(rebuilt.turn_index).toBe(persisted.turn_index);
  });
});
