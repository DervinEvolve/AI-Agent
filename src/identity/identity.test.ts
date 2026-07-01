import { identity } from './identity';

describe('Identity Configuration', () => {
  it('should not contain the resolved conflict_5_0', () => {
    const conflictExists = identity.conflicts.conflicts.some(c => c.id === 'conflict_5_0');
    expect(conflictExists).toBe(false);
  });

  it('should have basic subtraction in its capabilities', () => {
    expect(identity.capabilities).toContain('cap_basic_subtraction_5');
  });
});
