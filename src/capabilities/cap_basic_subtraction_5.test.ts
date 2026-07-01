import { handler } from './cap_basic_subtraction_5';

describe('cap_basic_subtraction_5', () => {
  it('subtracts two safe integers', () => {
    expect(handler(5, 3)).toBe(2);
    expect(handler(0, 0)).toBe(0);
    expect(handler(-10, 5)).toBe(-15);
  });

  it('rejects non-safe-integer inputs', () => {
    expect(() => handler(1.5, 2)).toThrow();
    expect(() => handler(NaN, 1)).toThrow();
    expect(() => handler(Infinity, 0)).toThrow();
  });

  it('rejects results outside safe range', () => {
    expect(() => handler(Number.MAX_SAFE_INTEGER, -1)).toThrow();
    expect(() => handler(Number.MIN_SAFE_INTEGER, 1)).toThrow();
  });
});
