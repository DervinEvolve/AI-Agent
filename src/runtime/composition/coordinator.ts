import { createInitialEnvelope, rebuildEnvelopeFromJournal } from './journal';
import {
  BatchMemberJournalRecord,
  CheckpointEnvelope,
  COMPOSITION_CAPS,
  COMPOSITION_REASON_CODES,
  ComposedJobPort,
  ComposedTurnState,
  CompositionConfig,
  CompositionParticipant,
  CompositionReasonCode,
  ResumeNotice,
} from './types';

export function validateCompositionConfig(config?: CompositionConfig): {
  valid: boolean;
  reason?: CompositionReasonCode;
  message?: string;
} {
  if (!config || !config.enabled) {
    return { valid: true };
  }

  const drain = config.drainDeadlineMs ?? 1000;
  if (
    drain < COMPOSITION_CAPS.MIN_DRAIN_DEADLINE_MS ||
    drain > COMPOSITION_CAPS.MAX_DRAIN_DEADLINE_MS
  ) {
    return {
      valid: false,
      reason: COMPOSITION_REASON_CODES.INVALID_DRAIN_DEADLINE,
      message: `drainDeadlineMs must be between ${COMPOSITION_CAPS.MIN_DRAIN_DEADLINE_MS} and ${COMPOSITION_CAPS.MAX_DRAIN_DEADLINE_MS}`,
    };
  }

  const reserve = config.teardownReserveMs ?? 500;
  if (
    reserve < COMPOSITION_CAPS.MIN_TEARDOWN_RESERVE_MS ||
    reserve > COMPOSITION_CAPS.MAX_TEARDOWN_RESERVE_MS
  ) {
    return {
      valid: false,
      reason: COMPOSITION_REASON_CODES.INVALID_TEARDOWN_RESERVE,
      message: `teardownReserveMs must be between ${COMPOSITION_CAPS.MIN_TEARDOWN_RESERVE_MS} and ${COMPOSITION_CAPS.MAX_TEARDOWN_RESERVE_MS}`,
    };
  }

  if (config.durable && !config.journalStore) {
    return {
      valid: false,
      reason: COMPOSITION_REASON_CODES.DURABLE_REQUIRES_JOURNAL_STORE,
      message: 'durable mode requires a JournalStore',
    };
  }

  if (config.durable || config.sessionMode) {
    const incompatible =
      config.modelRouter ||
      config.workspaceTrials ||
      config.pixelBrowserControl ||
      config.sandboxEgress ||
      config.toolPrograms ||
      config.toolDiscovery;
    if (incompatible) {
      return {
        valid: false,
        reason: COMPOSITION_REASON_CODES.INCOMPATIBLE_SUBSYSTEM_COMOUNT,
        message: 'incompatible subsystem co-mounted with durable or session mode',
      };
    }
  }

  return { valid: true };
}

export class CompositionCoordinator {
  private envelope: CheckpointEnvelope;
  private jobFamilyBlocked = false;

  private constructor(
    private readonly config: CompositionConfig,
    runId: string,
    principal: string,
  ) {
    this.envelope = createInitialEnvelope(runId, principal);
  }

  static createIfEnabled(
    config: CompositionConfig | undefined,
    runId: string,
    principal = 'default',
  ): CompositionCoordinator | null {
    if (!config || !config.enabled) {
      return null;
    }
    const validation = validateCompositionConfig(config);
    if (!validation.valid) {
      const err = new Error(validation.message ?? 'Invalid composition config');
      (err as Error & { reason_code?: CompositionReasonCode }).reason_code = validation.reason;
      throw err;
    }
    return new CompositionCoordinator(config, runId, principal);
  }

  getEnvelope(): CheckpointEnvelope {
    return structuredClone(this.envelope);
  }

  isJobFamilyBlocked(): boolean {
    return this.jobFamilyBlocked;
  }

  isApprovalConsumed(digest: string): boolean {
    return this.envelope.consumed_approval_digests.includes(digest);
  }

