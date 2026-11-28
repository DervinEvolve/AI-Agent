import { activateGoal, createGoalGraph, planningStatus, readyGoals, reviseGoalGraph, selectGoal, validateGoalProposal, GoalGraph } from '../index';
const node = (id: string, depends_on: string[] = []) => ({ id, objective: id, acceptance_hint: '', depends_on });
const wire = (...nodes: ReturnType<typeof node>[]) => JSON.stringify({ nodes });
function graph(): GoalGraph {
  const result = createGoalGraph('host-digest', wire(node('A'), node('B', ['A']), node('C')));
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
describe('structure-only goal planning', () => {
  it('selects ready work in proposal order without a second queue', () => {
    const original = graph();
    expect(readyGoals(original)).toEqual(['A', 'C']);
    expect(selectGoal(original, true)).toBeNull();
    const active = activateGoal(original, 0, false);
    expect(selectGoal(active, true)).toBe('A');
    expect(activateGoal(active, 1, true)).toBe(active);
    expect(original.progress.A.disposition).toBe('pending');
    expect(Object.isFrozen(active.progress.A)).toBe(true);
  });
  it('rejects cycles, dangling dependencies and forged dispositions', () => {
    expect(validateGoalProposal(wire(node('A', ['B']), node('B', ['A'])))).toEqual({ ok: false, reason: 'cycle' });
    expect(validateGoalProposal(wire(node('A', ['missing'])))).toEqual({ ok: false, reason: 'dangling_edge' });
    expect(validateGoalProposal(JSON.stringify({ nodes: [{ ...node('A'), disposition: 'reported_achieved' }] })).ok).toBe(false);
    expect(validateGoalProposal(wire(node('A'), node('A')))).ok).toBe(false);
  });
  it('preserves previous state on invalid replacements', () => {
    const original = graph();
    const before = JSON.stringify(original);
    expect(reviseGoalGraph(original, wire(node('A')), { reopen: [], abandon: [] })).toEqual({ ok: false, reason: 'silent_deletion' });
    expect(reviseGoalGraph(original, wire({ ...node('A'), objective: 'different' }, node('B', ['A']), node('C')), { reopen: [], abandon: [] })).toEqual({ ok: false, reason: 'id_reuse' });
    expect(JSON.stringify(original)).toBe(before);
  });
  it('retains abandoned IDs and bounds lifetime IDs', () => {
    const result = reviseGoalGraph(graph(), wire(node('A'), node('B', ['A'])), { reopen: [], abandon: ['C'] });
    if (!result.ok) throw new Error(result.reason);
    expect(planningStatus(result.value).abandoned).toEqual(['C']);
    expect(result.value.rootTaskDigest).toBe('host-digest');
    expect(result.value.revision).toBe(2);
    expect(reviseGoalGraph(result.value, wire(node('A'), node('B', ['A']), node('D')), { reopen: [], abandon: [] }, { maxGoals: 3 })).toEqual({ ok: false, reason: 'goal_limit' });
  });
  it('propagates reopen to achieved descendants without discarding refs', () => {
    const initial = graph();
    const achieved: GoalGraph = { ...initial, progress: { ...initial.progress, A: { ...initial.progress.A, disposition: 'reported_achieved', refs: ['observation'] }, B: { ...initial.progress.B, disposition: 'reported_achieved' } } };
    const result = reviseGoalGraph(achieved, wire(node('A'), node('B', ['A']), node('C')), { reopen: ['A'], abandon: [] });
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.progress.A.disposition).toBe('needs_recheck');
    expect(result.value.progress.B.disposition).toBe('needs_recheck');
    expect(result.value.progress.A.refs).toEqual(['observation']);
    expect(readyGoals(result.value)).toEqual(['A', 'C']);
  });
  it('measures UTF-8 bounds and rejects unknown root fields', () => {
    expect(validateGoalProposal(wire({ ...node('A'), objective: 'é'.repeat(121) })).ok).toBe(false);
    expect(validateGoalProposal(wire(node('A')), { maxProposalBytes: 1 })).toEqual({ ok: false, reason: 'proposal_too_large' });
    expect(validateGoalProposal('{"nodes":[],"revision":9}').ok).toBe(false);
  });
});
