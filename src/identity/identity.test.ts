import { identity } from './identity';

describe('Identity Domain and Purpose', () => {
  it('should have the correct domain specifying addition, subtraction, and multiplication', () => {
    expect(identity.domain).toContain('basic integer arithmetic');
    expect(identity.domain).toContain('addition');
    expect(identity.domain).toContain('subtraction');
    expect(identity.domain).toContain('multiplication');
  });

  it('should have the correct purpose explaining educational arithmetic operations', () => {
    expect(identity.purpose).toContain('understand and correctly compute');
    expect(identity.purpose).toContain('addition');
    expect(identity.purpose).toContain('subtraction');
    expect(identity.purpose).toContain('multiplication');
  });
});
