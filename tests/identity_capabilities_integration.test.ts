import { identity } from '../src/identity/identity';
import { capBasicAddition3 } from '../src/capabilities/cap_basic_addition_3';
import { capBasicSubtraction5 } from '../src/capabilities/cap_basic_subtraction_5';

describe('Identity Capabilities Integration', () => {
  it('should include the exact ID of capBasicAddition3', () => {
    expect(identity.capabilities).toContain(capBasicAddition3.id);
  });

  it('should include the exact ID of capBasicSubtraction5', () => {
    expect(identity.capabilities).toContain(capBasicSubtraction5.id);
  });

  it('should have a valid structure matching the Identity interface', () => {
    expect(identity.name).toBe('Arithmetic Agent');
    expect(Array.isArray(identity.capabilities)).toBe(true);
    expect(Array.isArray(identity.conflicts.conflicts)).toBe(true);
  });
});
