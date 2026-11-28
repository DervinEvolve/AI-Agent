/** Structure-only planning primitives. These do not authorize actions or certify success. */
export interface GoalNode {
  readonly id: string;
  readonly objective: string;
  readonly acceptance_hint: string;
  readonly depends_on: readonly string[];
}
export type GoalDisposition = 'pending' | 'active' | 'reported_achieved' | 'blocked' | 'abandoned' | 'needs_recheck';
export interface GoalProgress {
  readonly disposition: GoalDisposition;
  readonly refs: readonly string[];
  readonly lastActivationIndex: number | null;
}
export interface GoalGraph {
  readonly rootTaskDigest: string;
  readonly revision: number;
  /** Includes abandoned nodes: IDs are never recycled. */
  readonly nodes: readonly GoalNode[];
  readonly progress: Readonly<Record<string, GoalProgress>>;
}
export interface GoalPlannerConfig {
  readonly enabled?: boolean;
  readonly maxGoals?: number;
  readonly maxEdges?: number;
  readonly maxProposalBytes?: number;
}
export const planningReasonCodes = ['invalid_proposal', 'proposal_too_large', 'goal_limit', 'edge_limit', 'duplicate_id', 'dangling_edge', 'cycle', 'id_reuse', 'silent_deletion', 'invalid_operation'] as const;
export type PlanningReasonCode = typeof planningReasonCodes[number];
export interface PlanningRecord {
  readonly kind: 'planning_committed' | 'planning_rejected';
  readonly revision: number;
  readonly reason?: PlanningReasonCode;
}
export type PlanningResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: PlanningReasonCode };
const fail = (reason: PlanningReasonCode): PlanningResult<never> => ({ ok: false, reason });
const bytes = (text: string): number => new TextEncoder().encode(text).length;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]): boolean => Object.keys(v).length === allowed.length && Object.keys(v).every(k => allowed.includes(k));
function limit(value: number | undefined, fallback: number, hard: number): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1 || n > hard) throw new RangeError('Invalid planning limit');
  return n;
}
function limits(config: GoalPlannerConfig) {
  return {
    goals: limit(config.maxGoals, 12, 24),
    edges: limit(config.maxEdges, 32, 64),
    bytes: limit(config.maxProposalBytes, 16384, 32768)
  };
}

/** Parses wire JSON, rejecting status/progress fields and unknown properties. */
export function validateGoalProposal(json: string, config: GoalPlannerConfig = {}): PlanningResult<readonly GoalNode[]> {
  const cap = limits(config);
  if (bytes(json) > cap.bytes) return fail('proposal_too_large');
  let input: unknown;
  try { input = JSON.parse(json); } catch { return fail('invalid_proposal'); }
  if (!object(input) || !keys(input, ['nodes']) || !Array.isArray(input.nodes) || input.nodes.length === 0) return fail('invalid_proposal');
  if (input.nodes.length > cap.goals) return fail('goal_limit');
  const nodes: GoalNode[] = [];
  const ids = new Set<string>();
  let edges = 0;
  for (const node of input.nodes) {
    if (!object(node) || !keys(node, ['id', 'objective', 'acceptance_hint', 'depends_on'])) return fail('invalid_proposal');
    const { id, objective, acceptance_hint, depends_on } = node;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || typeof objective !== 'string' || !objective.trim() || bytes(objective) > 240 || typeof acceptance_hint !== 'string' || bytes(acceptance_hint) > 240 || !Array.isArray(depends_on) || !depends_on.every(d => typeof d === 'string') || new Set(depends_on).size !== depends_on.length) return fail('invalid_proposal');
    if (ids.has(id)) return fail('duplicate_id');
    ids.add(id);
    edges += depends_on.length;
    nodes.push(Object.freeze({ id, objective, acceptance_hint, depends_on: Object.freeze([...depends_on]) }));
  }
  if (edges > cap.edges) return fail('edge_limit');
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const node of nodes) if (node.depends_on.some(d => !ids.has(d))) return fail('dangling_edge');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): boolean {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dep of byId.get(id)!.depends_on) if (!visit(dep)) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  }
  if (!nodes.every(n => visit(n.id))) return fail('cycle');
  return { ok: true, value: Object.freeze(nodes) };
}
function freezeGraph(rootTaskDigest: string, revision: number, nodes: readonly GoalNode[], progress: Record<string, GoalProgress>): GoalGraph {
  for (const id of Object.keys(progress)) progress[id] = Object.freeze({ ...progress[id], refs: Object.freeze([...progress[id].refs]) });
  return Object.freeze({ rootTaskDigest, revision, nodes: Object.freeze([...nodes]), progress: Object.freeze(progress) });
}
const pending = (): GoalProgress => ({ disposition: 'pending', refs: [], lastActivationIndex: null });
export function createGoalGraph(rootTaskDigest: string, json: string, config: GoalPlannerConfig = {}): PlanningResult<GoalGraph> {
  if (!rootTaskDigest) throw new TypeError('Host root task digest is required');
  const parsed = validateGoalProposal(json, config);
  if (!parsed.ok) return parsed;
  const progress: Record<string, GoalProgress> = Object.create(null);
  for (const node of parsed.value) progress[node.id] = pending();
  return { ok: true, value: freezeGraph(rootTaskDigest, 1, parsed.value, progress) };
}

