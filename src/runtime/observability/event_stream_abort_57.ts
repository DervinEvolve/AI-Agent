import {
  AbortConfig,
  CancelledResult,
  EventKind,
  EventSink,
  EventStreamConfig,
  OperationRef,
  RuntimeEvent,
  RuntimeReasonCode,
  ToolOutcomeSummary,
  ToolResultRef,
} from './types';

const DEFAULT_BYTE_CAP = 512;
const DEFAULT_DRAIN_DEADLINE_MS = 2000;

const REASON_ALLOWLIST: ReadonlySet<RuntimeReasonCode> = new Set([
  'success',
  'failure',
  'aborted',
  'unknown',
  'timeout',
  'cancelled',
  'sink_error',
  'not_run_aborted',
]);

/**
 * Runtime-owned, monotonic event stream and cooperative cancellation
 * controller.
 *
 * This is the pure-TS slice for cap_event_stream_abort_57. It is designed to
 * be attached to an existing AgentRuntime loop at the boundaries described in
 * the spec. It never mutates authoritative runtime state; it only projects
 * events and manages the abort/drain protocol.
 */
export class EventStreamAbortController {
  private seq = 0;
  private readonly runId: string;
  private readonly sink?: EventSink;
  private readonly byteCap: number;
  private readonly clock: () => number;
  private readonly signal?: AbortSignal;
  private readonly drainDeadlineMs: number;

  private readonly startedOps = new Map<string, OperationRef>();
  private readonly settledOps = new Map<string, ToolOutcomeSummary>();
  private readonly sinkErrors: Array<{ timestamp: number; error: string }> = [];

  private abortedFlag = false;
  private finalized = false;
  private abortListener?: () => void;

  constructor(runId: string, config: EventStreamConfig & AbortConfig = {}) {
    this.runId = runId;
    this.sink = config.sink;
    this.byteCap = config.byteCap ?? DEFAULT_BYTE_CAP;
    this.clock = config.clock ?? Date.now;
    this.signal = config.signal;
    this.drainDeadlineMs = config.drainDeadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS;

    if (this.signal) {
      if (this.signal.aborted) {
        this.abortedFlag = true;
      } else {
        this.abortListener = () => {
          this.abortedFlag = true;
        };
        this.signal.addEventListener('abort', this.abortListener, { once: true });
      }
    }
  }

  get isAborted(): boolean {
    return this.abortedFlag || this.signal?.aborted === true;
  }

  /**
   * Invocation-boundary abort check. Throws AbortError when the signal has
   * fired. The runtime catches this and finalizes a cancelled result.
   */
  checkAbort(): void {
    if (this.isAborted) {
      throw new AbortError();
    }
  }

  start(): void {
    this.emit('run_started', {});
  }

  turnStarted(turnIndex: number): void {
    this.checkAbort();
    this.emit('turn_started', { turn_index: turnIndex });
  }

  planRevised(planId: string, revision: number): void {
    this.emit('plan_revised', { plan_id: planId, revision });
  }

  /**
   * Records intent, not execution. Abort fired from inside the sink will be
   * caught by the subsequent recordStartedOperation boundary.
   */
  dispatchIntent(callId: string, toolName: string, argCount: number): void {
    this.checkAbort();
    this.emit('dispatch_intent', {
      call_id: callId,
      tool_name: toolName,
      arg_count: argCount,
    });
  }

  recordStartedOperation(op: OperationRef): void {
    this.checkAbort();
    if (!this.startedOps.has(op.call_id)) {
      this.startedOps.set(op.call_id, op);
    }
  }

  /**
   * Emits dispatch_settled exactly once per call_id. Late results after
   * finalization are ignored by the settledOps guard.
   */
  recordSettledOperation(callId: string, outcome: ToolOutcomeSummary): void {
    if (this.settledOps.has(callId)) {
      return;
    }
    this.settledOps.set(callId, outcome);
    this.emit('dispatch_settled', { call_id: callId, outcome });
  }

  compaction(digestStatus: string): void {
    this.emit('compaction', { digest_status: digestStatus });
  }

