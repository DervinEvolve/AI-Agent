export interface Constraint {
  id: string;
  description: string;
  status: 'active' | 'inactive';
  added_epoch: number;
}

export const constraints: Record<string, Constraint> = {
  con_reject_out_of_scope_5: {
    id: "con_reject_out_of_scope_5",
    description: "When a query requests floating-point arithmetic, chained operations, numbers outside safe integer range, or any operation beyond the active capabilities, the agent must explicitly state that the request is out of scope and refuse to perform it.",
    status: "active",
    added_epoch: 5
  }
};