  async consumeApproval(digest: string, nowMs = Date.now()): Promise<void> {
    if (this.isApprovalConsumed(digest)) {
      const err = new Error('Approval already consumed');
      (err as Error & { reason_code?: CompositionReasonCode }).reason_code =
        COMPOSITION_REASON_CODES.CONSUMED_APPROVAL_REUSE_BLOCKED;
      throw err;
    }
    this.envelope.consumed_approval_digests.push(digest);
    if (this.config.journalStore) {
      await this.config.journalStore.append({
        run_id: this.envelope.run_id,
        timestamp: nowMs,
        type: 'approval_consumed',
        payload: { digest },
      });
    }
  }

  async journalDispatchIntent(
    member: Omit<BatchMemberJournalRecord, 'status' | 'started'>,
    nowMs = Date.now(),
  ): Promise<BatchMemberJournalRecord> {
    const record: BatchMemberJournalRecord = {
      ...member,
      intent_journaled_at: nowMs,
      status: 'intent_journaled',
      started: true,
    };
    this.envelope.batch_members.push(record);
    if (this.config.journalStore) {
      await this.config.journalStore.append({
        run_id: this.envelope.run_id,
        timestamp: nowMs,
        type: 'dispatch_intent',
        payload: { ...record },
      });
    }
    return record;
  }

  async journalBatchSettlement(
    callId: string,
    outcome: 'success' | 'failure',
    resultDigest?: string,
    nowMs = Date.now(),
  ): Promise<void> {
    const member = this.envelope.batch_members.find((m) => m.call_id === callId);
    if (member) {
      member.status = 'settled';
      member.settled_at = nowMs;
      member.outcome = outcome;
      member.result_digest = resultDigest;
      delete member.reason_code;
    }
    if (this.config.journalStore) {
      await this.config.journalStore.append({
        run_id: this.envelope.run_id,
        timestamp: nowMs,
        type: 'batch_settled',
        payload: { call_id: callId, outcome, result_digest: resultDigest },
      });
    }
  }

  markUnjournaledMemberNotStarted(
    member: Omit<BatchMemberJournalRecord, 'status' | 'started' | 'outcome' | 'reason_code'>,
  ): BatchMemberJournalRecord {
    const record: BatchMemberJournalRecord = {
      ...member,
      status: 'not_started',
      started: false,
      outcome: 'not_started',
      reason_code: COMPOSITION_REASON_CODES.NOT_STARTED_NO_INTENT,
    };
    this.envelope.batch_members.push(record);
    return record;
  }

  async restoreFromJournal(
    jobPort?: ComposedJobPort,
    nowMs = Date.now(),
  ): Promise<{ envelope: CheckpointEnvelope; resumeNotice: ResumeNotice }> {
    if (this.config.journalStore) {
      const entries = await this.config.journalStore.readAll(this.envelope.run_id);
      this.envelope = rebuildEnvelopeFromJournal(
        this.envelope.run_id,
        this.envelope.principal,
        entries,
      );
    }

    const reasonCodes = new Set<CompositionReasonCode>();
    const unknownCallIds: string[] = [];

    for (const m of this.envelope.batch_members) {
      if (m.outcome === 'unknown') {
        unknownCallIds.push(m.call_id);
        reasonCodes.add(COMPOSITION_REASON_CODES.OUTCOME_UNKNOWN_UNSETTLED);
      }
    }

    if (jobPort) {
      const containers = await jobPort.listContainersByRunId(this.envelope.run_id);
      if (containers.length > 0 || this.envelope.job_records.length > 0) {
        this.jobFamilyBlocked = true;
        reasonCodes.add(COMPOSITION_REASON_CODES.JOB_FAMILY_BLOCKED);
      }
      for (const c of containers) {
        const lostRecord = {
          job_id: c.job_id,
          run_id: this.envelope.run_id,
          status: 'lost' as const,
          cleanup_confirmed: false,
        };
        const idx = this.envelope.job_records.findIndex((j) => j.job_id === c.job_id);
        if (idx >= 0) {
          this.envelope.job_records[idx] = lostRecord;
        } else {
          this.envelope.job_records.push(lostRecord);
        }
        if (this.config.journalStore) {
          await this.config.journalStore.append({
            run_id: this.envelope.run_id,
            timestamp: nowMs,
            type: 'job_recorded',
            payload: { ...lostRecord },
          });
        }
      }
      for (const j of this.envelope.job_records) {
        if (j.status === 'running') {
          j.status = 'lost';
        }
      }
      const removed = await jobPort.removeContainersByRunId(this.envelope.run_id);
      if (removed) {
        this.jobFamilyBlocked = false;
        for (const j of this.envelope.job_records) {
          j.cleanup_confirmed = true;
          j.status = 'removed';
          if (this.config.journalStore) {
            await this.config.journalStore.append({
              run_id: this.envelope.run_id,
              timestamp: nowMs,
              type: 'job_cleanup_confirmed',
              payload: { job_id: j.job_id },
            });
          }
        }
      }
    }

    const resumeNotice: ResumeNotice = {
      run_id: this.envelope.run_id,
      turn_index: this.envelope.turn_index,
      active_turn_state: this.envelope.active_turn_state,
      reason_codes: Array.from(reasonCodes),
      unknown_call_ids: unknownCallIds,
      job_family_blocked: this.jobFamilyBlocked,
    };

    return { envelope: this.getEnvelope(), resumeNotice };
  }

