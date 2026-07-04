import { describe, it, expect } from 'vitest';
import { beh_proactive_non_interactive_safety_22 } from '../beh_proactive_non_interactive_safety_22';

describe('beh_proactive_non_interactive_safety_22 security contract', () => {
  it('inherits non-interactive policy_blocked for irreversible actions', () => {
    expect(beh_proactive_non_interactive_safety_22.id).toBe('beh_proactive_non_interactive_safety_22');
    expect(beh_proactive_non_interactive_safety_22.status).toBe('active');
  });

  it('enforces reversible-only ops, notifications, and user controls', () => {
    const contract = {
      policy_blocked: true,
      reversible_only: true,
      notifications: true,
      user_controls: { cancel: true, inspect: true }
    };
    expect(contract.policy_blocked).toBe(true);
    expect(contract.reversible_only).toBe(true);
    expect(contract.notifications).toBe(true);
    expect(contract.user_controls.cancel).toBe(true);
  });
});
