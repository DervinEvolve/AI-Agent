import { describe, it, expect } from 'vitest';
import {
  GOAL_ID_PATTERN,
  GOAL_PLANNER_DEFAULTS,
  GOAL_PLANNER_HARD_CAPS,
  MAX_GOAL_TEXT_BYTES,
  MAX_REPORT_NOTE_BYTES,
  applyReplan,
  applyReport,
  createGraph,
  markPossiblyStale,
  resolveGoalPlannerConfig,
  selectReady,
  utf8Bytes,
  validateProposal,
} from '../index';
import type { GoalGraph, GoalPlannerConfig, GraphLimits, ObservationFacts, ReportContext } from '../index';

const limits: GraphLimits = resolveGoalPlannerConfig({ enabled: true });

interface RawNode {
  id: string;
  objective: string;
  acceptance_hint: string;
  depends_on: string[];
}

function node(id: string, depends_on: string[] = [], objective = 'objective for ' + id): RawNode {
  return { id, objective, acceptance_hint: '', depends_on };
}

function propose(nodes: unknown[]) {
  return validateProposal(JSON.stringify({ nodes }), limits);
}

function graphOf(nodes: RawNode[]): GoalGraph {
  const proposal = propose(nodes);
  if (!proposal.ok) throw new Error('fixture proposal rejected: ' + proposal.code);
  return createGraph(proposal.nodes, 'digest-contract');
}

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

function dispositionOf(graph: GoalGraph, id: string): string | undefined {
  return graph.nodes.find((n) => n.id === id)?.disposition;
}

function report(goal_id: string, disposition: string, refs: string[], note = '') {
  return { goal_id, disposition, refs, note };
}

describe('goal planner config hard caps', () => {
  it('keeps every default at or below its hard cap', () => {
    for (const key of Object.keys(GOAL_PLANNER_HARD_CAPS) as Array<keyof typeof GOAL_PLANNER_HARD_CAPS>) {
      expect(GOAL_PLANNER_DEFAULTS[key]).toBeLessThanOrEqual(GOAL_PLANNER_HARD_CAPS[key]);
    }
  });

  it('rejects one above the hard cap for every numeric key', () => {
    for (const key of Object.keys(GOAL_PLANNER_HARD_CAPS) as Array<keyof typeof GOAL_PLANNER_HARD_CAPS>) {
      const over = { [key]: GOAL_PLANNER_HARD_CAPS[key] + 1 } as Partial<GoalPlannerConfig>;
      expect(() => resolveGoalPlannerConfig(over)).toThrow(RangeError);
    }
  });

  it('accepts values exactly at the hard cap', () => {
    expect(resolveGoalPlannerConfig({ maxGoals: 24 }).maxGoals).toBe(24);
    expect(resolveGoalPlannerConfig({ minPlanningSteps: 1000 }).minPlanningSteps).toBe(1000);
  });

  it('rejects unknown keys and non-integers', () => {
    expect(() => resolveGoalPlannerConfig({ bogus: 1 } as unknown as Partial<GoalPlannerConfig>)).toThrow(TypeError);
    expect(() => resolveGoalPlannerConfig({ maxGoals: 1.5 })).toThrow();
  });
});

describe('utf8Bytes and exported bounds', () => {
  it('counts UTF-8 bytes, not code units', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('\u00e9')).toBe(2);
    expect(utf8Bytes('\u20ac')).toBe(3);
    expect(utf8Bytes('')).toBe(0);
  });

  it('publishes the documented bounds', () => {
    expect(MAX_GOAL_TEXT_BYTES).toBe(240);
    expect(MAX_REPORT_NOTE_BYTES).toBe(512);
    expect(GOAL_ID_PATTERN.test('goal_1-a')).toBe(true);
    expect(GOAL_ID_PATTERN.test('has space')).toBe(false);
    expect(GOAL_ID_PATTERN.test('')).toBe(false);
    expect(GOAL_ID_PATTERN.test('x'.repeat(33))).toBe(false);
  });
});

