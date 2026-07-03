export interface Subtask {
  goal: string;
  success_criteria: string[];
  available_tools?: string[];
  budgets?: { max_tool_calls?: number; max_iterations?: number };
}

export interface SubAgentInput {
  goal: string;
  subtasks: Subtask[];
  aggregation_strategy: 'all_mandatory' | 'weighted' | 'first_valid';
  max_depth?: number;
  parent_trace_id?: string;
}

export interface SubAgentResult {
  sub_id: string;
  status: string;
  final_answer: string | null;
  criteria_results: { criterion: string; passed: boolean }[];
  tainted: boolean;
  provenance: string[];
}

export interface SpawnResult {
  subagent_results: SubAgentResult[];
  aggregated_answer: string | null;
  overall_status: 'succeeded' | 'failed' | 'budget_exhausted' | 'policy_blocked';
  depth_reached: number;
}
