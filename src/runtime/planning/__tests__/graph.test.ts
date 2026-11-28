import { describe, it, expect } from 'vitest';
import {
  applyReplan,
  applyReport,
  buildPlanningStatus,
  createGraph,
  markPossiblyStale,
  resolveGoalPlannerConfig,
  selectReady,
  suspendScheduling,
  validateProposal,
} from '../index';
import type { GoalGraph, GraphLimits, ObservationFacts, ReportContext } from '../index';

const limits: GraphLimits = resolveGoalPlannerConfig({ enabled: true });

const ABC = {
  nodes: [
    { id: 'A', objective: 'inspect the input', acceptance_hint: 'file listed', depends_on: [] },
    { id: 'B', objective: 'transform the input', acceptance_hint: '', depends_on: ['A'] },
    { id: 'C', objective: 'write the summary', acceptance_hint: '', depends_on: [] },
  ],
};

function obs(overrides: Partial<ObservationFacts> = {}): ObservationFacts {
  return {
    kind: 'tool',
    outcome: 'success',
    current_run: true,
    exposed: true,
    restricted: false,
    stale: false,
    bound_goal: 'A',
    bound_revision: 1,
    ...overrides,
  };
}

function ctxOf(table: Record<string, ObservationFacts>): ReportContext {
  return { lookup: (ref) => table[ref], maxRefsPerGoal: limits.maxRefsPerGoal };
}

function initial(): GoalGraph {
  const proposal = validateProposal(JSON.stringify(ABC), limits);
  if (!proposal.ok) throw new Error('fixture proposal rejected: ' + proposal.code);
  return createGraph(proposal.nodes, 'digest-1');
}

function dispositionOf(graph: GoalGraph, id: string): string | undefined {
  return graph.nodes.find((node) => node.id === id)?.disposition;
}

