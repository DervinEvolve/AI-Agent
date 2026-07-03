import { describe, it, expect } from 'vitest';
import { constraints } from './constraints';

describe('Constraints suite', () => {
  it('should have the correct schema structure for con_exec_isolation_1', () => {
    const con = constraints.find(c => c.id === 'con_exec_isolation_1');
    expect(con).toBeDefined();
    expect(con?.name).toBe('Never execute agent code outside the sandbox');
    expect(con?.status).toBe('active');
    expect(con?.tests).toContain('dynamically registered custom tools are executed inside the sandboxed environment with no direct host access');
  });
});
