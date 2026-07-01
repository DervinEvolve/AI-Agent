import { handler } from './cap_basic_subtraction_5';

describe('cap_basic_subtraction_5 additional coverage', () => {
  it('computes correct difference for edge-case safe integers', () => {
    expect(handler(9007199254740991, 1)).toBe(9007199254740990);
    expect(handler(-9007199254740991, -1)).toBe(-9007199254740990);
  });

  it('allows zero result from non-zero inputs', () => {
    expect(handler(42, 42)).toBe(0);
  });
});