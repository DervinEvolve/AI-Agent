import { createHash, randomUUID } from 'crypto';
import { redactSecrets } from './secret_redactor';

export const CAP_TRAJECTORY_OBSERVABILITY_EVAL_18 = {
  id: 'cap_trajectory_observability_eval_18',
  name: 'Structured trajectory tracing, evaluation, and feedback harness',
  status: 'active',
  tool_name: 'trace_eval',
} as const;

export type TraceAction =
  | 'start_trace'
  | 'record_event'
  | 'close_trace'
  | 'evaluate_trace'
  | 'derive_lesson'
  | 'export_redacted_trace'
  | 'inspect_trace';

export type TraceStatus =
  | 'ok'
  | 'policy_blocked'
  | 'budget_exhausted'
  | 'not_found'
  | 'invalid_event'
  | 'evaluation_failed'
  | 'requires_review'
  | 'redacted'
  | 'failed';

export type TrajectoryEventType =
  | 'model_call'
  | 'planning_step'
  | 'tool_invocation'
  | 'sandbox_execution'
  | 'browser_observation'
  | 'api_observation'
  | 'document_observation'
  | 'perception_observation'
  | 'memory_operation'
  | 'subagent_handoff'
  | 'budget_reservation'
  | 'taint_transition'
  | 'hitl_gate'
  | 'approval_verification'
  | 'mission_control_milestone'
  | 'skill_retrieval'
  | 'skill_execution'
  | 'reflection'
  | 'retry'
  | 'failure'
  | 'final_answer';

export interface TraceScope {
  tenant_id?: string;
  user_id?: string;
  task_scope?: string;
  retention_days?: number;
  [key: string]: unknown;
}

export interface BudgetDelta {
  tokens?: number;
  cost_usd?: number;
  milliseconds?: number;
  [key: string]: unknown;
}

export interface TraceEventInput {
  event_type: TrajectoryEventType;
  actor: string;
  scope?: TraceScope;
  inputs?: unknown;
  outputs?: unknown;
  status?: string;
  tainted_in?: boolean;
  tainted_out?: boolean;
  provenance?: Record<string, unknown>;
  budget_delta?: BudgetDelta;
  policy_checks?: Array<Record<string, unknown>>;
  evidence_refs?: string[];
  timestamp?: string;
}

export interface StoredTraceEvent {
  event_id: string;
  trace_id: string;
  sequence: number;
  timestamp: string;
  event_type: TrajectoryEventType;
  actor: string;
  scope: TraceScope;
  inputs_redacted: unknown;
  outputs_redacted: unknown;
  status: string;
  tainted_in: boolean;
  tainted_out: boolean;
  provenance: Record<string, unknown>;
  budget_delta: BudgetDelta;
  policy_checks: Array<Record<string, unknown>>;
  evidence_refs: string[];
  canonical_hash: string;
}

export interface TraceRef {
  trace_id: string;
  task_id: string;
  version: number;
  event_count: number;
  started_at: string;
  closed_at?: string;
  scope: TraceScope;
}

export interface EvaluationResult {
  overall_status: 'passed' | 'failed' | 'uncertain';
  score: number;
  dimension_scores: Record<string, number>;
  criteria_results: Array<{
    criterion: string;
    status: 'passed' | 'failed' | 'uncertain';
    evidence_refs: string[];
    rationale: string;
  }>;
  failure_modes: string[];
  confidence: number;
  judge_provenance: Record<string, unknown>;
  limitations: string[];
}

export interface LessonCandidate {
  summary: string;
  failure_pattern: string;
  corrective_action: string;
  evidence_refs: string[];
  suggested_memory_write?: Record<string, unknown>;
  suggested_skill_update?: Record<string, unknown>;
  requires_human_review: boolean;
}

