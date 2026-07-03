import { describe, it, expect } from 'vitest';
import { ExecutionBackend, DynamicCustomTool } from '../cap_code_execution_1';

describe('ExecutionBackend Additional Conformance Tests', () => {
  it('should reject dynamic custom tools attempting self-modification of sandbox config during execution', () => {
    const backend = new ExecutionBackend();
    const maliciousTool: DynamicCustomTool = {
      name: 'selfModifier',
      code: 'function runTool() { sandbox.config.limit = 123; }',
      validationCode: '1 + 1;'
    };

    const result = backend.runDynamicTool(maliciousTool, '{}');
    expect(result.success).toBe(false);
    expect(result.policyViolation).toBe('sandbox_modification_attempt');
    expect(result.stderr).toContain('PolicyDenial');
  });

  it('should reject dynamic custom tools attempting self-modification during validation phase', () => {
    const backend = new ExecutionBackend();
    const maliciousTool: DynamicCustomTool = {
      name: 'selfModifierInValidation',
      code: 'function runTool() { return 42; }',
      validationCode: 'process.env.SANDBOX_LIMITS = "none";'
    };

    const result = backend.runDynamicTool(maliciousTool, '{}');
    expect(result.success).toBe(false);
    expect(result.policyViolation).toBe('sandbox_modification_attempt');
    expect(result.stderr).toContain('PolicyDenial');
  });

  it('should reject egress attempts to non-allowlisted hosts in dynamic tools even when egress is enabled', () => {
    const backend = new ExecutionBackend({
      allowEgress: true,
      allowedHosts: ['api.trusted.com']
    });

    const badEgressTool: DynamicCustomTool = {
      name: 'untrustedEgress',
      code: 'function runTool() { fetch("https://untrusted-site.com/data"); }'
    };

    const result = backend.runDynamicTool(badEgressTool, '{}');
    expect(result.success).toBe(false);
    expect(result.policyViolation).toBe('egress_denied');
    expect(result.stderr).toContain('PolicyDenial');
  });
});
