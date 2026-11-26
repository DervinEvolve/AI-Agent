import type { BoardJournalAdapter } from './journal_adapter';
import {
  COMMITMENT_ABORTED,
  COMMITMENT_BOARD_DEFAULTS,
  COMMITMENT_BOARD_FULL,
  COMMITMENT_BOARD_HARD_CAPS,
  COMMITMENT_INVALID_INPUT,
  COMMITMENT_INVALID_TRANSITION,
  COMMITMENT_NOT_ACTIVE,
  COMMITMENT_NOT_FOUND,
  COMMITMENT_REF_NOT_OBSERVED,
  type BoardEvent,
  type CommitmentBoardConfig,
  type CommitmentEntry,
  type CommitmentKind,
  type CommitmentReasonCode,
  type CommitmentRef,
  type CommitmentRefInput,
  type CommitmentResolution,
  type ObservationLookup,
} from './types';

const BOARD_TOOL_NAMES_SET = new Set([
  'read_commitments',
  'record_commitment',
  'resolve_commitment',
]);

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function resolveCommitmentBoardConfig(
  partial?: Partial<CommitmentBoardConfig>
): CommitmentBoardConfig {
  const merged: CommitmentBoardConfig = {
    ...COMMITMENT_BOARD_DEFAULTS,
    ...partial,
  };

  const clamp = (val: number, hard: number, name: string): number => {
    if (!Number.isInteger(val) || val <= 0 || val > hard) {
      throw new Error(`Invalid CommitmentBoardConfig.${name}: ${val} (hard cap ${hard})`);
    }
    return val;
  };

  merged.maxActiveEntries = clamp(
    merged.maxActiveEntries,
    COMMITMENT_BOARD_HARD_CAPS.maxActiveEntries,
    'maxActiveEntries'
  );
  merged.maxCreations = clamp(
    merged.maxCreations,
    COMMITMENT_BOARD_HARD_CAPS.maxCreations,
    'maxCreations'
  );
  merged.maxTotalEvents = clamp(
    merged.maxTotalEvents,
    COMMITMENT_BOARD_HARD_CAPS.maxTotalEvents,
    'maxTotalEvents'
  );
  if (merged.maxTotalEvents < 2 * merged.maxCreations) {
    throw new Error(
      `Invalid CommitmentBoardConfig.maxTotalEvents: ${merged.maxTotalEvents} must be >= 2 * maxCreations (${2 * merged.maxCreations})`
    );
  }
  merged.maxSummaryBytes = clamp(
    merged.maxSummaryBytes,
    COMMITMENT_BOARD_HARD_CAPS.maxSummaryBytes,
    'maxSummaryBytes'
  );
  merged.maxRefDetailBytes = clamp(
    merged.maxRefDetailBytes,
    COMMITMENT_BOARD_HARD_CAPS.maxRefDetailBytes,
    'maxRefDetailBytes'
  );
  merged.maxRefsPerEntry = clamp(
    merged.maxRefsPerEntry,
    COMMITMENT_BOARD_HARD_CAPS.maxRefsPerEntry,
    'maxRefsPerEntry'
  );
  merged.maxRenderedBytes = clamp(
    merged.maxRenderedBytes,
    COMMITMENT_BOARD_HARD_CAPS.maxRenderedBytes,
    'maxRenderedBytes'
  );

  return merged;
}

export interface BoardMutationContext {
  call_id: string;
  turn_id: string | number;
  observationStore: ObservationLookup;
  abortSignal?: AbortSignal;
}

export type BoardMutationResult =
  | { started: true; ok: true; commitment: CommitmentEntry; events: BoardEvent[] }
  | { started: false; ok: false; reason: CommitmentReasonCode; message: string };

export interface ReadCommitmentsResult {
  ok: true;
  entries: CommitmentEntry[];
  total: number;
  next_offset: number | null;
}

export class CommitmentBoard {
  readonly config: CommitmentBoardConfig;
  readonly logicalRunId: string;
  private readonly events: BoardEvent[] = [];
  private readonly journal?: BoardJournalAdapter;
  private lockChain: Promise<void> = Promise.resolve();
  private nextCommitmentNum = 1;