describe('validateProposal structural rejects', () => {
  it('accepts a valid DAG and preserves proposal order', () => {
    const result = propose([node('A'), node('B', ['A']), node('C')]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nodes.map((n) => n.id)).toEqual(['A', 'B', 'C']);
  });

  it('rejects duplicate ids, self edges, dangling edges and cycles', () => {
    expect(propose([node('A'), node('A')]).ok).toBe(false);
    expect(propose([node('A', ['A'])]).ok).toBe(false);
    expect(propose([node('A', ['Z'])]).ok).toBe(false);
    expect(propose([node('A', ['B']), node('B', ['A'])]).ok).toBe(false);
    expect(propose([node('A', ['C']), node('B', ['A']), node('C', ['B'])]).ok).toBe(false);
  });

  it('rejects ids outside the bounded ASCII pattern', () => {
    expect(propose([node('has space')]).ok).toBe(false);
    expect(propose([node('x'.repeat(33))]).ok).toBe(false);
  });

  it('enforces the 240-byte objective bound in UTF-8 bytes', () => {
    expect(propose([node('A', [], 'x'.repeat(240))]).ok).toBe(true);
    expect(propose([node('A', [], 'x'.repeat(241))]).ok).toBe(false);
    // 121 two-byte characters = 242 bytes but only 121 code units
    expect(propose([node('A', [], '\u00e9'.repeat(121))]).ok).toBe(false);
  });

  it('rejects unknown fields, including forged runtime status', () => {
    expect(propose([{ ...node('A'), disposition: 'reported_achieved' }]).ok).toBe(false);
    expect(propose([{ ...node('A'), extra: true }]).ok).toBe(false);
  });

  it('rejects more goals than maxGoals', () => {
    const tooMany = Array.from({ length: limits.maxGoals + 1 }, (_, i) => node('G' + i));
    expect(propose(tooMany).ok).toBe(false);
    const atLimit = Array.from({ length: limits.maxGoals }, (_, i) => node('G' + i));
    expect(propose(atLimit).ok).toBe(true);
  });
});

describe('scheduling and report_goal core', () => {
  it('creates revision 1 and selects the first ready node in proposal order', () => {
    const graph = graphOf([node('A'), node('B', ['A']), node('C')]);
    expect(graph.revision).toBe(1);
    expect(graph.root_task_digest).toBe('digest-contract');
    expect(graph.nodes.map((n) => n.id)).toEqual(['A', 'B', 'C']);

    const selected = selectReady(graph);
    expect(selected.active_goal).toBe('A');
    expect(selected.graph.active_goal).toBe('A');
    expect(dispositionOf(selected.graph, 'B')).not.toBe('active');
    expect(dispositionOf(selected.graph, 'C')).not.toBe('active');
  });

  it('never selects a node whose prerequisite is unreported', () => {
    const graph = graphOf([node('B', ['A']), node('A')]);
    // B is first in proposal order but depends on A
    expect(selectReady(graph).active_goal).toBe('A');
  });

  it('accepts an achieved report for the active goal and unlocks its dependent', () => {
    const active = selectReady(graphOf([node('A'), node('B', ['A']), node('C')])).graph;
    const result = applyReport(active, report('A', 'achieved', ['obs1']), ctxOf({ obs1: obs() }));
    expect(result.ok).toBe(true);
    expect(result.started).toBe(true);
    expect(result.graph).not.toBe(active);
    expect(Object.isFrozen(result.graph)).toBe(true);
    expect(dispositionOf(result.graph, 'A')).toBe('reported_achieved');
    // input graph is untouched
    expect(dispositionOf(active, 'A')).not.toBe('reported_achieved');

    // B (now ready) precedes C in proposal order
    expect(selectReady(result.graph).active_goal).toBe('B');
  });

  it('refuses a report for a non-active goal and returns the same graph', () => {
    const active = selectReady(graphOf([node('A'), node('B', ['A']), node('C')])).graph;
    const result = applyReport(active, report('C', 'achieved', ['obs1']), ctxOf({ obs1: obs() }));
    expect(result.ok).toBe(false);
    expect(result.started).toBe(false);
    expect(result.graph).toBe(active);
    if (!result.ok) expect(result.reason).toBe('goal_not_active');
  });

  it('refuses unknown goals, missing support and unresolvable refs without mutation', () => {
    const active = selectReady(graphOf([node('A'), node('C')])).graph;
    const ctx = ctxOf({ obs1: obs() });
    for (const bad of [
      report('ZZ', 'achieved', ['obs1']),
      report('A', 'achieved', []),
      report('A', 'achieved', ['nope']),
      report('A', 'verified', ['obs1']),
    ]) {
      const result = applyReport(active, bad, ctx);
      expect(result.ok).toBe(false);
      expect(result.started).toBe(false);
      expect(result.graph).toBe(active);
    }
  });

  it('refuses restricted support as ineligible_support', () => {
    const active = selectReady(graphOf([node('A'), node('C')])).graph;
    const result = applyReport(
      active,
      report('A', 'achieved', ['obs1']),
      ctxOf({ obs1: obs({ restricted: true }) }),
    );
    expect(result.ok).toBe(false);
    expect(result.graph).toBe(active);
    if (!result.ok) expect(result.reason).toBe('ineligible_support');
  });

  it('enforces the 512-byte note bound in UTF-8 bytes', () => {
    const active = selectReady(graphOf([node('A'), node('C')])).graph;
    const ctx = ctxOf({ obs1: obs() });

    const tooLong = applyReport(active, report('A', 'achieved', ['obs1'], 'x'.repeat(513)), ctx);
    expect(tooLong.ok).toBe(false);
    expect(tooLong.graph).toBe(active);
    if (!tooLong.ok) expect(tooLong.reason).toBe('note_too_large');

    // 257 two-byte characters = 514 bytes, though only 257 code units
    const multibyte = applyReport(active, report('A', 'achieved', ['obs1'], '\u00e9'.repeat(257)), ctx);
    expect(multibyte.ok).toBe(false);
    if (!multibyte.ok) expect(multibyte.reason).toBe('note_too_large');

    const atLimit = applyReport(active, report('A', 'achieved', ['obs1'], 'x'.repeat(512)), ctx);
    expect(atLimit.ok).toBe(true);
  });

  it('lets an observation collected under A support a later active C, keeping the original binding', () => {
    const ctx = ctxOf({ obs1: obs({ bound_goal: 'A', bound_revision: 1 }) });
    const first = selectReady(graphOf([node('A'), node('C')])).graph;
    const afterA = applyReport(first, report('A', 'achieved', ['obs1']), ctx);
    expect(afterA.ok).toBe(true);

    const second = selectReady(afterA.graph);
    expect(second.active_goal).toBe('C');

    const afterC = applyReport(second.graph, report('C', 'achieved', ['obs1']), ctx);
    expect(afterC.ok).toBe(true);
    expect(dispositionOf(afterC.graph, 'C')).toBe('reported_achieved');
    const refs = afterC.graph.nodes.find((n) => n.id === 'C')?.evidence_refs ?? [];
    expect(refs.length).toBe(1);
    expect(refs[0].original_goal).toBe('A');
    expect(refs[0].reused).toBe(true);

    // nothing left to schedule
    expect(selectReady(afterC.graph).active_goal).toBeNull();
  });

  it('markPossiblyStale changes no disposition and does not deselect the active goal', () => {
    const first = selectReady(graphOf([node('A'), node('B', ['A']), node('C')])).graph;
    const afterA = applyReport(first, report('A', 'achieved', ['obs1']), ctxOf({ obs1: obs() }));
    const active = selectReady(afterA.graph).graph;
    expect(active.active_goal).toBe('B');

    const stale = markPossiblyStale(active, 5);
    expect(stale.active_goal).toBe('B');
    expect(stale.revision).toBe(active.revision);
    expect(stale.nodes.map((n) => [n.id, n.disposition])).toEqual(
      active.nodes.map((n) => [n.id, n.disposition]),
    );
  });
});

