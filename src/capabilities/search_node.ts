export interface PlanStep {
  step_description: string;
  rationale: string;
  score: number;
  necessary_tool?: string;
  is_leaf: boolean;
}

export interface Observation {
  content: string;
  tainted: boolean;
}

export interface SearchNodeState {
  goal: string;
  availableTools: string[];
  observations: Observation[];
  tainted: boolean;
}

export interface SearchNode {
  id: string;
  state: SearchNodeState;
  parentId: string | null;
  childrenIds: string[];
  planSteps: PlanStep[];
  depth: number;
  score: number;
  isExpanded: boolean;
}
