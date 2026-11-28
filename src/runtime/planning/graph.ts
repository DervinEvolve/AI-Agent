/**
 * cap_goal_planner_83 - Layer A: pure goal-graph core.
 *
 * No runtime imports. Every function is a pure transformation: it returns a new
 * frozen graph on success and the *same* graph reference on rejection, so a
 * rejected proposal, report or replan can never partially mutate state.
 *
 * This module does not call a model, run tools, or decide task completion.
 * 'reported_achieved' is a model report backed by eligible observations; it is
 * never a verification.
 */

import type {
  GoalDisposition,
  GoalEvidenceRef,
  GoalGraph,
  GoalNodeState,
  GoalProposalNode,
  GraphLimits,
  ObservationFacts,
  PlanningStatus,
  ProposalReject,
  ProposalRejectCode,
  ProposalResult,
  ReplanResult,
  ReplanTrigger,
  ReportContext,
  ReportDisposition,
  ReportRefusalReason,
  ReportResult,
  SchedulingMode,
  SelectResult,
} from './types';

export const GOAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const MAX_GOAL_TEXT_BYTES = 240;
export const MAX_REPORT_NOTE_BYTES = 512;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const encoder = new TextEncoder();

export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

function reject(code: ProposalRejectCode, detail: string): ProposalReject {
  return { ok: false, code, detail };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Envelope = { ok: true; obj: Record<string, unknown> } | ProposalReject;

function decodeEnvelope(raw: unknown, limits: GraphLimits, allowed: readonly string[]): Envelope {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (utf8Bytes(raw) > limits.maxProposalBytes) return reject('oversize_proposal', 'proposal exceeds maxProposalBytes');
    try {
      value = JSON.parse(raw);
    } catch {
      return reject('invalid_json', 'proposal is not valid JSON');
    }
  } else {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(raw);
    } catch {
      serialized = undefined;
    }
    if (typeof serialized !== 'string') return reject('invalid_shape', 'proposal is not serializable');
    if (utf8Bytes(serialized) > limits.maxProposalBytes) return reject('oversize_proposal', 'proposal exceeds maxProposalBytes');
  }
  if (!isPlainObject(value)) return reject('invalid_shape', 'proposal must be an object');
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return reject('unknown_field', 'unknown proposal field: ' + key);
  }
  return { ok: true, obj: value };
}

const NODE_KEYS: readonly string[] = ['id', 'objective', 'acceptance_hint', 'depends_on'];

function parseNodes(value: unknown, limits: GraphLimits): ProposalResult {
  if (!Array.isArray(value)) return reject('invalid_shape', 'nodes must be an array');
  if (value.length === 0) return reject('empty_graph', 'proposal has no nodes');
  if (value.length > limits.maxGoals) return reject('too_many_goals', 'proposal exceeds maxGoals');
  const nodes: GoalProposalNode[] = [];
  const ids = new Set<string>();
  for (const entry of value as unknown[]) {
    if (!isPlainObject(entry)) return reject('invalid_shape', 'node must be an object');
    for (const key of Object.keys(entry)) {
      if (!NODE_KEYS.includes(key)) return reject('unknown_field', 'unknown node field: ' + key);
    }
    const id = entry['id'];
    if (typeof id !== 'string' || !GOAL_ID_PATTERN.test(id)) return reject('invalid_id', 'node id must be bounded ASCII');
    if (ids.has(id)) return reject('duplicate_id', 'duplicate node id: ' + id);
    ids.add(id);
    const objective = entry['objective'];
    if (typeof objective !== 'string' || objective.length === 0) return reject('invalid_shape', 'objective must be a non-empty string: ' + id);
    if (utf8Bytes(objective) > MAX_GOAL_TEXT_BYTES) return reject('text_too_large', 'objective too large: ' + id);
    const hintRaw = entry['acceptance_hint'];
    const hint = hintRaw === undefined ? '' : hintRaw;
    if (typeof hint !== 'string') return reject('invalid_shape', 'acceptance_hint must be a string: ' + id);
    if (utf8Bytes(hint) > MAX_GOAL_TEXT_BYTES) return reject('text_too_large', 'acceptance_hint too large: ' + id);
    const depsRaw = entry['depends_on'];
    const depsValue: unknown = depsRaw === undefined ? [] : depsRaw;
    if (!Array.isArray(depsValue)) return reject('invalid_shape', 'depends_on must be an array: ' + id);
    const deps: string[] = [];
    for (const dep of depsValue as unknown[]) {
      if (typeof dep !== 'string') return reject('invalid_shape', 'depends_on entries must be strings: ' + id);
      if (deps.includes(dep)) return reject('invalid_shape', 'duplicate dependency on ' + dep + ' in ' + id);
      deps.push(dep);
    }
    nodes.push({ id, objective, acceptance_hint: hint, depends_on: deps });
  }
  let edges = 0;
  for (const node of nodes) {
    for (const dep of node.depends_on) {
      edges += 1;
      if (dep === node.id) return reject('self_edge', 'node depends on itself: ' + node.id);
      if (!ids.has(dep)) return reject('dangling_edge', node.id + ' depends on unknown or abandoned node ' + dep);
    }
  }
  if (edges > limits.maxEdges) return reject('too_many_edges', 'proposal exceeds maxEdges');
  // Kahn's algorithm: anything left unresolved is on a cycle.
  const remaining = new Map<string, Set<string>>();
  for (const node of nodes) remaining.set(node.id, new Set(node.depends_on));
  let progressed = true;
  while (remaining.size > 0 && progressed) {
    progressed = false;
    for (const [id, deps] of Array.from(remaining.entries())) {
      if (deps.size === 0) {
        remaining.delete(id);
        for (const other of remaining.values()) other.delete(id);
        progressed = true;
      }
    }
  }
  if (remaining.size > 0) return reject('cycle', 'dependency cycle among: ' + Array.from(remaining.keys()).join(','));
  return { ok: true, nodes };
}

