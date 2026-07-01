import { identity } from '../src/identity/identity';

describe('Arithmetic Tutor Agent Identity', () => {
  it('should have a purpose that includes addition, subtraction, and division', () => {
    const purpose = identity.identity.purpose;
    expect(purpose).toContain('addition');
    expect(purpose).toContain('subtraction');
    expect(purpose).toContain('division');
  });
  it('should have capabilities reflecting addition, subtraction, and division', () => {
    const capabilities = identity.identity.capabilities;
    expect(capabilities).toContain('basic_addition_3');
    expect(capabilities).toContain('basic_subtraction_5');
    expect(capabilities).toContain('basic_division_7');
  });
  it('should have a defined name and version', () => {
    expect(identity.identity.name).toBeTruthy();
    expect(identity.identity.version).toBeTruthy();
  });
});