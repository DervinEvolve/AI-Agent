import { cap_basic_addition_3 } from './cap_basic_addition_3';

describe('cap_basic_addition_3', () => {
  it('adds two valid numbers', () => {
    expect(cap_basic_addition_3.execute(2, 3)).toBe(5);
    expect(cap_basic_addition_3.execute(-1, 1)).toBe(0);
  });

  it('rejects non-numeric inputs', () => {
    expect(() => cap_basic_addition_3.execute('2' as any, 3)).toThrow('Inputs must be numbers for addition');
    expect(() => cap_basic_addition_3.execute(2, null as any)).toThrow('Inputs must be numbers for addition');
  });
});