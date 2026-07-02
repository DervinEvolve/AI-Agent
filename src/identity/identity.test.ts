import { describe, it, expect } from 'vitest';
import { IDENTITY } from './identity';

describe('IDENTITY', () => {
  it('exposes a domain string that mentions exponentiation', () => {
    expect(typeof IDENTITY.domain).toBe('string');
    expect(IDENTITY.domain).not.toBe('');
    expect(IDENTITY.domain).toContain('exponentiation');
  });

  it('exposes a purpose string that mentions exponentiation', () => {
    expect(typeof IDENTITY.purpose).toBe('string');
    expect(IDENTITY.purpose).not.toBe('');
    expect(IDENTITY.purpose).toContain('exponentiation');
  });
});