/**
 * Validate a planner proposal (JSON string or already-parsed value) of the
 * shape {nodes:[{id, objective, acceptance_hint?, depends_on?}]}.
 * Structure only: any other field (for example a forged disposition) rejects.
 */
export function validateProposal(raw: unknown, limits: GraphLimits): ProposalResult {
  const env = decodeEnvelope(raw, limits, ['nodes']);
  if (!env.ok) return env;
  const parsed = parseNodes(env.obj['nodes'], limits);
  if (!parsed.ok) return parsed;
  return { ok: true, nodes: deepFreeze(parsed.nodes.slice()) };
}

/** Commit validated proposal nodes as revision 1. All nodes start pending. */
export function createGraph(nodes: readonly GoalProposalNode[], rootTaskDigest: string): GoalGraph {
  const states: GoalNodeState[] = nodes.map((node) => ({
    id: node.id,
    objective: node.objective,
    acceptance_hint: node.acceptance_hint,
    depends_on: node.depends_on.slice(),
    disposition: 'pending' as GoalDisposition,
    evidence_refs: [],
    created_revision: 1,
    initial: true,
    last_activation_index: null,
  }));
  return deepFreeze<GoalGraph>({
    root_task_digest: rootTaskDigest,
    revision: 1,
    nodes: states,
    active_goal: null,
    scheduling: 'scheduling',
    activation_counter: 0,
  });
}

function achievedIds(nodes: readonly GoalNodeState[]): Set<string> {
  const out = new Set<string>();
  for (const node of nodes) if (node.disposition === 'reported_achieved') out.add(node.id);
  return out;
}

function readyIndex(nodes: readonly GoalNodeState[]): number {
  const achieved = achievedIds(nodes);
  let best = -1;
  nodes.forEach((node, index) => {
    if (node.disposition !== 'pending' && node.disposition !== 'needs_recheck') return;
    if (!node.depends_on.every((dep) => achieved.has(dep))) return;
    if (best === -1) {
      best = index;
      return;
    }
    const current = nodes[best];
    // Proposal order is the primary key; ID is the documented secondary key.
    if (current !== undefined && index === best && node.id < current.id) best = index;
  });
  return best;
}

/**
 * Select the active goal. An already-active goal is never deselected. Otherwise
 * pick the first pending or needs_recheck node (proposal order, then ID) whose
 * prerequisites are all reported_achieved. Suspended scheduling selects nothing.
 */
