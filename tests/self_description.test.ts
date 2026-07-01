import { describe, it, expect } from 'vitest';
import { Agent } from '../src/identity';

describe('Agent self-description consistency', () => {
  it('always contains both "purpose" and "domain" across repeated queries', () => {
    const iterations = 20;
    for (let i = 0; i < iterations; i++) {
      const description: string = Agent.get_description();
      const lower = description.toLowerCase();
      expect(lower).toContain('purpose');
      expect(lower).toContain('domain');
    }
  });

  it('returns a non-empty string', () => {
    const description = Agent.get_description();
    expect(typeof description).toBe('string');
    expect(description.length).toBeGreaterThan(0);
  });
});