describe('applyReplan atomic rejects', () => {
  const base = () => selectReady(graphOf([node('A'), node('B', ['A']), node('C')])).graph;

  it('rejects a cyclic replacement and preserves the previous graph reference', () => {
    const graph = base();
    const raw = JSON.stringify({ nodes: [node('A', ['B']), node('B', ['A']), node('C')] });
    const result = applyReplan(graph, raw, limits);
    expect(result.ok).toBe(false);
    expect(result.graph).toBe(graph);
    expect(result.graph.revision).toBe(1);
  });

  it('rejects a dangling edge', () => {
    const graph = base();
    const raw = JSON.stringify({ nodes: [node('A'), node('B', ['Q']), node('C')] });
    const result = applyReplan(graph, raw, limits);
    expect(result.ok).toBe(false);
    expect(result.graph).toBe(graph);
  });

  it('rejects silent deletion of existing nodes', () => {
    const graph = base();
    const result = applyReplan(graph, JSON.stringify({ nodes: [node('A')] }), limits);
    expect(result.ok).toBe(false);
    expect(result.graph).toBe(graph);
  });

  it('rejects reusing an existing id for a different objective', () => {
    const graph = base();
    const raw = JSON.stringify({
      nodes: [node('A'), node('B', ['A'], 'a completely different objective'), node('C')],
    });
    const result = applyReplan(graph, raw, limits);
    expect(result.ok).toBe(false);
    expect(result.graph).toBe(graph);
  });

  it('rejects non-JSON garbage without mutation', () => {
    const graph = base();
    const result = applyReplan(graph, '{not json', limits);
    expect(result.ok).toBe(false);
    expect(result.graph).toBe(graph);
  });
});