describe('goal planner config', () => {
  it('defaults to disabled with documented defaults and is frozen', () => {
    const config = resolveGoalPlannerConfig();
    expect(config.enabled).toBe(false);
    expect(config.maxGoals).toBe(12);
    expect(config.maxPlannerCalls).toBe(4);
    expect(config.minPlanningSteps).toBe(12);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('rejects values above hard caps, non-integers and unknown fields', () => {
    expect(() => resolveGoalPlannerConfig({ maxGoals: 25 })).toThrow(RangeError);
    expect(() => resolveGoalPlannerConfig({ maxEdges: 1.5 })).toThrow(RangeError);
    expect(() => resolveGoalPlannerConfig({ minPlanningSteps: 0 })).toThrow(RangeError);
    expect(() => resolveGoalPlannerConfig({ bogus: 1 } as unknown as Record<string, never>)).toThrow(TypeError);
    expect(resolveGoalPlannerConfig({ maxGoals: 24 }).maxGoals).toBe(24);
  });
});

describe('decompose', () => {
  it('commits A, B(dep A), C as revision 1 and selects only ready nodes in proposal order', () => {
    const graph = initial();
    expect(graph.revision).toBe(1);
    expect(graph.nodes.map((n) => n.disposition)).toEqual(['pending', 'pending', 'pending']);
    const first = selectReady(graph);
    expect(first.active_goal).toBe('A');
    expect(dispositionOf(first.graph, 'B')).toBe('pending');
    // An active goal is never deselected by another selection pass.
    const again = selectReady(first.graph);
    expect(again.active_goal).toBe('A');
    expect(again.graph).toBe(first.graph);
  });

  it('B is not selectable until A is reported achieved', () => {
    let graph = selectReady(initial()).graph;
    const blocked = applyReport(graph, { goal_id: 'A', disposition: 'blocked', refs: [], note: 'no access' }, ctxOf({}));
    expect(blocked.ok).toBe(true);
    graph = blocked.graph;
    const next = selectReady(graph);
    expect(next.active_goal).toBe('C');
    expect(dispositionOf(next.graph, 'B')).toBe('pending');
  });

  it('a proposal cannot mark nodes achieved (forged status rejects)', () => {
    const forged = { nodes: [{ id: 'A', objective: 'x', depends_on: [], disposition: 'reported_achieved' }] };
    const result = validateProposal(forged, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unknown_field');
  });
});

describe('invalid initial proposals', () => {
  const cases: [string, unknown, string][] = [
    ['cycle', { nodes: [{ id: 'A', objective: 'a', depends_on: ['B'] }, { id: 'B', objective: 'b', depends_on: ['A'] }] }, 'cycle'],
    ['dangling edge', { nodes: [{ id: 'A', objective: 'a', depends_on: ['Z'] }] }, 'dangling_edge'],
    ['self edge', { nodes: [{ id: 'A', objective: 'a', depends_on: ['A'] }] }, 'self_edge'],
    ['duplicate id', { nodes: [{ id: 'A', objective: 'a' }, { id: 'A', objective: 'b' }] }, 'duplicate_id'],
    ['bad id', { nodes: [{ id: 'has space', objective: 'a' }] }, 'invalid_id'],
    ['oversize objective', { nodes: [{ id: 'A', objective: 'x'.repeat(241) }] }, 'text_too_large'],
    ['unknown top-level field', { nodes: [{ id: 'A', objective: 'a' }], run: 'rm' }, 'unknown_field'],
    ['empty', { nodes: [] }, 'empty_graph'],
    ['not json', '{nodes', 'invalid_json'],
  ];
  for (const [name, raw, code] of cases) {
    it('rejects ' + name, () => {
      const result = validateProposal(raw, limits);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(code);
    });
  }

  it('rejects oversize proposals and too many goals', () => {
    const big = validateProposal(JSON.stringify(ABC) + ' '.repeat(limits.maxProposalBytes), limits);
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.code).toBe('oversize_proposal');
    const many = { nodes: Array.from({ length: 13 }, (_, i) => ({ id: 'n' + String(i), objective: 'o' })) };
    const result = validateProposal(many, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('too_many_goals');
  });
});

describe('report_goal core', () => {
  it('refuses with the documented reason codes and leaves the graph untouched', () => {
    const graph = selectReady(initial()).graph;
    const table = { ok1: obs(), restricted: obs({ restricted: true }), nav: obs({ kind: 'navigation' }), unk: obs({ outcome: 'unknown' }), plan: obs({ kind: 'planning' }), stale: obs({ stale: true }) };
    const ctx = ctxOf(table);
    const expectRefusal = (report: unknown, reason: string) => {
      const result = applyReport(graph, report, ctx);
      expect(result.ok).toBe(false);
      expect(result.started).toBe(false);
      if (!result.ok) expect(result.reason).toBe(reason);
      expect(result.graph).toBe(graph);
    };
    expectRefusal({ goal_id: 'C', disposition: 'achieved', refs: ['ok1'], note: '' }, 'goal_not_active');
    expectRefusal({ goal_id: 'nope', disposition: 'achieved', refs: ['ok1'], note: '' }, 'unknown_goal');
    expectRefusal({ goal_id: 'A', disposition: 'achieved', refs: [], note: '' }, 'missing_support');
    expectRefusal({ goal_id: 'A', disposition: 'contradicted', refs: [], note: '' }, 'missing_support');
    expectRefusal({ goal_id: 'A', disposition: 'achieved', refs: ['restricted'], note: '' }, 'ineligible_support');
    expectRefusal({ goal_id: 'A', disposition: 'achieved', refs: ['nav'], note: '' }, 'ineligible_support');
    expectRefusal({ goal_id: 'A', disposition: 'achieved', refs: ['unk'], note: '' }, 'ineligible_support');
    expectRefusal({ goal_id: 'A', disposition: 'achieved', refs: ['plan'], note: '' }, 'ineligible_support');
    expectRefusal({ goal_id: 'A', disposition: 'achieved', refs: ['stale'], note: '' }, 'ineligible_support');
    expectRefusal({ goal_id: 'A', disposition: 'achieved', refs: ['missing'], note: '' }, 'ineligible_support');
    expectRefusal({ goal_id: 'A', disposition: 'verified', refs: ['ok1'], note: '' }, 'invalid_report');
    expectRefusal({ goal_id: 'A', disposition: 'achieved', refs: ['ok1'], note: '', extra: 1 }, 'invalid_report');
    expectRefusal({ goal_id: 'A', disposition: 'achieved', refs: ['ok1'], note: 'n'.repeat(513) }, 'note_too_large');
  });

  it('evidence reuse: an observation bound to A supports C; original binding is unchanged', () => {
    const table = { o1: obs({ bound_goal: 'A', bound_revision: 1 }), o2: obs({ bound_goal: 'B', bound_revision: 1 }) };
    const ctx = ctxOf(table);
    let graph = selectReady(initial()).graph;
    const a = applyReport(graph, { goal_id: 'A', disposition: 'achieved', refs: ['o1'], note: '' }, ctx);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.record.reuse).toEqual([]);
    // report_goal does not itself switch goals
    expect(a.graph.active_goal).toBeNull();
    graph = selectReady(a.graph).graph;
    expect(graph.active_goal).toBe('B');
    const b = applyReport(graph, { goal_id: 'B', disposition: 'achieved', refs: ['o2'], note: '' }, ctx);
    graph = selectReady(b.graph).graph;
    expect(graph.active_goal).toBe('C');
    const c = applyReport(graph, { goal_id: 'C', disposition: 'achieved', refs: ['o1'], note: 'same listing' }, ctx);
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.record.reuse).toEqual([{ ref: 'o1', original_goal: 'A', original_revision: 1 }]);
      expect(c.record.replan_trigger).toBeNull();
    }
    expect(table.o1.bound_goal).toBe('A');
    const cNode = c.graph.nodes.find((n) => n.id === 'C');
    expect(cNode?.disposition).toBe('reported_achieved');
    expect(cNode?.evidence_refs[0]?.reused).toBe(true);
    const status = buildPlanningStatus(c.graph);
    expect(status.reported_achieved_count).toBe(3);
    expect(status.unresolved).toEqual([]);
  });

  it('blocked with other ready work is not a replan trigger; blocked with none is', () => {
    const ctx = ctxOf({});
    let graph = selectReady(initial()).graph;
    const a = applyReport(graph, { goal_id: 'A', disposition: 'blocked', refs: [], note: '' }, ctx);
    expect(a.ok && a.record.replan_trigger).toBe(null);
    graph = selectReady(a.graph).graph;
    const c = applyReport(graph, { goal_id: 'C', disposition: 'blocked', refs: [], note: '' }, ctx);
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.record.replan_trigger).toBe('blocked_no_ready');
    expect(selectReady(c.graph).active_goal).toBeNull();
  });
});

