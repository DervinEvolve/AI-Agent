import { describe, it, expect } from 'vitest';
import { constraints } from './constraints';

describe('Constraints validation tests', () => {
  it('should contain the isolation constraint with correct properties and values', () => {
    const constraint = constraints.find(c => c.id === 'con_exec_isolation_1');
    expect(constraint).toBeDefined();
    
    if (constraint) {
      expect(constraint.name).toBe('Never execute agent code outside the sandbox');
      expect(constraint.status).toBe('active');
      expect(constraint.added_epoch).toBe(1);
      
      // Verify that network policy explicitly mentions the host-side gateway bypass and sandbox isolation
      expect(constraint.network_policy).toContain('Safe host-side gateway tools');
      expect(constraint.network_policy).toContain('cap_external_search_api_4');
      expect(constraint.network_policy).toContain('bypass sandbox egress limits');
      expect(constraint.network_policy).toContain('restricted from accessing sandbox-internal resources');

      // Verify that the tests list includes the specific test case for sandbox vs host-side gateway search protection
      expect(constraint.tests).toContain('sandbox code cannot intercept or spoof host-side gateway search requests');
    }
  });
});