export function selectReady(graph: GoalGraph): SelectResult {
  const current = graph.nodes.find((node) => node.disposition === 'active');
  if (current !== undefined) return { graph, active_goal: current.id };
  if (graph.scheduling !== 'scheduling') return { graph, active_goal: null };
  const index = readyIndex(graph.nodes);
  if (index === -1) {
    if (graph.active_goal === null) return { graph, active_goal: null };
    return { graph: deepFreeze({ ...graph, active_goal: null }), active_goal: null };
  }
  const counter = graph.activation_counter + 1;
  let chosen = '';
  const nodes = graph.nodes.map((node, i) => {
    if (i !== index) return node;
    chosen = node.id;
    return { ...node, disposition: 'active' as GoalDisposition, last_activation_index: counter };
  });
  const next = deepFreeze<GoalGraph>({ ...graph, nodes, active_goal: chosen, activation_counter: counter });
  return { graph: next, active_goal: chosen };
}

function eligible(facts: ObservationFacts | undefined, allowKnownFailure: boolean): facts is ObservationFacts {
  if (facts === undefined) return false;
  if (facts.kind !== 'tool') return false; // planning/control, synthesis and navigation-only records never support
  if (!facts.current_run || !facts.exposed || facts.restricted || facts.stale) return false;
  if (facts.outcome === 'success') return true;
  return allowKnownFailure && facts.outcome === 'known_failure';
}

const REPORT_KEYS: readonly string[] = ['goal_id', 'disposition', 'refs', 'note'];
const REPORT_DISPOSITIONS: readonly string[] = ['achieved', 'blocked', 'contradicted'];

/**
 * Apply a report_goal call. Refusals are started=false and return the same
 * graph reference. An accepted report never selects a new goal and never starts
 * a planner call; it only says whether a replan trigger now exists.
 */
export function applyReport(graph: GoalGraph, report: unknown, ctx: ReportContext): ReportResult {
  const refuse = (reason: ReportRefusalReason): ReportResult => ({ ok: false, started: false, reason, graph });
  if (!isPlainObject(report)) return refuse('invalid_report');
  for (const key of Object.keys(report)) if (!REPORT_KEYS.includes(key)) return refuse('invalid_report');
  const goalId = report['goal_id'];
  const dispositionRaw = report['disposition'];
  const refsRaw: unknown = report['refs'] === undefined ? [] : report['refs'];
  const noteRaw: unknown = report['note'] === undefined ? '' : report['note'];
  if (typeof goalId !== 'string' || typeof dispositionRaw !== 'string' || !REPORT_DISPOSITIONS.includes(dispositionRaw)) {
    return refuse('invalid_report');
  }
  const disposition = dispositionRaw as ReportDisposition;
  if (!Array.isArray(refsRaw) || typeof noteRaw !== 'string') return refuse('invalid_report');
  const refs: string[] = [];
  for (const ref of refsRaw as unknown[]) {
    if (typeof ref !== 'string' || ref.length === 0 || refs.includes(ref)) return refuse('invalid_report');
    refs.push(ref);
  }
  if (refs.length > ctx.maxRefsPerGoal) return refuse('invalid_report');
  if (utf8Bytes(noteRaw) > MAX_REPORT_NOTE_BYTES) return refuse('note_too_large');

  const target = graph.nodes.find((node) => node.id === goalId);
  if (target === undefined) return refuse('unknown_goal');
  if (target.disposition !== 'active' || graph.active_goal !== goalId) return refuse('goal_not_active');

  if (disposition !== 'blocked' && refs.length === 0) return refuse('missing_support');
  const allowFailure = disposition !== 'achieved';
  const evidence: GoalEvidenceRef[] = [];
  for (const ref of refs) {
    const facts = ctx.lookup(ref);
    if (!eligible(facts, allowFailure)) return refuse('ineligible_support');
    evidence.push({
      ref,
      original_goal: facts.bound_goal,
      original_revision: facts.bound_revision,
      reused: facts.bound_goal !== goalId,
      workspace_generation: typeof facts.workspace_generation === 'number' ? facts.workspace_generation : null,
      possibly_stale: false,
    });
  }

  const nextDisposition: GoalDisposition = disposition === 'achieved' ? 'reported_achieved' : 'blocked';
  const nodes = graph.nodes.map((node) => {
    if (node.id !== goalId) return node;
    const merged = node.evidence_refs.filter((old) => !refs.includes(old.ref)).concat(evidence);
    return { ...node, disposition: nextDisposition, evidence_refs: merged };
  });
  let trigger: ReplanTrigger = null;
  if (disposition === 'contradicted') trigger = 'contradicted';
  else if (disposition === 'blocked' && readyIndex(nodes) === -1) trigger = 'blocked_no_ready';
  const next = deepFreeze<GoalGraph>({ ...graph, nodes, active_goal: null });
  return {
    ok: true,
    started: true,
    graph: next,
    record: deepFreeze({
      goal_id: goalId,
      disposition,
      revision: graph.revision,
      refs,
      reuse: evidence
        .filter((item) => item.reused)
        .map((item) => ({ ref: item.ref, original_goal: item.original_goal, original_revision: item.original_revision })),
      replan_trigger: trigger,
    }),
  };
}