describe('staleness without reopen', () => {
  it('older workspace refs become possibly_stale only', () => {
    const ctx = ctxOf({ w1: obs({ workspace_generation: 1 }) });
    let graph = selectReady(initial()).graph;
    graph = applyReport(graph, { goal_id: 'A', disposition: 'achieved', refs: ['w1'], note: '' }, ctx).graph;
    graph = selectReady(graph).graph;
    expect(graph.active_goal).toBe('B');
    const unchanged = markPossiblyStale(graph, 1);
    expect(unchanged).toBe(graph);
    const marked = markPossiblyStale(graph, 2);
    const aNode = marked.nodes.find((n) => n.id === 'A');
    expect(aNode?.evidence_refs[0]?.possibly_stale).toBe(true);
    expect(aNode?.disposition).toBe('reported_achieved');
    expect(marked.active_goal).toBe('B');
    expect(dispositionOf(marked, 'B')).toBe('active');
    expect(marked.revision).toBe(graph.revision);
  });
});

describe('contradiction and replan', () => {
  function contradicted(): GoalGraph {
    const ctx = ctxOf({ f1: obs({ outcome: 'known_failure' }) });
    const graph = selectReady(initial()).graph;
    const result = applyReport(graph, { goal_id: 'A', disposition: 'contradicted', refs: ['f1'], note: 'input missing' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.replan_trigger).toBe('contradicted');
    return result.graph;
  }

  it('commits a replacement graph atomically as revision 2 and retains the abandoned id', () => {
    const before = contradicted();
    const replan = {
      nodes: [
        { id: 'A2', objective: 'locate the input elsewhere', depends_on: [] },
        { id: 'B', objective: 'transform the input', depends_on: ['A2'] },
        { id: 'C', objective: 'write the summary', depends_on: [] },
      ],
      abandon: ['A'],
    };
    const result = applyReplan(before, replan, limits);
    expect(result.ok).toBe(true);
    expect(result.graph.revision).toBe(2);
    expect(before.revision).toBe(1);
    expect(dispositionOf(result.graph, 'A')).toBe('abandoned');
    // failures and evidence are never erased by a revision
    expect(result.graph.nodes.find((n) => n.id === 'A')?.evidence_refs.map((r) => r.ref)).toEqual(['f1']);
    const status = buildPlanningStatus(result.graph);
    expect(status.revision).toBe(2);
    expect(status.abandoned).toEqual([{ id: 'A', initial: true }]);
    expect(status.unresolved.map((u) => u.id)).toEqual(['A2', 'B', 'C']);
    expect(selectReady(result.graph).active_goal).toBe('A2');
  });

  it('rejects cycle, dangling edge, id reuse, silent deletion and bad operations, preserving the graph', () => {
    const before = contradicted();
    const snapshot = JSON.stringify(before);
    const A = { id: 'A', objective: 'inspect the input', depends_on: [] as string[] };
    const B = { id: 'B', objective: 'transform the input', depends_on: ['A'] };
    const C = { id: 'C', objective: 'write the summary', depends_on: [] as string[] };
    const cases: [unknown, string][] = [
      [{ nodes: [{ ...A, depends_on: ['B'] }, B, C] }, 'cycle'],
      [{ nodes: [B, C], abandon: ['A'] }, 'dangling_edge'],
      [{ nodes: [{ ...A, objective: 'something else entirely' }, B, C] }, 'id_reuse'],
      [{ nodes: [A, B] }, 'silent_deletion'],
      [{ nodes: [A, B, C], abandon: ['A'] }, 'invalid_operation'],
      [{ nodes: [A, B, C], abandon: ['ghost'] }, 'unknown_operation_target'],
      [{ nodes: [A, B, C], reopen: ['B'] }, 'invalid_operation'],
      [{ nodes: [A, B, C], status: { A: 'reported_achieved' } }, 'unknown_field'],
      [{ nodes: [A, B, { ...C, disposition: 'reported_achieved' }] }, 'unknown_field'],
    ];
    for (const [raw, code] of cases) {
      const result = applyReplan(before, raw, limits);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(code);
      expect(result.graph).toBe(before);
    }
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('an abandoned id can never be reused and counts against maxGoals', () => {
    const before = contradicted();
    const first = applyReplan(
      before,
      { nodes: [{ id: 'B2', objective: 'transform differently', depends_on: [] }, { id: 'C', objective: 'write the summary', depends_on: [] }], abandon: ['A', 'B'] },
      limits,
    );
    expect(first.ok).toBe(true);
    const reuse = applyReplan(
      first.graph,
      { nodes: [{ id: 'A', objective: 'inspect the input' }, { id: 'B2', objective: 'transform differently' }, { id: 'C', objective: 'write the summary' }] },
      limits,
    );
    expect(reuse.ok).toBe(false);
    if (!reuse.ok) expect(reuse.code).toBe('id_reuse');
    const tight: GraphLimits = { ...limits, maxGoals: 4 };
    const over = applyReplan(
      first.graph,
      { nodes: [{ id: 'B2', objective: 'transform differently' }, { id: 'C', objective: 'write the summary' }, { id: 'D', objective: 'new' }] },
      tight,
    );
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe('too_many_goals');
  });

  it('explicit reopen marks achieved descendants needs_recheck', () => {
    const ctx = ctxOf({ o1: obs(), o2: obs({ bound_goal: 'B' }) });
    let graph = selectReady(initial()).graph;
    graph = applyReport(graph, { goal_id: 'A', disposition: 'achieved', refs: ['o1'], note: '' }, ctx).graph;
    graph = selectReady(graph).graph;
    graph = applyReport(graph, { goal_id: 'B', disposition: 'achieved', refs: ['o2'], note: '' }, ctx).graph;
    const result = applyReplan(graph, { nodes: ABC.nodes, reopen: ['A'] }, limits);
    expect(result.ok).toBe(true);
    expect(dispositionOf(result.graph, 'A')).toBe('pending');
    expect(dispositionOf(result.graph, 'B')).toBe('needs_recheck');
    expect(dispositionOf(result.graph, 'C')).toBe('pending');
    // B is needs_recheck but its prerequisite is no longer achieved, so A goes first.
    expect(selectReady(result.graph).active_goal).toBe('A');
  });
});

describe('terminal status and suspension', () => {
  it('lists an abandoned initial node even when every remaining node is reported achieved', () => {
    const ctx = ctxOf({ o1: obs({ bound_goal: 'C' }), f1: obs({ outcome: 'known_failure' }) });
    let graph = selectReady(initial()).graph;
    graph = applyReport(graph, { goal_id: 'A', disposition: 'contradicted', refs: ['f1'], note: '' }, ctx).graph;
    const replanned = applyReplan(graph, { nodes: [{ id: 'C', objective: 'write the summary', depends_on: [] }], abandon: ['A', 'B'] }, limits);
    expect(replanned.ok).toBe(true);
    graph = selectReady(replanned.graph).graph;
    graph = applyReport(graph, { goal_id: 'C', disposition: 'achieved', refs: ['o1'], note: '' }, ctx).graph;
    const status = buildPlanningStatus(graph);
    expect(status.unresolved).toEqual([]);
    expect(status.abandoned).toEqual([
      { id: 'A', initial: true },
      { id: 'B', initial: true },
    ]);
    expect(status.counts.abandoned).toBe(2);
    expect(status.total).toBe(3);
  });

  it('suspension keeps the graph as advisory state and selects nothing', () => {
    const ctx = ctxOf({});
    let graph = selectReady(initial()).graph;
    // cannot suspend out from under an active goal
    expect(suspendScheduling(graph, 'planning_exhausted')).toBe(graph);
    graph = applyReport(graph, { goal_id: 'A', disposition: 'blocked', refs: [], note: '' }, ctx).graph;
    const suspended = suspendScheduling(graph, 'planning_exhausted');
    expect(suspended.scheduling).toBe('planning_exhausted');
    expect(suspended.nodes).toEqual(graph.nodes);
    expect(selectReady(suspended).active_goal).toBeNull();
    const status = buildPlanningStatus(suspended);
    expect(status.scheduling_mode).toBe('planning_exhausted');
    expect(status.unresolved.map((u) => u.id)).toEqual(['A', 'B', 'C']);
  });

  it('graphs are frozen', () => {
    const graph = initial();
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.nodes)).toBe(true);
    expect(Object.isFrozen(graph.nodes[0])).toBe(true);
  });
});
