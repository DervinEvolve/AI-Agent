import { describe, it, expect } from 'vitest';
import { Agent } from '../src/identity';

describe('Agent.get_description() deep behavioral contract', () => {
  // Determinism: the same call should return the same string every time.
  // This guards against accidental non-determinism (e.g. random selection,
  // Date.now() interpolation, or unstable ordering) in the implementation.
  it('is deterministic across many invocations', () => {
    const first = Agent.get_description();
    for (let i = 0; i < 50; i++) {
      expect(Agent.get_description()).toBe(first);
    }
  });

  // The description should be a meaningful sentence, not a keyword blob.
  it('is a single coherent sentence-like string', () => {
    const desc = Agent.get_description();
    expect(desc.length).toBeGreaterThanOrEqual(20);
    expect(desc.length).toBeLessThanOrEqual(500);
    // Should end with punctuation or at least not be a bare fragment.
    expect(/[.!?]$/.test(desc.trim())).toBe(true);
  });

  // Both required keywords must appear, but they should be part of natural
  // prose — check they are surrounded by word boundaries so that a substring
  // like "purposely" does not accidentally satisfy the requirement.
  it('contains "purpose" and "domain" as whole words', () => {
    const desc = Agent.get_description().toLowerCase();
    expect(/\bpurpose\b/).test(desc);
    expect(/\bdomain\b/).test(desc);
  });

  // The agent should describe *itself*, so first-person pronouns or the
  // word "agent" should appear, confirming the description is self-referential
  // rather than a generic boilerplate string.
  it('is self-referential', () => {
    const desc = Agent.get_description().toLowerCase();
    const selfReferential = /\b(i|me|my|myself|agent)\b/.test(desc);
    expect(selfReferential).toBe(true);
  });

  // Repeated rapid calls should never throw or return a different type —
  // guards against stateful implementations that mutate internal buffers.
  it('remains stable under rapid repeated calls', () => {
    const results: string[] = [];
    for (let i = 0; i < 100; i++) {
      results.push(Agent.get_description());
    }
    const unique = new Set(results);
    expect(unique.size).toBe(1);
    expect(typeof results[0]).toBe('string');
  });
});