  async runTurnBoundary(participants: CompositionParticipant[]): Promise<CheckpointEnvelope> {
    // 1. Settle batch
    this.envelope.active_turn_state = 'settling';
    for (const p of participants) {
      await p.onBatchSettled?.(this.getEnvelope());
    }

    // 2. Commit participant deltas
    this.envelope.active_turn_state = 'committing';
    for (const p of participants) {
      await p.onTurnBoundary?.(this.getEnvelope());
    }

    // 3. Reconcile jobs & 4. Compact atomic turn groups
    this.envelope.active_turn_state = 'reconciling';
    this.envelope.active_turn_state = 'compacting';

    // 5. Retire known-failure slots only when fenced terminal boundary has no unresolved unknown
    const hasUnknown = this.envelope.batch_members.some((m) => m.outcome === 'unknown');
    if (!hasUnknown && this.envelope.recovery_slot) {
      this.envelope.recovery_slot.retired = true;
    }

    this.envelope.active_turn_state = 'terminal_fenced';
    this.envelope.turn_index += 1;

    if (this.config.journalStore) {
      await this.config.journalStore.append({
        run_id: this.envelope.run_id,
        timestamp: Date.now(),
        type: 'turn_state_changed',
        payload: {
          state: this.envelope.active_turn_state,
          turn_index: this.envelope.turn_index,
        },
      });
      await this.config.journalStore.persistView?.(this.getEnvelope());
    }

    return this.getEnvelope();
  }

  async abortAndFinalize(opts: {
    clock: () => number;
    runDeadlineMs: number;
    cancelInFlightJobs: () => Promise<void> | void;
    drainStartedCalls: () => Promise<void> | void;
    teardownJobs: () => Promise<void> | void;
    emitFinalEvent: (state: ComposedTurnState) => Promise<void> | void;
  }): Promise<CheckpointEnvelope> {
    const reserveMs = this.config.teardownReserveMs ?? 500;
    const teardownDeadline = opts.runDeadlineMs;
    const drainCutoff = teardownDeadline - reserveMs;

    await opts.cancelInFlightJobs();
    if (opts.clock() <= drainCutoff) {
      await opts.drainStartedCalls();
    }

    await opts.teardownJobs();

    if (opts.clock() > teardownDeadline) {
      this.envelope.teardown_unconfirmed = true;
      this.envelope.active_turn_state = 'teardown_unconfirmed';
      if (this.config.journalStore) {
        await this.config.journalStore.append({
          run_id: this.envelope.run_id,
          timestamp: opts.clock(),
          type: 'teardown_unconfirmed',
          payload: { reason: COMPOSITION_REASON_CODES.TEARDOWN_RESERVE_EXPIRED },
        });
      }
      await opts.emitFinalEvent('teardown_unconfirmed');
      return this.getEnvelope();
    }

    this.envelope.active_turn_state = 'aborted';
    if (this.config.journalStore) {
      await this.config.journalStore.append({
        run_id: this.envelope.run_id,
        timestamp: opts.clock(),
        type: 'turn_state_changed',
        payload: { state: 'aborted', turn_index: this.envelope.turn_index },
      });
    }
    await opts.emitFinalEvent('aborted');
    return this.getEnvelope();
  }
}
