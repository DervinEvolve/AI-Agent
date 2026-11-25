import {
  BatchMemberJournalRecord,
  CheckpointEnvelope,
  COMPOSITION_CAPS,
  COMPOSITION_REASON_CODES,
  ComposedJobRecord,
  ComposedTurnState,
  JournalEntry,
  JournalStore,
  RecoverySlotState,
} from './types';

export class InMemoryJournalStore implements JournalStore {
  private entriesByRun = new Map<string, JournalEntry[]>();
  private viewsByRun = new Map<string, CheckpointEnvelope>();
  private seq = 0;

  append(entry: Omit<JournalEntry, 'seq'>): JournalEntry {
    const full: JournalEntry = { ...entry, seq: ++this.seq };
    const list = this.entriesByRun.get(entry.run_id) ?? [];
    list.push(full);
    this.entriesByRun.set(entry.run_id, list);
    return full;
  }

  readAll(runId: string): JournalEntry[] {
    return [...(this.entriesByRun.get(runId) ?? [])];
  }

  persistView(envelope: CheckpointEnvelope): void {
    this.viewsByRun.set(envelope.run_id, structuredClone(envelope));
  }

  readView(runId: string): CheckpointEnvelope | null {
    const view = this.viewsByRun.get(runId);
    return view ? structuredClone(view) : null;
  }
}

export function createInitialEnvelope(runId: string, principal: string): CheckpointEnvelope {
  return {
    version: COMPOSITION_CAPS.ENVELOPE_VERSION,
    run_id: runId,
    principal,
    turn_index: 0,
    active_turn_state: 'idle',
    batch_members: [],
    recovery_slot: null,
    usage_admissions: [],
    workspace_quarantine: { quarantined: false },
    consumed_approval_digests: [],
    observation_call_ids: [],
    job_records: [],
    teardown_unconfirmed: false,
  };
}

export function rebuildEnvelopeFromJournal(
  runId: string,
  principal: string,
  entries: JournalEntry[],
): CheckpointEnvelope {
  const envelope = createInitialEnvelope(runId, principal);
  const membersById = new Map<string, BatchMemberJournalRecord>();
  const jobsById = new Map<string, ComposedJobRecord>();

  for (const entry of entries) {
    switch (entry.type) {
      case 'dispatch_intent': {
        const p = entry.payload as unknown as BatchMemberJournalRecord;
        const rec: BatchMemberJournalRecord = {
          call_id: p.call_id,
          provider_call_id: p.provider_call_id,
          tool_name: p.tool_name,
          args_digest: p.args_digest,
          intent_journaled_at: entry.timestamp,
          status: 'unknown',
          started: true,
          outcome: 'unknown',
          reason_code: COMPOSITION_REASON_CODES.OUTCOME_UNKNOWN_UNSETTLED,
        };
        membersById.set(p.call_id, rec);
        break;
      }
      case 'batch_settled': {
        const p = entry.payload as {
          call_id: string;
          outcome: 'success' | 'failure';
          result_digest?: string;
        };
        const existing = membersById.get(p.call_id);
        if (existing) {
          existing.status = 'settled';
          existing.settled_at = entry.timestamp;
          existing.outcome = p.outcome;
          existing.result_digest = p.result_digest;
          delete existing.reason_code;
        }
        break;
      }
      case 'recovery_slot_updated': {
        envelope.recovery_slot = structuredClone(entry.payload as unknown as RecoverySlotState);
        break;
      }
      case 'approval_consumed': {
        const digest = String(entry.payload.digest ?? '');
        if (digest && !envelope.consumed_approval_digests.includes(digest)) {
          envelope.consumed_approval_digests.push(digest);
        }
        break;
      }
      case 'job_recorded': {
        const job = entry.payload as unknown as ComposedJobRecord;
        jobsById.set(job.job_id, { ...job });
        break;
      }
      case 'job_cleanup_confirmed': {
        const jobId = String(entry.payload.job_id ?? '');
        const job = jobsById.get(jobId);
        if (job) {
          job.cleanup_confirmed = true;
          job.status = 'removed';
        }
        break;
      }
      case 'turn_state_changed': {
        envelope.active_turn_state = entry.payload.state as ComposedTurnState;
        if (typeof entry.payload.turn_index === 'number') {
          envelope.turn_index = entry.payload.turn_index;
        }
        break;
      }
      case 'teardown_unconfirmed': {
        envelope.teardown_unconfirmed = true;
        envelope.active_turn_state = 'teardown_unconfirmed';
        break;
      }
    }
  }

  envelope.batch_members = Array.from(membersById.values());
  envelope.job_records = Array.from(jobsById.values());
  return envelope;
}
