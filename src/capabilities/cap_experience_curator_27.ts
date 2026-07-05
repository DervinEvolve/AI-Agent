export type ExperienceCuratorStatus =
  | 'ok'
  | 'policy_blocked'
  | 'budget_exhausted'
  | 'not_found'
  | 'unverifiable'
  | 'promotion_rejected'
  | 'limit_exceeded';

export type PromotionTarget = 'context_exemplar' | 'procedural_skill' | 'skill_update';

export interface ExperienceScope {
  user_id: string;
  project_id: string;
  namespace: string;
}

export interface ExperienceTraceRef {
  id?: string;
  event_ref?: string;
  event_refs?: string[];
  memory_refs?: string[];
  scope?: Partial<ExperienceScope>;
  deleted?: boolean;
  tainted?: boolean;
  source_taints?: boolean[];
  kind?: string;
  goal?: string;
  domain?: string;
  content?: string;
  summary?: string;
  actions?: string[];
  outcome?: 'success' | 'failure' | 'partial';
  success?: boolean;
  failure_modes?: string[];
  corrections?: string[];
  tags?: string[];
  criteria_event_refs?: string[];
  uncertainty?: { calibrated?: boolean; confidence?: number; notes?: string };
  [key: string]: unknown;
}

export interface HeldoutPolicy {
  min_success_rate?: number;
  max_validation_holdout_gap?: number;
  canary_count?: number;
  require_baseline_delta?: boolean;
}

export interface ExperienceQuery {
  goal: string;
  domain?: string;
  failure_modes?: string[];
  required_tags?: string[];
}

export interface CuratorInput {
  action:
    | 'curate_from_trace'
    | 'retrieve_experiences'
    | 'propose_skill_candidate'
    | 'verify_promotion'
    | 'inspect_buffer'
    | 'delete_experience';
  scope: ExperienceScope;
  task_id?: string;
  trace_refs?: ExperienceTraceRef[];
  success_criteria_refs?: Array<{ event_ref?: string; id?: string; deleted?: boolean }>;
  query?: ExperienceQuery;
  candidate_ref?: string;
  promotion_target?: PromotionTarget;
  heldout_policy?: HeldoutPolicy;
  candidate?: Partial<SkillCandidate> & { text?: string };
}

export interface ExperienceProvenance {
  scope: ExperienceScope;
  task_id?: string;
  source_trace_refs: string[];
  created_at: string;
  evaluator_version: string;
  memory_refs: string[];
  event_refs: string[];
}

export interface ExperienceRecord {
  id: string;
  scope: ExperienceScope;
  task_id?: string;
  tainted: boolean;
  outcome: 'success' | 'failure' | 'partial';
  task_signature: string;
  preconditions: string[];
  abstracted_actions: string[];
  evidence_refs: string[];
  failure_modes: string[];
  corrections: string[];
  uncertainty_profile: string;
  reusable_lesson: string;
  anti_patterns: string[];
  candidate_skill_hooks: string[];
  tags: string[];
  domain?: string;
  freshness: string;
  deleted: boolean;
  provenance: ExperienceProvenance;
}

export interface RetrievedExperience {
  id: string;
  advisory_only: true;
  cannot_be_used_as: string[];
  inclusion_reason: string;
  tainted: boolean;
  freshness: string;
  outcome: ExperienceRecord['outcome'];
  task_signature: string;
  reusable_lesson: string;
  anti_patterns: string[];
  failure_modes: string[];
  provenance: ExperienceProvenance;
}

export interface SkillCandidate {
  id: string;
  scope: ExperienceScope;
  task_id?: string;
  promotion_target: PromotionTarget;
  from_experience_ids: string[];
  text: string;
  validation_score: number;
  baseline_score: number;
  holdout_score_override?: number;
  requires_trace_ids?: boolean;
  validation_only?: boolean;
  canary_fail?: boolean;
  created_at: string;
  provenance: ExperienceProvenance;
}

