export interface Constraint {
  id: string;
  description: string;
  status: 'active' | 'inactive';
  added_epoch: number;
}

export const constraints: Constraint[] = [
  {
    id: 'con_foundational_1',
    description: 'The agent is strictly limited to basic integer arithmetic education.',
    status: 'active',
    added_epoch: 1
  },
  {
    id: 'con_avoid_general_calculator_5',
    description: 'The agent must never present itself as a general-purpose calculator or claim capabilities outside the explicitly defined arithmetic operations.',
    status: 'active',
    added_epoch: 5
  }
];
