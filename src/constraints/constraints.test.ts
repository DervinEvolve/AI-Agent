import { describe, it, expect } from 'vitest';
import { CONSTRAINTS } from './constraints';

describe('con_secrets_leak_prevention_12 Constraint Metadata', () => {
  it('should have the correct constraint metadata registered and active', () => {
    const constraint = CONSTRAINTS.find(c => c.id === 'con_secrets_leak_prevention_12');
    expect(constraint).toBeDefined();
    expect(constraint?.name).toBe('Absolute credential isolation and leak prevention');
    expect(constraint?.status).toBe('active');
    expect(constraint?.added_epoch).toBe(12);
    expect(constraint?.description).toContain('NEVER expose raw secrets');
    expect(constraint?.description).toContain('vault_auth');
  });
});