export interface VerificationReport {
  validation_score: number;
  holdout_score: number;
  validation_holdout_gap: number;
  baseline_delta: number;
  reward_hacking_signals: string[];
  sealed_harness_ref: string;
  passed: boolean;
}

export interface CuratorOutput {
  status: ExperienceCuratorStatus;
  tainted: boolean;
  experience_ids?: string[];
  candidate_id?: string;
  retrieved_experiences?: RetrievedExperience[];
  verification_report?: VerificationReport;
  provenance: ExperienceProvenance;
  buffer?: { active_count: number; tombstoned_count: number; scope_key: string };
}

export const DEFAULT_EXPERIENCE_CURATOR_LIMITS = Object.freeze({
  max_experiences_per_scope: 1000,
  max_experience_chars: 6000,
  max_retrieved_experiences_per_context: 5,
  max_skill_candidates_per_task: 3,
  promotion_requires_heldout_pass: true,
  default_min_holdout_success_rate: 0.8,
  default_max_validation_holdout_gap: 0.2,
  sealed_harness_network: 'deny_by_default',
  experience_retention: 'scope_policy_limited_and_deletion_aware',
});

export const CAP_EXPERIENCE_CURATOR_27 = Object.freeze({
  id: 'cap_experience_curator_27',
  name: 'Closed-loop experience curation and held-out skill improvement',
  status: 'active',
  added_epoch: 27,
  limits: DEFAULT_EXPERIENCE_CURATOR_LIMITS,
  interface: { tool_name: 'experience_curator' },
});

const REDACTION = '[REDACTED]';
const FORBIDDEN_RETRIEVAL_USES = Object.freeze([
  'instructions',
  'authorization',
  'validated_evidence',
  'direct_tool_arguments',
  'urls',
  'api_identifiers',
  'grant_ids',
  'sub_agent_goals',
  'hitl_assertions',
  'completion_evidence',
]);

function scopeKey(scope: ExperienceScope): string {
  return `${scope.user_id}\u0000${scope.project_id}\u0000${scope.namespace}`;
}

function scopesEqual(a: Partial<ExperienceScope> | undefined, b: ExperienceScope): boolean {
  if (!a) return true;
  return a.user_id === b.user_id && a.project_id === b.project_id && a.namespace === b.namespace;
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function tokenize(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/u).filter((part) => part.length > 2));
}

export function redactExperienceText(input: unknown, maxChars = DEFAULT_EXPERIENCE_CURATOR_LIMITS.max_experience_chars): string {
  let text = String(input ?? '');
  text = text.replace(/<\/?(?:chain[-_ ]?of[-_ ]?thought|cot|hidden[-_ ]?instructions?)[^>]*>/giu, REDACTION);
  text = text.replace(/(?:chain[-_ ]?of[-_ ]?thought|hidden[-_ ]?instructions?|raw[-_ ]?prompt)\s*[:=]\s*[^\n;]+/giu, `$1: ${REDACTION}`);
  text = text.replace(/\b(?:approval[_-]?token|api[_-]?key|secret|password|cookie|session|vault[_-]?handle)\b\s*[:=]\s*[^\s,;]+/giu, `$1=${REDACTION}`);
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gu, `Bearer ${REDACTION}`);
  text = text.replace(/\bsk-[A-Za-z0-9]{12,}\b/gu, REDACTION);
  text = text.replace(/\bvault:\/\/[^\s,;]+/giu, `vault://${REDACTION}`);
  text = text.replace(/https?:\/\/[^\s)\]}>'"]+/giu, REDACTION);
  if (text.length > maxChars) {
    return `${text.slice(0, Math.max(0, maxChars - 32))}\n[COMPACTED_WITH_PROVENANCE_PRESERVED]`;
  }
  return text;
}

function safeList(values: unknown, maxChars: number): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => redactExperienceText(value, maxChars)).filter(Boolean);
}