  verification(status: 'not_run_aborted' | 'passed' | 'failed'): void {
    this.emit('verification', { verification: status });
  }

  finalization(final: boolean, reason?: RuntimeReasonCode): void {
    this.emit('finalization', { final, reason });
    this.finalized = true;
  }

  aborted(): void {
    if (!this.finalized) {
      this.finalization(false, 'aborted');
    }
    this.emit('aborted', { reason: 'aborted' });
    this.finalized = true;
  }

  /**
   * Returns started operations that remain unresolved at the drain cutoff.
   * Each unresolved operation is also recorded with outcome unknown.
   */
  drainStartedOperations(): OperationRef[] {
    const unresolved: OperationRef[] = [];
    for (const [callId, op] of this.startedOps) {
      if (!this.settledOps.has(callId)) {
        unresolved.push(op);
        this.recordSettledOperation(callId, { status: 'unknown' });
      }
    }
    return unresolved;
  }

  /**
   * Builds the runtime-authored cancelled envelope. Does not include any
   * model-produced candidate text.
   */
  getCancelledResult(): CancelledResult {
    const references: ToolResultRef[] = [];
    for (const [callId] of this.startedOps) {
      const outcome = this.settledOps.get(callId);
      references.push({ call_id: callId, started: true, outcome });
    }
    const unresolved = this.drainStartedOperations();
    return {
      reason: 'aborted',
      references,
      unresolved,
      verification: 'not_run_aborted',
    };
  }

  /**
   * Returns recorded sink errors for diagnostics. Bounded and never resent.
   */
  getSinkErrors(): Array<{ timestamp: number; error: string }> {
    return [...this.sinkErrors];
  }

  dispose(): void {
    if (this.abortListener && this.signal) {
      this.signal.removeEventListener('abort', this.abortListener);
    }
  }

  private emit(kind: EventKind, payload: unknown): void {
    if (this.finalized && kind !== 'aborted') {
      return;
    }
    const event = this.buildEvent(kind, payload);
    this.deliver(event);
  }

  private buildEvent(kind: EventKind, payload: unknown): RuntimeEvent {
    const seq = ++this.seq;
    const timestamp = this.clock();
    const sanitized = this.sanitizePayload(payload);
    return {
      seq,
      run_id: this.runId,
      timestamp,
      kind,
      payload: sanitized,
    } as RuntimeEvent;
  }

  private sanitizePayload(payload: unknown): unknown {
    if (payload === undefined || payload === null) {
      return payload;
    }
    const json = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(json);
    if (bytes.length <= this.byteCap) {
      return payload;
    }
    const truncated = new TextDecoder().decode(bytes.slice(0, this.byteCap));
    const elided = bytes.length - this.byteCap;
    let parsed: unknown;
    try {
      parsed = JSON.parse(truncated);
    } catch {
      parsed = { _truncated: truncated };
    }
    if (parsed && typeof parsed === 'object') {
      return { ...(parsed as Record<string, unknown>), _elided_bytes: elided };
    }
    return { _elided_bytes: elided };
  }

  private deliver(event: RuntimeEvent): void {
    if (!this.sink) {
      return;
    }
    try {
      const result = this.sink(event);
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        const thenable = result as PromiseLike<unknown>;
        this.recordSinkError('thenable_returned');
        void thenable.catch(() => {});
      }
    } catch (error) {
      this.recordSinkError(error instanceof Error ? error.message : String(error));
    }
  }

  private recordSinkError(message: string): void {
    this.sinkErrors.push({
      timestamp: this.clock(),
      error: message.slice(0, 200),
    });
  }
}

export class AbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

/**
 * Startup guard: reject co-mounting with cap_durable_runs_mount_41 until a
 * fenced terminal-cancellation transition exists.
 */
export function assertNoDurableRunMount(signal?: AbortSignal): void {
  if (signal) {
    throw new Error(
      'cap_event_stream_abort_57 cannot be mounted together with cap_durable_runs_mount_41 while an AbortSignal is attached',
    );
  }
}
