/**
 * Host-facing runtime observability and cooperative cancellation types.
 *
 * These types describe the non-authoritative event projection and the
 * runtime-authored cancelled result. They are intentionally pure data:
 * no runtime state, no tool registry, no inference adapter.
 */

export type EventKind =
  | 'run_started'
  | 'turn_started'
  | 'plan_revised'
  | 'dispatch_intent'
  | 'dispatch_settled'
  | 'compaction'
  | 'verification'
  | 'finalization'
  | 'aborted';

export type RuntimeReasonCode =
  | 'success'
  | 'failure'
  | 'aborted'
  | 'unknown'
  | 'timeout'
  | 'cancelled'
  | 'sink_error'
  | 'not_run_aborted';

export interface RunStartedPayload {
  mode?: string;
}

export interface TurnStartedPayload {
  turn_index: number;
}

export interface PlanRevisedPayload {
  plan_id: string;
  revision: number;
}

export interface DispatchIntentPayload {
  call_id: string;
  tool_name: string;
  arg_count: number;
}

export interface ToolOutcomeSummary {
  status: 'success' | 'failure' | 'unknown' | 'aborted';
  classification?: string;
}

export interface DispatchSettledPayload {
  call_id: string;
  outcome: ToolOutcomeSummary;
}

export interface CompactionPayload {
  digest_status: string;
}

export interface VerificationPayload {
  verification: 'not_run_aborted' | 'passed' | 'failed';
}

export interface FinalizationPayload {
  final: boolean;
  reason?: RuntimeReasonCode;
}

export interface AbortedPayload {
  reason: 'aborted';
}

export type RuntimeEvent =
  | {
      seq: number;
      run_id: string;
      timestamp: number;
      kind: 'run_started';
      payload: RunStartedPayload;
    }
  | {
      seq: number;
      run_id: string;
      timestamp: number;
      kind: 'turn_started';
      payload: TurnStartedPayload;
    }
  | {
      seq: number;
      run_id: string;
      timestamp: number;
      kind: 'plan_revised';
      payload: PlanRevisedPayload;
    }
  | {
      seq: number;
      run_id: string;
      timestamp: number;
      kind: 'dispatch_intent';
      payload: DispatchIntentPayload;
    }
  | {
      seq: number;
      run_id: string;
      timestamp: number;
      kind: 'dispatch_settled';
      payload: DispatchSettledPayload;
    }
  | {
      seq: number;
      run_id: string;
      timestamp: number;
      kind: 'compaction';
      payload: CompactionPayload;
    }
  | {
      seq: number;
      run_id: string;
      timestamp: number;
      kind: 'verification';
      payload: VerificationPayload;
    }
  | {
      seq: number;
      run_id: string;
      timestamp: number;
      kind: 'finalization';
      payload: FinalizationPayload;
    }
  | {
      seq: number;
      run_id: string;
      timestamp: number;
      kind: 'aborted';
      payload: AbortedPayload;
    };

export interface EventSink {
  (event: RuntimeEvent): void;
}

export interface EventStreamConfig {
  /** Per-event byte cap, inclusive. Default 512. */
  byteCap?: number;
  /** Injectable clock for tests. Default Date.now. */
  clock?: () => number;
}

export interface AbortConfig {
  signal?: AbortSignal;
  /** Host-bounded drain deadline in milliseconds, inclusive. Default 2000. */
  drainDeadlineMs?: number;
}

export interface OperationRef {
  call_id: string;
  kind: 'tool' | 'inference' | 'child' | 'router_fallback';
}

export interface ToolResultRef {
  call_id: string;
  started: boolean;
  outcome?: ToolOutcomeSummary;
}

export interface CancelledResult {
  reason: 'aborted';
  references: ToolResultRef[];
  unresolved: OperationRef[];
  verification: 'not_run_aborted';
}
