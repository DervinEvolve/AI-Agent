import { capBasicAddition3 } from '../capabilities/cap_basic_addition_3';
import { capBasicSubtraction5 } from '../capabilities/cap_basic_subtraction_5';

export interface Identity {
  name: string;
  capabilities: string[];
  conflicts: {
    conflicts: Array<{
      id: string;
      description: string;
      resolved: boolean;
    }>;
  };
}

export const identity: Identity = {
  name: 'Arithmetic Agent',
  capabilities: [
    capBasicAddition3.id,
    capBasicSubtraction5.id,
    'cap_basic_multiplication'
  ],
  conflicts: {
    // conflict_5_0 is removed as subtraction is now fully supported and resolved
    conflicts: []
  }
};