function parseIdList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string' || !GOAL_ID_PATTERN.test(entry) || out.includes(entry)) return null;
    out.push(entry);
  }
  return out;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

/**
 * Validate and atomically commit a replan of the shape
 * {nodes:[...replacement live graph...], reopen:[ids], abandon:[ids]}.
 *
 * - an existing ID may not carry a different objective (id_reuse)
 * - every live node must be kept or explicitly abandoned (silent_deletion)
 * - abandoned nodes stay in history and satisfy no dependency
 * - reopen, or a changed prerequisite set, marks achieved descendants needs_recheck
 * - evidence refs are never erased
 * On any rejection the previous graph reference is returned unchanged.
 */
export function applyReplan(graph: GoalGraph, raw: unknown, limits: GraphLimits): ReplanResult {
  const fail = (r: ProposalReject): ReplanResult => ({ ok: false, code: r.code, detail: r.detail, graph });
  const env = decodeEnvelope(raw, limits, ['nodes', 'reopen', 'abandon']);
  if (!env.ok) return fail(env);
  const parsed = parseNodes(env.obj['nodes'], limits);
  if (!parsed.ok) return fail(parsed);
  const reopen = parseIdList(env.obj['reopen']);
  const abandon = parseIdList(env.obj['abandon']);
  if (reopen === null || abandon === null) return fail(reject('invalid_operation', 'reopen and abandon must be arrays of unique ids'));

  const prev = new Map<string, GoalNodeState>();
  for (const node of graph.nodes) prev.set(node.id, node);
  const proposedIds = new Set<string>(parsed.nodes.map((node) => node.id));

  for (const id of abandon) {
    const old = prev.get(id);
    if (old === undefined || old.disposition === 'abandoned') return fail(reject('unknown_operation_target', 'cannot abandon ' + id));
    if (proposedIds.has(id)) return fail(reject('invalid_operation', id + ' is both kept and abandoned'));
  }
  let created = 0;
  for (const node of parsed.nodes) {
    const old = prev.get(node.id);
    if (old === undefined) {
      created += 1;
      continue;
    }
    if (old.disposition === 'abandoned') return fail(reject('id_reuse', 'abandoned id cannot be reused: ' + node.id));
    if (old.objective !== node.objective) return fail(reject('id_reuse', 'existing id with a different objective: ' + node.id));
  }
  for (const old of graph.nodes) {
    if (old.disposition === 'abandoned') continue;
    if (!proposedIds.has(old.id) && !abandon.includes(old.id)) {
      return fail(reject('silent_deletion', 'node dropped without abandon: ' + old.id));
    }
  }
  for (const id of reopen) {
    const old = prev.get(id);
    if (old === undefined || !proposedIds.has(id)) return fail(reject('unknown_operation_target', 'cannot reopen ' + id));
    if (old.disposition !== 'reported_achieved' && old.disposition !== 'blocked' && old.disposition !== 'needs_recheck') {
      return fail(reject('invalid_operation', 'only achieved, blocked or needs_recheck nodes can be reopened: ' + id));
    }
  }
  if (prev.size + created > limits.maxGoals) return fail(reject('too_many_goals', 'maxGoals bounds every id ever created'));

  const revision = graph.revision + 1;
  const live: Mutable<GoalNodeState>[] = [];
  const seeds: string[] = [];
  for (const node of parsed.nodes) {
    const old = prev.get(node.id);
    if (old === undefined) {
      live.push({
        id: node.id,
        objective: node.objective,
        acceptance_hint: node.acceptance_hint,
        depends_on: node.depends_on.slice(),
        disposition: 'pending',
        evidence_refs: [],
        created_revision: revision,
        initial: false,
        last_activation_index: null,
      });
      continue;
    }
    const next: Mutable<GoalNodeState> = { ...old, acceptance_hint: node.acceptance_hint, depends_on: node.depends_on.slice() };
    if (reopen.includes(node.id)) {
      next.disposition = 'pending';
      seeds.push(node.id);
    } else if (!sameSet(old.depends_on, node.depends_on)) {
      if (next.disposition === 'reported_achieved') next.disposition = 'needs_recheck';
      seeds.push(node.id);
    }
    live.push(next);
  }
  // Achieved transitive dependents of a reopened or re-wired node need a recheck.
  const affected = new Set<string>(seeds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of live) {
      if (affected.has(node.id)) continue;
      if (node.depends_on.some((dep) => affected.has(dep))) {
        affected.add(node.id);
        grew = true;
      }
    }
  }
  for (const node of live) {
    if (affected.has(node.id) && !seeds.includes(node.id) && node.disposition === 'reported_achieved') {
      node.disposition = 'needs_recheck';
    }
  }
  const achieved = achievedIds(live);
  let active: string | null = null;
  for (const node of live) {
    if (node.disposition !== 'active') continue;
    if (node.depends_on.every((dep) => achieved.has(dep))) active = node.id;
    else node.disposition = 'pending';
  }
  const history: GoalNodeState[] = [];
  for (const old of graph.nodes) {
    if (old.disposition === 'abandoned') history.push(old);
    else if (abandon.includes(old.id)) history.push({ ...old, disposition: 'abandoned' });
  }
  const next = deepFreeze<GoalGraph>({
    root_task_digest: graph.root_task_digest,
    revision,
    nodes: [...live, ...history],
    active_goal: active,
    scheduling: 'scheduling',
    activation_counter: graph.activation_counter,
  });
  return { ok: true, graph: next, abandoned: abandon, reopened: reopen };
}

