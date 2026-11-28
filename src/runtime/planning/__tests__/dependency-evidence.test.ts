import { createGoalGraph, readyGoals, validateGoalProposal } from '../index';
import type { GoalGraph, GoalDisposition } from '../index';

const node = (id: string, depends_on: string[] = [], objective = id) => ({
  id, objective, acceptance_hint: '', depends_on,
});

function graph(): GoalGraph {
  const result = createGoalGraph('runtime-root', JSON.stringify({ nodes: [
    node('A'), node('B', ['A']), node('C', ['A', 'B']), node('D'),
  ] }));
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

// Progress is trusted host state, never part of the model's proposal.
function withDisposition(source: GoalGraph, id: string, disposition: GoalDisposition): GoalGraph {
  return {
    ...source,
    progress: {
      ...source.progress,
      [id]: { ...source.progress[id], disposition },
    },
  };
}

describe('goal dependency admission and UTF-8 boundaries', () => {
  it('requires every prerequisite to be reported achieved, not merely finished or evidenced', () => {
    const original = graph();
    expect(readyGoals(original)).toEqual(['A', 'D']);

    const achievedA = withDisposition(original, 'A', 'reported_achieved');
    expect(readyGoals(achievedA)).toEqual(['B', 'D']);
    const achievedBoth = withDisposition(achievedA, 'B', 'reported_achieved');
    expect(readyGoals(achievedBoth)).toEqual(['C', 'D']);

    for (const disposition of ['blocked', 'abandoned', 'needs_recheck'] as const) {
      const changed = withDisposition(achievedBoth, 'A', disposition);
      expect(readyGoals(changed)).not.toContain('C');
      expect(readyGoals(changed)).toContain('D');
    }
    expect(original.progress.A.disposition).toBe('pending');
    expect(original.progress.B.disposition).toBe('pending');
  });

  it('applies the objective limit to UTF-8 bytes rather than JavaScript string length', () => {
    const proposal = (objective: string) => JSON.stringify({ nodes: [node('A', [], objective)] });
    // U+00E9 occupies two UTF-8 bytes: 120 copies exactly fill 240 bytes.
    const boundary = '\u00e9'.repeat(120);
    const accepted = validateGoalProposal(proposal(boundary));
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error(accepted.reason);
    expect(accepted.value[0].objective).toBe(boundary);
    expect(validateGoalProposal(proposal(boundary + 'x')).ok).toBe(false);
    expect(validateGoalProposal(proposal('x'.repeat(240))).ok).toBe(true);
    expect(validateGoalProposal(proposal('x'.repeat(241))).ok).toBe(false);
  });
});