function eventRefsFrom(trace: ExperienceTraceRef): string[] {
  return unique([
    trace.event_ref ?? '',
    ...(Array.isArray(trace.event_refs) ? trace.event_refs : []),
    ...(Array.isArray(trace.criteria_event_refs) ? trace.criteria_event_refs : []),
  ]);
}

function traceRefId(trace: ExperienceTraceRef, index: number): string {
  return String(trace.id ?? trace.event_ref ?? `trace-${index}`);
}

function provenance(
  scope: ExperienceScope,
  task_id: string | undefined,
  source_trace_refs: string[],
  created_at: string,
  evaluator_version: string,
  memory_refs: string[],
  event_refs: string[],
): ExperienceProvenance {
  return { scope, task_id, source_trace_refs, created_at, evaluator_version, memory_refs, event_refs };
}

export class InMemoryExperienceBuffer {
  private readonly records = new Map<string, ExperienceRecord>();
  private readonly orderByScope = new Map<string, string[]>();

  constructor(private readonly limits: typeof DEFAULT_EXPERIENCE_CURATOR_LIMITS = DEFAULT_EXPERIENCE_CURATOR_LIMITS) {}

  put(record: ExperienceRecord): void {
    const compacted = this.compactRecord(record);
    this.records.set(compacted.id, compacted);
    const key = scopeKey(compacted.scope);
    const existing = this.orderByScope.get(key) ?? [];
    const next = existing.includes(compacted.id) ? existing : [...existing, compacted.id];
    this.orderByScope.set(key, next);
    this.enforceRetention(compacted.scope);
  }

  get(id: string): ExperienceRecord | undefined {
    return this.records.get(id);
  }

  delete(scope: ExperienceScope, id: string): boolean {
    const record = this.records.get(id);
    if (!record || !scopesEqual(record.scope, scope)) return false;
    record.deleted = true;
    return true;
  }

  inspect(scope: ExperienceScope): { active_count: number; tombstoned_count: number; scope_key: string } {
    const ids = this.orderByScope.get(scopeKey(scope)) ?? [];
    let active_count = 0;
    let tombstoned_count = 0;
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record) continue;
      if (record.deleted) tombstoned_count += 1;
      else active_count += 1;
    }
    return { active_count, tombstoned_count, scope_key: scopeKey(scope) };
  }

  list(scope: ExperienceScope): ExperienceRecord[] {
    return (this.orderByScope.get(scopeKey(scope)) ?? [])
      .map((id) => this.records.get(id))
      .filter((record): record is ExperienceRecord => Boolean(record) && !record.deleted);
  }

  retrieve(scope: ExperienceScope, query: ExperienceQuery, max = this.limits.max_retrieved_experiences_per_context): RetrievedExperience[] {
    const queryTokens = tokenize(`${query.goal} ${query.domain ?? ''} ${(query.failure_modes ?? []).join(' ')}`);
    const requiredTags = new Set(query.required_tags ?? []);
    const failureModes = new Set(query.failure_modes ?? []);
    const scored = this.list(scope)
      .filter((record) => {
        if (query.domain && record.domain && record.domain !== query.domain) return false;
        if ([...requiredTags].some((tag) => !record.tags.includes(tag))) return false;
        return true;
      })
      .map((record) => {
        const haystack = tokenize(`${record.task_signature} ${record.reusable_lesson} ${record.failure_modes.join(' ')} ${record.tags.join(' ')}`);
        let score = 0;
        for (const token of queryTokens) if (haystack.has(token)) score += 1;
        for (const mode of failureModes) if (record.failure_modes.includes(mode)) score += 2;
        if (record.outcome === 'success') score += 1;
        return { record, score };
      })
      .filter(({ score }) => score > 0 || queryTokens.size === 0)
      .sort((a, b) => b.score - a.score || b.record.provenance.created_at.localeCompare(a.record.provenance.created_at));

    return scored.slice(0, max).map(({ record, score }) => ({
      id: record.id,
      advisory_only: true,
      cannot_be_used_as: [...FORBIDDEN_RETRIEVAL_USES],
      inclusion_reason: score > 0 ? `matched ${score} query signals` : 'bounded scoped exemplar',
      tainted: record.tainted,
      freshness: record.freshness,
      outcome: record.outcome,
      task_signature: record.task_signature,
      reusable_lesson: record.reusable_lesson,
      anti_patterns: record.anti_patterns,
      failure_modes: record.failure_modes,
      provenance: record.provenance,
    }));
  }

  private compactRecord(record: ExperienceRecord): ExperienceRecord {
    const max = this.limits.max_experience_chars;
    return {
      ...record,
      task_signature: redactExperienceText(record.task_signature, max),
      preconditions: record.preconditions.map((value) => redactExperienceText(value, max)),
      abstracted_actions: record.abstracted_actions.map((value) => redactExperienceText(value, max)),
      failure_modes: record.failure_modes.map((value) => redactExperienceText(value, max)),
      corrections: record.corrections.map((value) => redactExperienceText(value, max)),
      uncertainty_profile: redactExperienceText(record.uncertainty_profile, max),
      reusable_lesson: redactExperienceText(record.reusable_lesson, max),
      anti_patterns: record.anti_patterns.map((value) => redactExperienceText(value, max)),
      candidate_skill_hooks: record.candidate_skill_hooks.map((value) => redactExperienceText(value, max)),
    };
  }

  private enforceRetention(scope: ExperienceScope): void {
    const key = scopeKey(scope);
    const ids = this.orderByScope.get(key) ?? [];
    const active = ids.filter((id) => !this.records.get(id)?.deleted);
    while (active.length > this.limits.max_experiences_per_scope) {
      const oldest = active.shift();
      if (!oldest) break;
      const record = this.records.get(oldest);
      if (record) record.deleted = true;
    }
  }
}

