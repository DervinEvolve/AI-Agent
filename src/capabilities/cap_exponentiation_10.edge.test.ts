import { describe, it, expect } from 'vitest';
import behExponentiationHandler10 from './cap_exponentiation_10.js';

describe('beh_exponentiation_handler_10 – edge cases', () => {
  it('returns 0 for 0^positive', () => {
    const result = behExponentiationHandler10.handler('0^5');
    expect(result.handled).toBe(true);
    expect(result.message).toContain('0');
  });

  it('returns 1 for 1^any', () => {
    const result = behExponentiationHandler10.handler('1^100');
    expect(result.handled).toBe(true);
    expect(result.message).toContain('1');
  });

  it('returns 1 for (-1)^even', () => {
    const result = behExponentiationHandler10.handler('-1^2');
    expect(result.handled).toBe(true);
    expect(result.message).toContain('1');
  });

  it('returns -1 for (-1)^odd', () => {
    const result = behExponentiationHandler10.handler('-1^3');
    expect(result.handled).toBe(true);
    expect(result.message).toContain('-1');
  });

  it('rejects 0^0', () => {
    const result = behExponentiationHandler10.handler('0^0');
    expect(result.handled).toBe(true);
    expect(result.message).toMatch(/0\^0|undefined|indeterminate/i);
  });

  it('rejects negative exponent', () => {
    const result = behExponentiationHandler10.handler('5^-3');
    expect(result.handled).toBe(true);
    expect(result.message).toMatch(/negative|non-negative/i);
  });

  it('rejects overflow', () => {
    const result = behExponentiationHandler10.handler('9999^9999');
    expect(result.handled).toBe(true);
    expect(result.message).toMatch(/too large|overflow|exceed/i);
  });

  it('rejects non-integer base', () => {
    const result = behExponentiationHandler10.handler('5.5^2');
    expect(result.handled).toBe(true);
    expect(result.message).toMatch(/integer|whole number/i);
  });
});