export interface TraceEvalRequest {
  action: TraceAction;
  trace_id?: string;
  task_id?: string;
  event?: TraceEventInput;
  success_criteria?: string[];
  rubric?: Record<string, unknown>;
  lesson_scope?: TraceScope;
  export_policy?: {
    audience?: string;
    max_events?: number;
    include_hashes?: boolean;
    include_hidden_prompts?: false;
    [key: string]: unknown;
  };
  scope?: TraceScope;
  budget_remaining?: number;
}

export interface TraceEvalResponse {
  status: TraceStatus;
  error?: { code: string; message: string; retryable: boolean };
  tainted: boolean;
  trace_ref?: TraceRef;
  event_ref?: {
    trace_id: string;
    event_id: string;
    sequence: number;
    event_type: string;
    timestamp: string;
  };
  evaluation?: EvaluationResult;
  lesson_candidate?: LessonCandidate;
  redacted_trace?: Record<string, unknown>;
  provenance: {
    trace_id: string;
    task_id: string;
    controller_run_id?: string;
    timestamps: Record<string, string>;
    redaction_policy_id: string;
    evaluator_version?: string;
  };
}

interface TraceRecord {
  trace_id: string;
  task_id: string;
  version: number;
  started_at: string;
  closed_at?: string;
  terminal_status?: string;
  scope: TraceScope;
  events: StoredTraceEvent[];
  tainted: boolean;
  linked_from?: string;
}

const REDACTION_POLICY_ID = 'trace-eval-redaction-v1';
const EVALUATOR_VERSION = 'trajectory-heuristic-evaluator-v1';
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_TRACE_EVENTS = 2_000;

const ALLOWED_EVENT_TYPES = new Set<TrajectoryEventType>([
  'model_call',
  'planning_step',
  'tool_invocation',
  'sandbox_execution',
  'browser_observation',
  'api_observation',
  'document_observation',
  'perception_observation',
  'memory_operation',
  'subagent_handoff',
  'budget_reservation',
  'taint_transition',
  'hitl_gate',
  'approval_verification',
  'mission_control_milestone',
  'skill_retrieval',
  'skill_execution',
  'reflection',
  'retry',
  'failure',
  'final_answer',
]);

const FORBIDDEN_STORAGE_KEYS = new Set([
  'raw_secret',
  'secret',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'approval_token',
  'pending_approval_id',
  'cookie',
  'cookies',
  'vault_session_handle',
  'vault_handle',
  'private_key',
  'hidden_prompt',
]);

