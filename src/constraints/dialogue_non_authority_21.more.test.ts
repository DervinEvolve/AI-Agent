import { describe, it, expect } from 'vitest';
import { validateDialogueNonAuthority, DialogueState } from './dialogue_non_authority_21';

describe('Additional dialogue non-authority validation', () => {
  const baseState: DialogueState = {
    taintLevel: 1,
  };

  it('flags a commitment marked as hitlApproved as advisory-only violation', () => {
    const state: DialogueState = {
      ...baseState,
      commitments: [
        { action: 'send_email', hitlApproved: true },
      ],
    };
    const violations = validateDialogueNonAuthority(state);
    expect(violations).toContainEqual(
      expect.stringContaining('commitment')
    );
  });

  it('flags decreasing taint level as a monotonicity violation', () => {
    const state: DialogueState = {
      ...baseState,
      taintLevel: 2,
      previousTaintLevel: 5,
    };
    const violations = validateDialogueNonAuthority(state);
    expect(violations).toContainEqual(
      expect.stringContaining('monotonic')
    );
  });

  it('flags direct use of dialogue state as tool arguments', () => {
    const state: DialogueState = {
      ...baseState,
      usedAsToolArguments: true,
    };
    const violations = validateDialogueNonAuthority(state);
    expect(violations).toContainEqual(
      expect.stringContaining('tool arguments')
    );
  });
});