/** Recomputes readiness; there is no separate mutable ready queue. */
export function readyGoals(graph: GoalGraph): readonly string[] {
  return graph.nodes.filter(n => ['pending', 'needs_recheck'].includes(graph.progress[n.id].disposition) && n.depends_on.every(d => graph.progress[d].disposition === 'reported_achieved')).map(n => n.id);
}
/** A recovery hold must include open slots even when their allowance is zero. */
export function selectGoal(graph: GoalGraph, recoveryHold: boolean): string | null {
  const active = graph.nodes.find(n => graph.progress[n.id].disposition === 'active');
  if (active) return active.id;
  if (recoveryHold) return null;
  return readyGoals(graph)[0] ?? null;
}
export function activateGoal(graph: GoalGraph, activationIndex: number, recoveryHold: boolean): GoalGraph {
  if (recoveryHold || graph.nodes.some(n => graph.progress[n.id].disposition === 'active')) return graph;
  if (!Number.isSafeInteger(activationIndex) || activationIndex < 0) throw new RangeError('Invalid activation index');
  const id = selectGoal(graph, false);
  if (id === null) return graph;
  return freezeGraph(graph.rootTaskDigest, graph.revision, graph.nodes, { ...graph.progress, [id]: { ...graph.progress[id], disposition: 'active', lastActivationIndex: activationIndex } });
}

/** Host supplies operations separately from the structure-only proposal. No evidence eligibility is implied. */
export function reviseGoalGraph(graph: GoalGraph, json: string, operations: { readonly reopen: readonly string[]; readonly abandon: readonly string[] }, config: GoalPlannerConfig = {}): PlanningResult<GoalGraph> {
  const parsed = validateGoalProposal(json, config);
  if (!parsed.ok) return parsed;
  const old = new Map(graph.nodes.map(n => [n.id, n]));
  const next = new Map(parsed.value.map(n => [n.id, n]));
  const reopen = new Set(operations.reopen);
  const abandon = new Set(operations.abandon);
  if (reopen.size !== operations.reopen.length || abandon.size !== operations.abandon.length || [...reopen, ...abandon].some(id => !old.has(id)) || [...reopen].some(id => abandon.has(id) || graph.progress[id].disposition === 'abandoned')) return fail('invalid_operation');
  for (const node of graph.nodes) {
    const replacement = next.get(node.id);
    if (!replacement && !abandon.has(node.id) && graph.progress[node.id].disposition !== 'abandoned') return fail('silent_deletion');
    if (replacement && (replacement.objective !== node.objective || graph.progress[node.id].disposition === 'abandoned')) return fail('id_reuse');
    if (reopen.has(node.id) && !replacement) return fail('invalid_operation');
  }
  // Preserve tombstones, but retain proposal order for schedulable nodes.
  const nodes = [...parsed.value, ...graph.nodes.filter(n => !next.has(n.id))];
  const cap = limits(config);
  if (nodes.length > cap.goals) return fail('goal_limit');
  if (nodes.reduce((sum, n) => sum + n.depends_on.length, 0) > cap.edges) return fail('edge_limit');
  const progress: Record<string, GoalProgress> = Object.create(null);
  const changed = new Set(reopen);
  for (const node of nodes) {
    progress[node.id] = old.has(node.id) ? graph.progress[node.id] : pending();
    const prior = old.get(node.id);
    if (prior && (prior.depends_on.length !== node.depends_on.length || prior.depends_on.some(d => !node.depends_on.includes(d)))) changed.add(node.id);
    if (abandon.has(node.id)) {
      progress[node.id] = { ...progress[node.id], disposition: 'abandoned' };
      changed.add(node.id);
    }
  }
  // Fixed point covers descendants regardless of proposal order.
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const node of nodes) if (!changed.has(node.id) && node.depends_on.some(d => changed.has(d))) { changed.add(node.id); expanded = true; }
  }
  for (const id of changed) {
    if (progress[id].disposition !== 'abandoned' && (reopen.has(id) || progress[id].disposition === 'reported_achieved')) progress[id] = { ...progress[id], disposition: 'needs_recheck' };
  }
  return { ok: true, value: freezeGraph(graph.rootTaskDigest, graph.revision + 1, nodes, progress) };
}
export function planningStatus(graph: GoalGraph) {
  const ids = (states: GoalDisposition[]) => graph.nodes.filter(n => states.includes(graph.progress[n.id].disposition)).map(n => n.id);
  const abandoned = ids(['abandoned']);
  const unresolved = ids(['pending', 'active', 'blocked', 'needs_recheck']);
  return { revision: graph.revision, reported_achieved: ids(['reported_achieved']).length, abandoned, unresolved, abandoned_count: abandoned.length, unresolved_count: unresolved.length, total: graph.nodes.length };
}