  constructor(
    logicalRunId: string,
    config?: Partial<CommitmentBoardConfig>,
    initialEvents?: BoardEvent[],
    journal?: BoardJournalAdapter
  ) {
    this.logicalRunId = logicalRunId;
    this.config = resolveCommitmentBoardConfig(config);
    this.journal = journal;
    if (initialEvents && initialEvents.length > 0) {
      for (const ev of initialEvents) {
        this.events.push(ev);
        if (ev.type === 'created') {
          this.nextCommitmentNum++;
        }
      }
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lockChain;
    let release!: () => void;
    this.lockChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  getEvents(): readonly BoardEvent[] {
    return this.events;
  }

  deriveProjection(): CommitmentEntry[] {
    const byId = new Map<string, CommitmentEntry>();
    const order: string[] = [];

    for (const ev of this.events) {
      if (ev.type === 'created') {
        const entry: CommitmentEntry = {
          id: ev.commitment_id,
          kind: ev.kind,
          summary: ev.summary,
          status: 'active',
          refs: ev.refs.map((r) => ({ ...r })),
          created_at_seq: ev.seq,
          created_turn_id: ev.turn_id,
          ...(ev.supersedes_id ? { supersedes_id: ev.supersedes_id } : {}),
        };
        byId.set(ev.commitment_id, entry);
        order.push(ev.commitment_id);
      } else if (ev.type === 'superseded') {
        const target = byId.get(ev.commitment_id);
        if (target) {
          target.status = 'superseded';
          target.superseded_by_id = ev.superseded_by_id;
        }
      } else if (ev.type === 'resolved') {
        const target = byId.get(ev.commitment_id);
        if (target) {
          target.status = ev.resolution;
          target.resolved_at_seq = ev.seq;
          target.resolution = ev.resolution;
          target.resolution_summary = ev.summary;
          target.resolution_refs = ev.refs.map((r) => ({ ...r }));
        }
      }
    }

    return order.map((id) => byId.get(id)!);
  }

  readCommitments(params?: {
    status?: 'active' | 'all';
    limit?: number;
    offset?: number;
  }): ReadCommitmentsResult {
    const status = params?.status ?? 'active';
    const offset = Math.max(0, Math.floor(params?.offset ?? 0));
    const limit = Math.max(1, Math.min(100, Math.floor(params?.limit ?? 20)));

    const all = this.deriveProjection();
    const filtered = status === 'active' ? all.filter((e) => e.status === 'active') : all;
    const page = filtered.slice(offset, offset + limit);
    const next_offset = offset + page.length < filtered.length ? offset + page.length : null;

    return {
      ok: true,
      entries: page,
      total: filtered.length,
      next_offset,
    };
  }

  private validateSummary(summary: unknown): string | null {
    if (typeof summary !== 'string' || summary.trim().length === 0) {
      return 'summary must be a non-empty string';
    }
    if (hasControlCharacters(summary)) {
      return 'summary must not contain control characters';
    }
    if (utf8ByteLength(summary) > this.config.maxSummaryBytes) {
      return `summary exceeds maxSummaryBytes (${this.config.maxSummaryBytes})`;
    }
    return null;
  }

  private validateAndBindRefs(
    refs: CommitmentRefInput[] | undefined,
    minRefs: number,
    observationStore: ObservationLookup
  ): { ok: true; refs: CommitmentRef[] } | { ok: false; reason: CommitmentReasonCode; message: string } {
    const list = refs ?? [];
    if (!Array.isArray(list)) {
      return { ok: false, reason: COMMITMENT_INVALID_INPUT, message: 'refs must be an array' };
    }
    if (list.length < minRefs || list.length > this.config.maxRefsPerEntry) {
      return {
        ok: false,
        reason: COMMITMENT_INVALID_INPUT,
        message: `refs count must be between ${minRefs} and ${this.config.maxRefsPerEntry}`,
      };
    }

    const bound: CommitmentRef[] = [];
    for (const item of list) {
      if (!item || typeof item.call_id !== 'string' || item.call_id.length === 0) {
        return {
          ok: false,
          reason: COMMITMENT_REF_NOT_OBSERVED,
          message: 'ref.call_id must be a non-empty string',
        };
      }
      if (item.detail !== undefined) {
        if (typeof item.detail !== 'string' || hasControlCharacters(item.detail)) {
          return {
            ok: false,
            reason: COMMITMENT_INVALID_INPUT,
            message: 'ref.detail must be a string without control characters',
          };
        }
        if (utf8ByteLength(item.detail) > this.config.maxRefDetailBytes) {
          return {
            ok: false,
            reason: COMMITMENT_INVALID_INPUT,
            message: `ref.detail exceeds maxRefDetailBytes (${this.config.maxRefDetailBytes})`,
          };
        }
      }

      const obs = observationStore.getByCallId(item.call_id, this.logicalRunId);
      if (!obs || !obs.started || BOARD_TOOL_NAMES_SET.has(obs.tool_name)) {
        return {
          ok: false,
          reason: COMMITMENT_REF_NOT_OBSERVED,
          message: `ref.call_id '${item.call_id}' is not a started non-board observation in this logical run`,
        };
      }

      bound.push({
        logical_run_id: obs.logical_run_id,
        turn_id: obs.turn_id,
        call_id: obs.call_id,
        outcome: obs.outcome,
        ...(item.detail !== undefined ? { detail: item.detail } : {}),
      });
    }

    return { ok: true, refs: bound };
  }

  async recordCommitment(
    params: {
      kind: CommitmentKind;
      summary: string;
      refs?: CommitmentRefInput[];
      supersedes_id?: string;
    },
    ctx: BoardMutationContext
  ): Promise<BoardMutationResult> {
    const summaryErr = this.validateSummary(params.summary);
    if (summaryErr) {
      return { started: false, ok: false, reason: COMMITMENT_INVALID_INPUT, message: summaryErr };
    }
    if (params.kind !== 'decision' && params.kind !== 'open_question') {
      return {
        started: false,
        ok: false,
        reason: COMMITMENT_INVALID_INPUT,
        message: 'kind must be decision or open_question',
      };
    }

    const minRefs = params.kind === 'decision' ? 1 : 0;
    const refsResult = this.validateAndBindRefs(params.refs, minRefs, ctx.observationStore);
    if (!refsResult.ok) {
      return { started: false, ok: false, reason: refsResult.reason, message: refsResult.message };
    }

    return this.withLock(async () => {
      if (ctx.abortSignal?.aborted) {
        return {
          started: false,
          ok: false,
          reason: COMMITMENT_ABORTED,
          message: 'operation aborted before commit',
        };
      }

      const projection = this.deriveProjection();
      const creationsCount = this.events.filter((e) => e.type === 'created').length;
      if (creationsCount >= this.config.maxCreations) {
        return {
          started: false,
          ok: false,
          reason: COMMITMENT_BOARD_FULL,
          message: `maxCreations (${this.config.maxCreations}) reached`,
        };
      }

      const neededEvents = params.supersedes_id ? 2 : 1;
      if (this.events.length + neededEvents > this.config.maxTotalEvents) {
        return {
          started: false,
          ok: false,
          reason: COMMITMENT_BOARD_FULL,
          message: `maxTotalEvents (${this.config.maxTotalEvents}) reached`,
        };
      }

      if (params.supersedes_id !== undefined) {
        const target = projection.find((e) => e.id === params.supersedes_id);
        if (!target) {
          return {
            started: false,
            ok: false,
            reason: COMMITMENT_NOT_FOUND,
            message: `commitment '${params.supersedes_id}' not found`,
          };
        }
        if (target.status !== 'active') {
          return {
            started: false,
            ok: false,
            reason: COMMITMENT_NOT_ACTIVE,
            message: `commitment '${params.supersedes_id}' is not active (status=${target.status})`,
          };
        }
      }

      const activeCount = projection.filter((e) => e.status === 'active').length;
      const postActiveCount = params.supersedes_id ? activeCount : activeCount + 1;
      if (postActiveCount > this.config.maxActiveEntries) {
        return {
          started: false,
          ok: false,
          reason: COMMITMENT_BOARD_FULL,
          message: `maxActiveEntries (${this.config.maxActiveEntries}) reached`,
        };
      }

      const newId = `cmt_${this.nextCommitmentNum}`;
      const now = Date.now();
      const baseSeq = this.events.length + 1;
      const newEvents: BoardEvent[] = [];

      if (params.supersedes_id) {
        newEvents.push({
          seq: baseSeq,
          type: 'superseded',
          call_id: ctx.call_id,
          logical_run_id: this.logicalRunId,
          turn_id: ctx.turn_id,
          commitment_id: params.supersedes_id,
          timestamp: now,
          superseded_by_id: newId,
        });
      }

      newEvents.push({
        seq: baseSeq + (params.supersedes_id ? 1 : 0),
        type: 'created',
        call_id: ctx.call_id,
        logical_run_id: this.logicalRunId,
        turn_id: ctx.turn_id,
        commitment_id: newId,
        timestamp: now,
        kind: params.kind,
        summary: params.summary,
        refs: refsResult.refs,
        ...(params.supersedes_id ? { supersedes_id: params.supersedes_id } : {}),
      });

      if (this.journal) {
        await this.journal.appendIntent(ctx.call_id);
        if (ctx.abortSignal?.aborted) {
          return {
            started: false,
            ok: false,
            reason: COMMITMENT_ABORTED,
            message: 'operation aborted before journal commit',
          };
        }
        await this.journal.appendEvents(ctx.call_id, newEvents);
      } else if (ctx.abortSignal?.aborted) {
        return {
          started: false,
          ok: false,
          reason: COMMITMENT_ABORTED,
          message: 'operation aborted before commit',
        };
      }

      this.nextCommitmentNum++;
      this.events.push(...newEvents);
      const created = this.deriveProjection().find((e) => e.id === newId)!;
      return { started: true, ok: true, commitment: created, events: newEvents };
    });
  }

  async resolveCommitment(
    params: {
      commitment_id: string;
      resolution: CommitmentResolution;
      summary: string;
      refs?: CommitmentRefInput[];
    },
    ctx: BoardMutationContext
  ): Promise<BoardMutationResult> {
    const summaryErr = this.validateSummary(params.summary);
    if (summaryErr) {
      return { started: false, ok: false, reason: COMMITMENT_INVALID_INPUT, message: summaryErr };
    }
    if (params.resolution !== 'answered' && params.resolution !== 'abandoned') {
      return {
        started: false,
        ok: false,
        reason: COMMITMENT_INVALID_INPUT,
        message: 'resolution must be answered or abandoned',
      };
    }

    const refsResult = this.validateAndBindRefs(params.refs, 0, ctx.observationStore);
    if (!refsResult.ok) {
      return { started: false, ok: false, reason: refsResult.reason, message: refsResult.message };
    }

    return this.withLock(async () => {
      if (ctx.abortSignal?.aborted) {
        return {
          started: false,
          ok: false,
          reason: COMMITMENT_ABORTED,
          message: 'operation aborted before commit',
        };
      }

      const projection = this.deriveProjection();
      const target = projection.find((e) => e.id === params.commitment_id);
      if (!target) {
        return {
          started: false,
          ok: false,
          reason: COMMITMENT_NOT_FOUND,
          message: `commitment '${params.commitment_id}' not found`,
        };
      }
      if (target.status !== 'active') {
        return {
          started: false,
          ok: false,
          reason: COMMITMENT_NOT_ACTIVE,
          message: `commitment '${params.commitment_id}' is not active (status=${target.status})`,
        };
      }
      if (target.kind === 'decision' && params.resolution === 'answered') {
        return {
          started: false,
          ok: false,
          reason: COMMITMENT_INVALID_TRANSITION,
          message: 'cannot resolve a decision with answered; use abandoned or supersede',
        };
      }
      if (this.events.length + 1 > this.config.maxTotalEvents) {
        return {
          started: false,
          ok: false,
          reason: COMMITMENT_BOARD_FULL,
          message: `maxTotalEvents (${this.config.maxTotalEvents}) reached`,
        };
      }

      const ev: BoardEvent = {
        seq: this.events.length + 1,
        type: 'resolved',
        call_id: ctx.call_id,
        logical_run_id: this.logicalRunId,
        turn_id: ctx.turn_id,
        commitment_id: params.commitment_id,
        timestamp: Date.now(),
        resolution: params.resolution,
        summary: params.summary,
        refs: refsResult.refs,
      };

      if (this.journal) {
        await this.journal.appendIntent(ctx.call_id);
        if (ctx.abortSignal?.aborted) {
          return {
            started: false,
            ok: false,
            reason: COMMITMENT_ABORTED,
            message: 'operation aborted before journal commit',
          };
        }
        await this.journal.appendEvents(ctx.call_id, [ev]);
      } else if (ctx.abortSignal?.aborted) {
        return {
          started: false,
          ok: false,
          reason: COMMITMENT_ABORTED,
          message: 'operation aborted before commit',
        };
      }

      this.events.push(ev);
      const updated = this.deriveProjection().find((e) => e.id === params.commitment_id)!;
      return { started: true, ok: true, commitment: updated, events: [ev] };
    });
  }
}
