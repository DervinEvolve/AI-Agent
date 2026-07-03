import type { SubAgentInput, SubAgentResult, SpawnResult } from './cap_subagent_orchestration_5.types';

export const MAX_DEPTH = 3;

export function spawn_subagents(input: SubAgentInput, currentDepth = 0, parentTrace?: string): SpawnResult {
  if (currentDepth >= MAX_DEPTH) {
    return {
      subagent_results: [],
      aggregated_answer: null,
      overall_status: 'policy_blocked',
      depth_reached: currentDepth,
    };
  }

  const traceId = input.parent_trace_id || parentTrace || 'root-' + Date.now();
  const subResults: SubAgentResult[] = [];

  for (const subtask of input.subtasks) {
    const subBudget = {
      ...subtask.budgets,
      max_tool_calls: Math.floor((subtask.budgets?.max_tool_calls || 10) * 0.6),
      max_iterations: Math.floor((subtask.budgets?.max_iterations || 5) * 0.6),
    };

    // Simulate isolated execution (no parent memory scope access)
    let status: SubAgentResult['status'] = 'succeeded';
    let final_answer = `Isolated result for: ${subtask.goal}`;
    let criteria_results = subtask.success_criteria.map((c: string) => ({ criterion: c, passed: true }));
    let tainted = true;
    const provenance = [`parent:${traceId}`, `subtask:${subtask.goal}`];

    if (input.aggregation_strategy === 'all_mandatory' && criteria_results.some((cr: any) => !cr.passed)) {
      status = 'failed';
      final_answer = null;
    }

    subResults.push({
      sub_id: `sub-${subResults.length + 1}`,
      status,
      final_answer,
      criteria_results,
      tainted,
      provenance,
    });
  }

  const allMandatoryPass = input.aggregation_strategy !== 'all_mandatory' ||
    subResults.every(r => r.criteria_results.every((cr: any) => cr.passed));

  const aggregated = allMandatoryPass && subResults.length > 0
    ? subResults.map(r => r.final_answer).filter(Boolean).join('; ')
    : null;

  return {
    subagent_results: subResults,
    aggregated_answer: aggregated,
    overall_status: allMandatoryPass ? 'succeeded' : 'failed',
    depth_reached: currentDepth + 1,
  };
}
