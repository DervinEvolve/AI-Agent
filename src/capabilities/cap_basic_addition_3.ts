export interface Capability {
  id: string;
  description: string;
  scope: string;
  execute(a: number, b: number): number;
}

export const cap_basic_addition_3: Capability = {
  id: "cap_basic_addition_3",
  description: "Perform single-step addition to assist users with basic educational mathematics queries.",
  scope: "single addition operations only",
  execute: (a: number, b: number): number => {
    if (typeof a !== 'number' || typeof b !== 'number') {
      throw new Error('Inputs must be numbers for addition');
    }
    return a + b;
  }
};