export function detectRewardHackingSignals(candidate: Pick<SkillCandidate, 'text'> & Partial<SkillCandidate>): string[] {
  const text = `${candidate.text ?? ''} ${candidate.id ?? ''}`.toLowerCase();
  const signals: string[] = [];
  const addIf = (condition: boolean, signal: string) => {
    if (condition) signals.push(signal);
  };
  addIf(/answer\s*key|fixture\s*answers?|golden\s*answers?/u.test(text), 'answer_key_or_fixture_answer_access');
  addIf(/hidden\s*tests?|inspect\s+tests?|test\s+fixture|sealed\s+seed/u.test(text), 'hidden_test_or_seed_inspection');
  addIf(/trace[_ -]?ids?|source\s+trace\s+id/u.test(text) || candidate.requires_trace_ids === true, 'depends_on_trace_ids');
  addIf(/memor(?:y|ize).*validation|exact\s+validation|validation\s+input/u.test(text) || candidate.validation_only === true, 'memorizes_validation_inputs');
  addIf(/\b(fetch|curl|wget|http|network|browser)\b/u.test(text), 'network_or_browser_retrieval_dependency');
  addIf(/evaluator\s+wording|rubric\s+loophole|reward\s+hacking|environment\s+loophole/u.test(text), 'evaluator_or_environment_loophole');
  addIf(candidate.canary_fail === true, 'canary_failure');
  return unique(signals);
}

