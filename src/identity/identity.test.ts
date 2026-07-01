import { identity, getSelfDescription } from './identity';

describe('Agent Identity', () => {
  it('should have the correct domain and purpose defined in identity', () => {
    expect(identity).toBeDefined();
    expect(identity.domain).toBe('educational mathematics assistance');
    expect(identity.purpose).toBe('To assist users in understanding and solving basic mathematics queries');
  });

  it('should generate a self-description that includes the domain and purpose', () => {
    const description = getSelfDescription();
    expect(description).toContain('educational mathematics assistance');
    expect(description).toContain('To assist users in understanding and solving basic mathematics queries');
    expect(description).toBe('Domain: educational mathematics assistance. Purpose: To assist users in understanding and solving basic mathematics queries.');
  });
});
