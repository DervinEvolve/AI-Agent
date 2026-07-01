export function handler(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
    throw new Error('Inputs must be safe integers');
  }
  const result = a - b;
  if (!Number.isSafeInteger(result)) {
    throw new Error('Result exceeds safe integer range');
  }
  return result;
}

export const capability = {
  id: 'cap_basic_subtraction_5',
  scope: 'subtraction of exactly two finite integers; no floating-point, no chained operations, no numbers exceeding safe integer range',
  status: 'active',
  added_epoch: 5,
  description: 'Perform subtraction of two finite integers to assist users with basic educational subtraction queries.'
};