export class FakeSealedHeldoutVerifier {
  verify(candidate: SkillCandidate, policy: Required<HeldoutPolicy>): VerificationReport {
    const reward_hacking_signals = detectRewardHackingSignals(candidate);
    const validation_score = clamp01(candidate.validation_score);
    let holdout_score = candidate.holdout_score_override ?? Math.max(0, validation_score - 0.05);
    if (candidate.validation_only) holdout_score = Math.min(holdout_score, 0.4);
    if (candidate.canary_fail || reward_hacking_signals.length > 0) holdout_score = Math.min(holdout_score, 0.3);
    if (policy.canary_count > 0 && candidate.canary_fail) holdout_score = Math.min(holdout_score, 0.2);
    holdout_score = clamp01(holdout_score);
    const validation_holdout_gap = Math.max(0, validation_score - holdout_score);
    const baseline_delta = holdout_score - clamp01(candidate.baseline_score);
    const passed =
      holdout_score >= policy.min_success_rate &&
      validation_holdout_gap <= policy.max_validation_holdout_gap &&
      reward_hacking_signals.length === 0 &&
      (!policy.require_baseline_delta || baseline_delta > 0);
    return {
      validation_score,
      holdout_score,
      validation_holdout_gap,
      baseline_delta,
      reward_hacking_signals,
      sealed_harness_ref: `sealed:fake-deny-network:${stableHash(candidate.id)}`,
      passed,
    };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export class ExperienceCurator {
  private readonly candidates = new Map<string, SkillCandidate>();
  private readonly candidateCounts = new Map<string, number>();

  constructor(
    private readonly buffer = new InMemoryExperienceBuffer(),
    private readonly verifier = new FakeSealedHeldoutVerifier(),
    private readonly options: { now?: () => Date; evaluator_version?: string; limits?: typeof DEFAULT_EXPERIENCE_CURATOR_LIMITS } = {},
  ) {}

  handle(input: CuratorInput): CuratorOutput {
    switch (input.action) {
      case 'curate_from_trace':
        return this.curateFromTrace(input);
      case 'retrieve_experiences':
        return this.retrieveExperiences(input);
      case 'propose_skill_candidate':
        return this.proposeSkillCandidate(input);
      case 'verify_promotion':
        return this.verifyPromotion(input);
      case 'inspect_buffer':
        return this.inspectBuffer(input);
      case 'delete_experience':
        return this.deleteExperience(input);
      default:
        return this.output(input.scope, input.task_id, 'policy_blocked', false, [], []);
    }
  }

  curateFromTrace(input: CuratorInput): CuratorOutput {
    const traces = input.trace_refs ?? [];
    const sourceIds = traces.map(traceRefId);
    if (traces.length === 0) return this.output(input.scope, input.task_id, 'not_found', false, sourceIds, []);
    if (traces.some((trace) => !scopesEqual(trace.scope, input.scope))) {
      return this.output(input.scope, input.task_id, 'policy_blocked', traces.some((trace) => trace.tainted), sourceIds, []);
    }

    const activeTraces = traces.filter((trace) => !trace.deleted);
    if (activeTraces.length === 0) return this.output(input.scope, input.task_id, 'not_found', traces.some((trace) => trace.tainted), sourceIds, []);

    const created_at = this.now();
    const experience_ids: string[] = [];
    for (let index = 0; index < activeTraces.length; index += 1) {
      const trace = activeTraces[index];
      const idSource = `${input.task_id ?? ''}:${traceRefId(trace, index)}:${created_at}`;
      const event_refs = unique([...eventRefsFrom(trace), ...(input.success_criteria_refs ?? []).filter((ref) => !ref.deleted).map((ref) => ref.event_ref ?? ref.id ?? '')]);
      const memory_refs = Array.isArray(trace.memory_refs) ? trace.memory_refs : [];
      const success = trace.success === true || trace.outcome === 'success';
      const failure = trace.success === false || trace.outcome === 'failure';
      const outcome: ExperienceRecord['outcome'] = success ? 'success' : failure ? 'failure' : 'partial';
      const tainted = trace.tainted === true || (trace.source_taints ?? []).some(Boolean);
      const task_signature = redactExperienceText(trace.goal ?? trace.summary ?? trace.content ?? input.task_id ?? 'unspecified task', this.limits().max_experience_chars);
      const failure_modes = safeList(trace.failure_modes, this.limits().max_experience_chars);
      const corrections = safeList(trace.corrections, this.limits().max_experience_chars);
      const anti_patterns = outcome === 'success' ? [] : failure_modes.length > 0 ? failure_modes : ['failed_or_incomplete_trajectory'];
      const reusable_lesson = outcome === 'success'
        ? `When the task matches: ${task_signature}, reuse the abstract approach and verify with concrete event refs.`
        : `Avoid repeating this failed pattern; apply corrections before retrying: ${corrections.join('; ') || 'collect stronger evidence and re-check criteria'}.`;
      const record: ExperienceRecord = {
        id: `exp_${stableHash(idSource)}`,
        scope: input.scope,
        task_id: input.task_id,
        tainted,
        outcome,
        task_signature,
        preconditions: safeList(trace.preconditions, this.limits().max_experience_chars),
        abstracted_actions: safeList(trace.actions, this.limits().max_experience_chars),
        evidence_refs: event_refs,
        failure_modes,
        corrections,
        uncertainty_profile: redactExperienceText(trace.uncertainty ? JSON.stringify(trace.uncertainty) : 'not recorded', this.limits().max_experience_chars),
        reusable_lesson: redactExperienceText(reusable_lesson, this.limits().max_experience_chars),
        anti_patterns,
        candidate_skill_hooks: outcome === 'success' ? [`candidate_from_${input.task_id ?? 'task'}`] : [],
        tags: unique([...(trace.tags ?? []), outcome, trace.kind ?? 'trace']),
        domain: trace.domain,
        freshness: created_at,
        deleted: false,
        provenance: provenance(input.scope, input.task_id, [traceRefId(trace, index)], created_at, this.evaluatorVersion(), memory_refs, event_refs),
      };
      this.buffer.put(record);
      experience_ids.push(record.id);
    }
    const tainted = activeTraces.some((trace) => trace.tainted === true || (trace.source_taints ?? []).some(Boolean));
    return this.output(input.scope, input.task_id, 'ok', tainted, sourceIds, unique(experience_ids));
  }

  retrieveExperiences(input: CuratorInput): CuratorOutput {
    if (!input.query) return this.output(input.scope, input.task_id, 'not_found', false, [], []);
    const retrieved_experiences = this.buffer.retrieve(input.scope, input.query, this.limits().max_retrieved_experiences_per_context);
    return {
      ...this.output(input.scope, input.task_id, 'ok', retrieved_experiences.some((record) => record.tainted), [], []),
      retrieved_experiences,
    };
  }

  proposeSkillCandidate(input: CuratorInput): CuratorOutput {
    const taskExperiences = this.buffer.list(input.scope).filter((record) => !input.task_id || record.task_id === input.task_id);
    const successful = taskExperiences.filter((record) => record.outcome === 'success');
    if (successful.length === 0) return this.output(input.scope, input.task_id, 'unverifiable', taskExperiences.some((record) => record.tainted), [], []);
    if (successful.every((record) => record.evidence_refs.length === 0)) {
      return this.output(input.scope, input.task_id, 'unverifiable', successful.some((record) => record.tainted), [], []);
    }
    const key = `${scopeKey(input.scope)}:${input.task_id ?? '*'}`;
    const count = this.candidateCounts.get(key) ?? 0;
    if (count >= this.limits().max_skill_candidates_per_task) {
      return this.output(input.scope, input.task_id, 'limit_exceeded', successful.some((record) => record.tainted), [], successful.map((record) => record.id));
    }
    this.candidateCounts.set(key, count + 1);
    const created_at = this.now();
    const from_experience_ids = successful.slice(0, 3).map((record) => record.id);
    const candidateText = redactExperienceText(
      input.candidate?.text ?? successful.map((record) => record.reusable_lesson).join('\n'),
      this.limits().max_experience_chars,
    );
    const validation_score = clamp01(Number(input.candidate?.validation_score ?? 1));
    const baseline_score = clamp01(Number(input.candidate?.baseline_score ?? 0.2));
    const candidate: SkillCandidate = {
      id: `cand_${stableHash(`${key}:${count}:${candidateText}`)}`,
      scope: input.scope,
      task_id: input.task_id,
      promotion_target: input.promotion_target ?? 'procedural_skill',
      from_experience_ids,
      text: candidateText,
      validation_score,
      baseline_score,
      holdout_score_override: input.candidate?.holdout_score_override,
      requires_trace_ids: input.candidate?.requires_trace_ids,
      validation_only: input.candidate?.validation_only,
      canary_fail: input.candidate?.canary_fail,
      created_at,
      provenance: provenance(
        input.scope,
        input.task_id,
        successful.flatMap((record) => record.provenance.source_trace_refs),
        created_at,
        this.evaluatorVersion(),
        unique(successful.flatMap((record) => record.provenance.memory_refs)),
        unique(successful.flatMap((record) => record.provenance.event_refs)),
      ),
    };
    this.candidates.set(candidate.id, candidate);
    return {
      ...this.output(input.scope, input.task_id, 'ok', successful.some((record) => record.tainted), candidate.provenance.source_trace_refs, from_experience_ids),
      candidate_id: candidate.id,
    };
  }

  verifyPromotion(input: CuratorInput): CuratorOutput {
    const candidate = input.candidate_ref ? this.candidates.get(input.candidate_ref) : undefined;
    if (!candidate || !scopesEqual(candidate.scope, input.scope)) {
      return this.output(input.scope, input.task_id, 'not_found', false, [], []);
    }
    const policy = this.requiredPolicy(input.heldout_policy);
    const verification_report = this.verifier.verify(candidate, policy);
    return {
      ...this.output(
        input.scope,
        input.task_id ?? candidate.task_id,
        verification_report.passed ? 'ok' : 'promotion_rejected',
        false,
        candidate.provenance.source_trace_refs,
        candidate.from_experience_ids,
      ),
      candidate_id: candidate.id,
      verification_report,
    };
  }

  inspectBuffer(input: CuratorInput): CuratorOutput {
    return { ...this.output(input.scope, input.task_id, 'ok', false, [], []), buffer: this.buffer.inspect(input.scope) };
  }

  deleteExperience(input: CuratorInput): CuratorOutput {
    if (!input.candidate_ref) return this.output(input.scope, input.task_id, 'not_found', false, [], []);
    const deleted = this.buffer.delete(input.scope, input.candidate_ref);
    return this.output(input.scope, input.task_id, deleted ? 'ok' : 'not_found', false, [], deleted ? [input.candidate_ref] : []);
  }

  private output(
    scope: ExperienceScope,
    task_id: string | undefined,
    status: ExperienceCuratorStatus,
    tainted: boolean,
    source_trace_refs: string[],
    experience_ids: string[],
  ): CuratorOutput {
    return {
      status,
      tainted,
      experience_ids: experience_ids.length > 0 ? experience_ids : undefined,
      provenance: provenance(scope, task_id, source_trace_refs, this.now(), this.evaluatorVersion(), [], []),
    };
  }

  private requiredPolicy(policy: HeldoutPolicy | undefined): Required<HeldoutPolicy> {
    return {
      min_success_rate: policy?.min_success_rate ?? this.limits().default_min_holdout_success_rate,
      max_validation_holdout_gap: policy?.max_validation_holdout_gap ?? this.limits().default_max_validation_holdout_gap,
      canary_count: policy?.canary_count ?? 1,
      require_baseline_delta: policy?.require_baseline_delta ?? true,
    };
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private evaluatorVersion(): string {
    return this.options.evaluator_version ?? 'experience-curator-v1';
  }

  private limits(): typeof DEFAULT_EXPERIENCE_CURATOR_LIMITS {
    return this.options.limits ?? DEFAULT_EXPERIENCE_CURATOR_LIMITS;
  }
}

export function createExperienceCurator(options: { now?: () => Date; evaluator_version?: string } = {}): ExperienceCurator {
  return new ExperienceCurator(new InMemoryExperienceBuffer(), new FakeSealedHeldoutVerifier(), options);
}

export function experience_curator(input: CuratorInput, curator = createExperienceCurator()): CuratorOutput {
  return curator.handle(input);
}