function emptyProvenance(traceId = '', taskId = ''): TraceEvalResponse['provenance'] {
  return {
    trace_id: traceId,
    task_id: taskId,
    timestamps: { generated_at: new Date().toISOString() },
    redaction_policy_id: REDACTION_POLICY_ID,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(',')}}`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function redactor(value: unknown): unknown {
  const fn = redactSecrets as unknown as (input: unknown) => unknown;
  return fn(value);
}

function containsForbiddenKey(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => {
    const normalized = key.toLowerCase();
    return FORBIDDEN_STORAGE_KEYS.has(normalized) || containsForbiddenKey(child);
  });
}

function containsVaultSecretBytes(value: unknown): boolean {
  const serialized = typeof value === 'string' ? value : stableStringify(value);
  return /VAULT_SECRET_BYTES|vault_held_secret|BEGIN ACTUAL VAULT SECRET|actual-vault-secret/i.test(serialized);
}

function sanitizeForStorage(value: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (containsVaultSecretBytes(value)) {
    return { ok: false, reason: 'event contains bytes marked as vault-held secret material' };
  }
  const redacted = redactor(value);
  if (containsVaultSecretBytes(redacted)) {
    return { ok: false, reason: 'redaction did not remove vault-held secret material' };
  }
  return { ok: true, value: redacted };
}

function traceRef(trace: TraceRecord): TraceRef {
  return {
    trace_id: trace.trace_id,
    task_id: trace.task_id,
    version: trace.version,
    event_count: trace.events.length,
    started_at: trace.started_at,
    closed_at: trace.closed_at,
    scope: trace.scope,
  };
}

function textOf(value: unknown): string {
  return stableStringify(value).toLowerCase();
}

function evidenceRef(event: StoredTraceEvent): string {
  return `${event.trace_id}:${event.sequence}:${event.canonical_hash}`;
}

function hasEvidenceForCriterion(events: StoredTraceEvent[], criterion: string): StoredTraceEvent[] {
  const words = criterion
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !['must', 'should', 'with', 'that', 'have', 'from', 'this', 'there'].includes(word));
  if (words.length === 0) return [];
  return events.filter((event) => {
    if (!['tool_invocation', 'sandbox_execution', 'api_observation', 'document_observation', 'mission_control_milestone', 'skill_execution', 'final_answer'].includes(event.event_type)) {
      return false;
    }
    const haystack = textOf({ inputs: event.inputs_redacted, outputs: event.outputs_redacted, status: event.status });
    return words.some((word) => haystack.includes(word));
  });
}

function defaultFailureResponse(status: TraceStatus, code: string, message: string, retryable = false, trace?: TraceRecord): TraceEvalResponse {
  return {
    status,
    error: { code, message, retryable },
    tainted: trace?.tainted ?? false,
    trace_ref: trace ? traceRef(trace) : undefined,
    provenance: emptyProvenance(trace?.trace_id ?? '', trace?.task_id ?? ''),
  };
}

export class TraceRecorder {
  private traces = new Map<string, TraceRecord>();

  handle(request: TraceEvalRequest): TraceEvalResponse {
    if (request.budget_remaining !== undefined && request.budget_remaining <= 0) {
      return defaultFailureResponse('budget_exhausted', 'budget_exhausted', 'trace_eval budget is exhausted', true);
    }

    switch (request.action) {
      case 'start_trace':
        return this.startTrace(request);
      case 'record_event':
        return this.recordEvent(request);
      case 'close_trace':
        return this.closeTrace(request);
      case 'evaluate_trace':
        return this.evaluateTrace(request);
      case 'derive_lesson':
        return this.deriveLesson(request);
      case 'export_redacted_trace':
        return this.exportTrace(request);
      case 'inspect_trace':
        return this.inspectTrace(request);
      default:
        return defaultFailureResponse('failed', 'unknown_action', `unknown trace_eval action ${(request as { action: string }).action}`);
    }
  }

  startTrace(request: TraceEvalRequest): TraceEvalResponse {
    const trace_id = `trace_${randomUUID()}`;
    const task_id = request.task_id ?? `task_${randomUUID()}`;
    const started_at = new Date().toISOString();
    const scope = request.scope ?? {};
    const trace: TraceRecord = {
      trace_id,
      task_id,
      version: 1,
      started_at,
      scope,
      events: [],
      tainted: false,
    };
    this.traces.set(trace_id, trace);
    return {
      status: 'ok',
      tainted: false,
      trace_ref: traceRef(trace),
      provenance: { ...emptyProvenance(trace_id, task_id), timestamps: { started_at } },
    };
  }

  recordEvent(request: TraceEvalRequest): TraceEvalResponse {
    const trace = this.getTrace(request.trace_id);
    if (!trace) return defaultFailureResponse('not_found', 'trace_not_found', 'trace_id was not found');
    if (trace.closed_at) {
      return defaultFailureResponse('invalid_event', 'trace_closed', 'closed traces are immutable; start a linked trace version instead', false, trace);
    }
    if (!request.event) return defaultFailureResponse('invalid_event', 'missing_event', 'record_event requires an event', false, trace);
    if (trace.events.length >= MAX_TRACE_EVENTS) return defaultFailureResponse('budget_exhausted', 'trace_event_limit', 'trace event limit reached', false, trace);

    const validation = this.validateEvent(request.event);
    if (!validation.ok) return defaultFailureResponse('invalid_event', validation.code, validation.message, false, trace);

    const rawBytes = Buffer.byteLength(stableStringify(request.event), 'utf8');
    if (rawBytes > MAX_EVENT_BYTES) return defaultFailureResponse('invalid_event', 'event_too_large', 'event exceeds maximum canonical size', false, trace);

    const combined = { inputs: request.event.inputs, outputs: request.event.outputs, provenance: request.event.provenance };
    if (containsVaultSecretBytes(combined)) {
      return defaultFailureResponse('policy_blocked', 'vault_secret_material', 'event contains actual vault-held secret bytes and was not stored', false, trace);
    }

    const inputs = sanitizeForStorage(request.event.inputs ?? {});
    const outputs = sanitizeForStorage(request.event.outputs ?? {});
    const provenance = sanitizeForStorage(request.event.provenance ?? {});
    if (!inputs.ok || !outputs.ok || !provenance.ok) {
      return defaultFailureResponse('policy_blocked', 'secret_redaction_failed', 'event could not be safely redacted for storage', false, trace);
    }

    const tainted_in = Boolean(request.event.tainted_in || trace.tainted);
    const tainted_out = Boolean(request.event.tainted_out || tainted_in);
    const timestamp = request.event.timestamp ?? new Date().toISOString();
    const base = {
      event_id: `evt_${randomUUID()}`,
      trace_id: trace.trace_id,
      sequence: trace.events.length + 1,
      timestamp,
      event_type: request.event.event_type,
      actor: request.event.actor,
      scope: request.event.scope ?? trace.scope,
      inputs_redacted: inputs.value,
      outputs_redacted: outputs.value,
      status: request.event.status ?? 'ok',
      tainted_in,
      tainted_out,
      provenance: provenance.value as Record<string, unknown>,
      budget_delta: request.event.budget_delta ?? {},
      policy_checks: request.event.policy_checks ?? [],
      evidence_refs: request.event.evidence_refs ?? [],
    } satisfies Omit<StoredTraceEvent, 'canonical_hash'>;
    const canonical_hash = sha256(base);
    const stored: StoredTraceEvent = { ...base, canonical_hash };
    trace.events.push(stored);
    trace.tainted = trace.tainted || tainted_out;

    return {
      status: 'ok',
      tainted: trace.tainted,
      trace_ref: traceRef(trace),
      event_ref: {
        trace_id: trace.trace_id,
        event_id: stored.event_id,
        sequence: stored.sequence,
        event_type: stored.event_type,
        timestamp: stored.timestamp,
      },
      provenance: emptyProvenance(trace.trace_id, trace.task_id),
    };
  }

  closeTrace(request: TraceEvalRequest): TraceEvalResponse {
    const trace = this.getTrace(request.trace_id);
    if (!trace) return defaultFailureResponse('not_found', 'trace_not_found', 'trace_id was not found');
    if (!trace.closed_at) {
      trace.closed_at = new Date().toISOString();
      trace.terminal_status = request.event?.status ?? 'closed';
    }
    return {
      status: 'ok',
      tainted: trace.tainted,
      trace_ref: traceRef(trace),
      provenance: { ...emptyProvenance(trace.trace_id, trace.task_id), timestamps: { closed_at: trace.closed_at } },
    };
  }

  evaluateTrace(request: TraceEvalRequest): TraceEvalResponse {
    const trace = this.getTrace(request.trace_id);
    if (!trace) return defaultFailureResponse('not_found', 'trace_not_found', 'trace_id was not found');
    if (!trace.closed_at) return defaultFailureResponse('evaluation_failed', 'trace_not_closed', 'only closed traces can be evaluated', true, trace);
    const criteria = request.success_criteria?.filter((criterion) => criterion.trim().length > 0) ?? [];
    if (criteria.length === 0) {
      return defaultFailureResponse('evaluation_failed', 'missing_success_criteria', 'evaluate_trace requires explicit immutable success criteria', false, trace);
    }

    const failureModes = new Set<string>();
    const limitations: string[] = [];
    const finalAnswers = trace.events.filter((event) => event.event_type === 'final_answer');
    const finalText = finalAnswers.map((event) => textOf(event.outputs_redacted)).join('\n');
    const claimsSuccess = /success|completed|done|passed|finished|resolved/.test(finalText);

    const criteria_results = criteria.map((criterion) => {
      const evidence = hasEvidenceForCriterion(trace.events, criterion);
      if (evidence.length === 0) {
        const status = claimsSuccess ? 'failed' : 'uncertain';
        failureModes.add(claimsSuccess ? 'unsupported_success_claim' : 'missing_supporting_evidence');
        return {
          criterion,
          status: status as 'failed' | 'uncertain',
          evidence_refs: [] as string[],
          rationale: 'no supporting closed-trace evidence matched this criterion',
        };
      }
      const hasFailedEvidence = evidence.some((event) => /fail|error|blocked|denied/.test(String(event.status).toLowerCase()));
      if (hasFailedEvidence) failureModes.add('criterion_has_failed_evidence');
      return {
        criterion,
        status: hasFailedEvidence ? ('failed' as const) : ('passed' as const),
        evidence_refs: evidence.map(evidenceRef),
        rationale: hasFailedEvidence ? 'matching evidence exists but includes a failed status' : 'matching evidence found in closed trace',
      };
    });

    for (const event of trace.events) {
      const serialized = textOf(event);
      if (event.tainted_in && ['tool_invocation', 'api_observation', 'memory_operation', 'subagent_handoff', 'final_answer'].includes(event.event_type)) {
        const validated = event.policy_checks.some((check) => /validat|verified|grounded/.test(textOf(check)) && !/false|fail|denied/.test(textOf(check)));
        if (!validated) failureModes.add('taint_laundering_without_validation');
      }
      if (event.event_type === 'skill_execution' && !/verified|immutable_criteria_passed/.test(serialized)) failureModes.add('unverified_skill_execution');
      if (event.event_type === 'skill_retrieval' && /stale|expired|superseded/.test(serialized)) failureModes.add('stale_skill_use');
      if (event.event_type === 'mission_control_milestone' && /weakened|skipped|unsupported/.test(serialized)) failureModes.add('weakened_or_unsupported_mission_criteria');
      if (event.event_type === 'budget_reservation' && /overrun|exceeded|misuse/.test(serialized)) failureModes.add('budget_misuse');
    }

    const failedCount = criteria_results.filter((result) => result.status === 'failed').length;
    const uncertainCount = criteria_results.filter((result) => result.status === 'uncertain').length;
    const passedCount = criteria_results.filter((result) => result.status === 'passed').length;
    let overall_status: EvaluationResult['overall_status'] = 'passed';
    if (failedCount > 0 || failureModes.has('taint_laundering_without_validation') || failureModes.has('unverified_skill_execution')) overall_status = 'failed';
    else if (uncertainCount > 0 || trace.tainted) overall_status = 'uncertain';

    if (trace.tainted) limitations.push('evaluation is advisory because one or more trace inputs or outputs are tainted');
    if (criteria_results.some((result) => result.evidence_refs.length === 0)) limitations.push('one or more criteria lack direct evidence references');

    const baseScore = criteria.length === 0 ? 0 : passedCount / criteria.length;
    const penalty = Math.min(0.4, failureModes.size * 0.1 + (trace.tainted ? 0.1 : 0));
    const score = Math.max(0, Math.min(1, baseScore - penalty));
    const evaluation: EvaluationResult = {
      overall_status,
      score,
      dimension_scores: this.scoreDimensions(request.rubric, score, failureModes),
      criteria_results,
      failure_modes: [...failureModes].sort(),
      confidence: trace.tainted || uncertainCount > 0 ? 0.55 : 0.82,
      judge_provenance: {
        evaluator_version: EVALUATOR_VERSION,
        judge_type: 'deterministic_heuristic',
        authority: 'advisory_only',
        cannot_authorize_actions: true,
        cannot_clear_taint: true,
      },
      limitations,
    };

    return {
      status: 'ok',
      tainted: trace.tainted,
      trace_ref: traceRef(trace),
      evaluation,
      provenance: { ...emptyProvenance(trace.trace_id, trace.task_id), evaluator_version: EVALUATOR_VERSION },
    };
  }

  deriveLesson(request: TraceEvalRequest): TraceEvalResponse {
    const evaluated = this.evaluateTrace(request);
    if (!evaluated.evaluation || !request.trace_id) return evaluated;
    const trace = this.getTrace(request.trace_id);
    if (!trace) return evaluated;
    const failure = evaluated.evaluation.failure_modes[0] ?? 'missing_or_uncertain_success_evidence';
    const evidence_refs = trace.events.slice(-5).map(evidenceRef);
    const requires_human_review = evaluated.tainted || evaluated.evaluation.confidence < 0.7 || evaluated.evaluation.overall_status !== 'passed';
    const lesson_candidate: LessonCandidate = {
      summary: `Trajectory evaluation identified ${failure}.`,
      failure_pattern: failure,
      corrective_action: 'Before claiming success or deriving future actions, collect validated evidence for each immutable success criterion and keep tainted observations segregated.',
      evidence_refs,
      suggested_memory_write: {
        scope: request.lesson_scope ?? trace.scope,
        kind: 'advisory_lesson_candidate',
        content: `Avoid recurrence of ${failure}; require validated evidence refs before success claims.`,
        policy_required: 'cap_long_term_memory_3_content_policy',
      },
      suggested_skill_update: {
        kind: 'advisory_skill_improvement_candidate',
        verification_required: 'cap_procedural_memory_skill_library_14',
      },
      requires_human_review,
    };
    return {
      status: requires_human_review ? 'requires_review' : 'ok',
      tainted: evaluated.tainted,
      trace_ref: traceRef(trace),
      evaluation: evaluated.evaluation,
      lesson_candidate,
      provenance: { ...emptyProvenance(trace.trace_id, trace.task_id), evaluator_version: EVALUATOR_VERSION },
    };
  }

  exportTrace(request: TraceEvalRequest): TraceEvalResponse {
    const trace = this.getTrace(request.trace_id);
    if (!trace) return defaultFailureResponse('not_found', 'trace_not_found', 'trace_id was not found');
    const maxEvents = Math.max(0, Math.min(request.export_policy?.max_events ?? trace.events.length, trace.events.length));
    const events = trace.events.slice(0, maxEvents).map((event) => {
      const exported: Record<string, unknown> = {
        event_id: event.event_id,
        trace_id: event.trace_id,
        sequence: event.sequence,
        timestamp: event.timestamp,
        event_type: event.event_type,
        actor: event.actor,
        scope: event.scope,
        inputs_redacted: redactor(removeDeletedMemoryContent(stripForbiddenKeys(event.inputs_redacted))),
        outputs_redacted: redactor(removeDeletedMemoryContent(stripForbiddenKeys(event.outputs_redacted))),
        status: event.status,
        tainted_in: event.tainted_in,
        tainted_out: event.tainted_out,
        provenance: redactor(stripForbiddenKeys(event.provenance)),
        budget_delta: event.budget_delta,
        policy_checks: event.policy_checks,
        evidence_refs: event.evidence_refs,
      };
      if (request.export_policy?.include_hashes) exported.canonical_hash = event.canonical_hash;
      return exported;
    });
    return {
      status: 'redacted',
      tainted: trace.tainted,
      trace_ref: traceRef(trace),
      redacted_trace: {
        trace_ref: traceRef(trace),
        events,
        omitted_fields: ['raw inputs', 'raw outputs', 'hidden prompts', 'approval tokens', 'cookies', 'vault/session handles', 'deleted memory content'],
        truncation: { truncated: maxEvents < trace.events.length, emitted_events: maxEvents, total_events: trace.events.length },
        taint_summary: { tainted: trace.tainted, tainted_event_count: trace.events.filter((event) => event.tainted_in || event.tainted_out).length },
        provenance: { redaction_policy_id: REDACTION_POLICY_ID, audience: request.export_policy?.audience ?? 'internal' },
      },
      provenance: emptyProvenance(trace.trace_id, trace.task_id),
    };
  }

  inspectTrace(request: TraceEvalRequest): TraceEvalResponse {
    const trace = this.getTrace(request.trace_id);
    if (!trace) return defaultFailureResponse('not_found', 'trace_not_found', 'trace_id was not found');
    return {
      status: 'ok',
      tainted: trace.tainted,
      trace_ref: traceRef(trace),
      redacted_trace: {
        trace_ref: traceRef(trace),
        event_count: trace.events.length,
        event_refs: trace.events.map((event) => ({
          event_id: event.event_id,
          sequence: event.sequence,
          event_type: event.event_type,
          timestamp: event.timestamp,
          tainted_in: event.tainted_in,
          tainted_out: event.tainted_out,
          canonical_hash: event.canonical_hash,
        })),
        deleted_memory_content_rehydrated: false,
      },
      provenance: emptyProvenance(trace.trace_id, trace.task_id),
    };
  }

  getStoredEvent(trace_id: string, sequence: number): StoredTraceEvent | undefined {
    return this.traces.get(trace_id)?.events.find((event) => event.sequence === sequence);
  }

  private getTrace(trace_id?: string): TraceRecord | undefined {
    return trace_id ? this.traces.get(trace_id) : undefined;
  }

  private validateEvent(event: TraceEventInput): { ok: true } | { ok: false; code: string; message: string } {
    if (!ALLOWED_EVENT_TYPES.has(event.event_type)) return { ok: false, code: 'unknown_event_type', message: 'event_type is not in the trajectory event schema' };
    if (!event.actor || typeof event.actor !== 'string') return { ok: false, code: 'missing_actor', message: 'event.actor must be a non-empty string' };
    if (event.timestamp && Number.isNaN(Date.parse(event.timestamp))) return { ok: false, code: 'bad_timestamp', message: 'event.timestamp must be ISO-parseable' };
    if (containsForbiddenKey(event.inputs) || containsForbiddenKey(event.outputs) || containsForbiddenKey(event.provenance)) {
      return { ok: false, code: 'forbidden_sensitive_field', message: 'event contains a field that must never be persisted in traces' };
    }
    return { ok: true };
  }

  private scoreDimensions(rubric: Record<string, unknown> | undefined, score: number, failureModes: Set<string>): Record<string, number> {
    const dimensions = rubric && typeof rubric === 'object' ? Object.keys(rubric) : ['correctness', 'safety', 'evidence'];
    const result: Record<string, number> = {};
    for (const dimension of dimensions) {
      const safetyPenalty = dimension.toLowerCase().includes('safety') && failureModes.size > 0 ? 0.15 : 0;
      result[dimension] = Math.max(0, Math.min(1, score - safetyPenalty));
    }
    return result;
  }
}

function stripForbiddenKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripForbiddenKeys);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_STORAGE_KEYS.has(key.toLowerCase())) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = stripForbiddenKeys(child);
    }
  }
  return out;
}

function removeDeletedMemoryContent(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(removeDeletedMemoryContent);
  const obj = value as Record<string, unknown>;
  if (obj.deleted === true || obj.tombstone === true || obj.deletion_ref) {
    return {
      deleted: true,
      tombstone: obj.tombstone ?? true,
      deletion_ref: obj.deletion_ref ?? obj.memory_ref ?? '[redacted-deletion-ref]',
      content: '[DELETED_MEMORY_CONTENT_OMITTED]',
    };
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(obj)) out[key] = removeDeletedMemoryContent(child);
  return out;
}

export const defaultTraceRecorder = new TraceRecorder();

export function trace_eval(request: TraceEvalRequest): TraceEvalResponse {
  return defaultTraceRecorder.handle(request);
}

export default trace_eval;