/**
 * Mark workspace-backed progress refs older than currentGeneration as
 * possibly_stale. Changes no disposition, unsatisfies no dependency and does
 * not deselect the active goal. Returns the same reference when nothing changes.
 */
export function markPossiblyStale(graph: GoalGraph, currentGeneration: number): GoalGraph {
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    let nodeChanged = false;
    const refs = node.evidence_refs.map((ref) => {
      if (ref.possibly_stale || ref.workspace_generation === null || ref.workspace_generation >= currentGeneration) return ref;
      nodeChanged = true;
      return { ...ref, possibly_stale: true };
    });
    if (!nodeChanged) return node;
    changed = true;
    return { ...node, evidence_refs: refs };
  });
  return changed ? deepFreeze<GoalGraph>({ ...graph, nodes }) : graph;
}

/**
 * Suspend scheduling (planning_exhausted / planning_stalled). Only applies when
 * no goal is active; otherwise the graph is returned unchanged. The graph is
 * retained as advisory state. This grants no permission of any kind.
 */
export function suspendScheduling(graph: GoalGraph, reason: Exclude<SchedulingMode, 'scheduling'>): GoalGraph {
  if (graph.nodes.some((node) => node.disposition === 'active')) return graph;
  if (graph.scheduling === reason && graph.active_goal === null) return graph;
  return deepFreeze<GoalGraph>({ ...graph, scheduling: reason, active_goal: null });
}

/**
 * Host-visible terminal metadata. Lists every abandoned and unresolved ID.
 * This is not evidence and not a completion predicate.
 */
export function buildPlanningStatus(graph: GoalGraph): PlanningStatus {
  const counts: Record<GoalDisposition, number> = {
    pending: 0,
    active: 0,
    reported_achieved: 0,
    blocked: 0,
    abandoned: 0,
    needs_recheck: 0,
  };
  const abandoned: { id: string; initial: boolean }[] = [];
  const unresolved: { id: string; disposition: GoalDisposition }[] = [];
  for (const node of graph.nodes) {
    counts[node.disposition] += 1;
    if (node.disposition === 'abandoned') abandoned.push({ id: node.id, initial: node.initial });
    else if (node.disposition !== 'reported_achieved') unresolved.push({ id: node.id, disposition: node.disposition });
  }
  return deepFreeze<PlanningStatus>({
    revision: graph.revision,
    scheduling_mode: graph.scheduling,
    reported_achieved_count: counts.reported_achieved,
    abandoned,
    unresolved,
    counts,
    total: graph.nodes.length,
  });
}
