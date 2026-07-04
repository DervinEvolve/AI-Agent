import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateClaim,
  validateClaimForStorage,
  sanitizeClaimForExport,
} from './claim_ledger_non_authority_19';

// Mock the secret_redactor module to provide predictable behavior
vi.mock('../capabilities/secret_redactor', () => ({
  detectSecrets: (s: string) => s.includes('secret'),
  redactSecrets: (s: string) => s.replace(/secret\w*/gi, '[REDACTED]'),
}));

const sampleClaim = {
  id: 'test-claim-1',
  content: { result: 'some analysis' },
  tainted: false,
};

describe('validateClaim', () => {
  it('a claim cannot be used as the authorization for a browser/API dispatch', () => {
    const errors = validateClaim(sampleClaim, { purpose: 'authorization' });
    expect(errors).toHaveLength(1);
    expect(errors[0].rule).toBe('no-authorization');
  });

  it('a claim cannot satisfy a HITL gate or serve as an approval token', () => {
    const errors = validateClaim(sampleClaim, { purpose: 'hitl_gate' });
    expect(errors).toHaveLength(1);
    expect(errors[0].rule).toBe('no-hitl-gate');
  });

  it('a claim cannot clear taint or convert tainted evidence into trusted tool arguments', () => {
    const taintedClaim = { ...sampleClaim, tainted: true };
    const errorsSkill = validateClaim(taintedClaim, { purpose: 'skill_verification' });
    expect(errorsSkill).toHaveLength(1);
    expect(errorsSkill[0].rule).toBe('no-taint-clearing');

    const errorsMilestone = validateClaim(taintedClaim, { purpose: 'milestone_completion' });
    expect(errorsMilestone).toHaveLength(1);
    expect(errorsMilestone[0].rule).toBe('no-taint-clearing');
  });

  it('claim cannot be directly used as tool arguments', () => {
    const errors = validateClaim(sampleClaim, { purpose: 'tool_argument', toolName: 'browser_navigate' });
    expect(errors).toHaveLength(1);
    expect(errors[0].rule).toBe('no-tool-argument');
  });

  it('claim cannot directly write long-term memory', () => {
    const errors = validateClaim(sampleClaim, { purpose: 'memory_write' });
    expect(errors).toHaveLength(1);
    expect(errors[0].rule).toBe('no-direct-memory-write');
  });
});

describe('validateClaimForStorage', () => {
  it('rejects storage when claim contains a raw secret and redaction makes it ambiguous', () => {
    const claimWithSecret = {
      id: 'claim-2',
      content: { token: 'supersecret123' },
    };
    const result = validateClaimForStorage(claimWithSecret);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].rule).toBe('secret-redaction-ambiguity');
  });

  it('accepts storage and returns redacted claim when secret can be redacted without ambiguity', () => {
    const claimWithMix = {
      id: 'claim-3',
      content: { summary: 'Important result', token: 'secretxyz should be hidden' },
    };
    const result = validateClaimForStorage(claimWithMix);
    expect(result.valid).toBe(true);
    expect(result.redacted).toBeDefined();
    expect(result.redacted!.content).toEqual({
      summary: 'Important result',
      token: '[REDACTED] should be hidden',
    });
  });

  it('accepts claims with no secrets', () => {
    const result = validateClaimForStorage(sampleClaim);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.redacted).toBeUndefined();
  });
});

describe('sanitizeClaimForExport', () => {
  it('exported claims never contain raw secrets', () => {
    const claimWithSecret = {
      id: 'claim-4',
      content: { token: 'secret-data' },
      internalMetadata: { internal: true },
      authState: 'live',
    };
    const sanitized = sanitizeClaimForExport(claimWithSecret);
    // Raw secret removed
    expect(sanitized.content).toEqual({ token: '[REDACTED]' });
    // Internal metadata fields stripped
    expect((sanitized as any).internalMetadata).toBeUndefined();
    expect((sanitized as any).authState).toBeUndefined();
  });

  it('exports preserve original structure when no secrets', () => {
    const cleanClaim = {
      id: 'claim-5',
      content: { result: 'good' },
    };
    const sanitized = sanitizeClaimForExport(cleanClaim);
    expect(sanitized.content).toEqual({ result: 'good' });
  });
});

describe('controller integration', () => {
  it('verifies that claims are never passed directly to tool adapters as arguments without independent validation', () => {
    // Simulate a controller that uses claims
    const toolAdapter = {
      dispatch: vi.fn((toolName: string, args: any) => {
        // This would actually perform the action; we only check that it was called with validated args
      }),
    };

    function controllerDispatchClaim(claim: any, toolName: string) {
      // Step 1: validate the claim usage
      const errors = validateClaim(claim, { purpose: 'tool_argument', toolName });
      if (errors.length > 0) {
        throw new Error('Claim validation failed: ' + errors.map(e => e.message).join(', '));
      }
      // Only then can the claim content be passed
      toolAdapter.dispatch(toolName, claim.content);
    }

    // A legitimate claim (not prohibited) would pass validation, but in current rules all tool_argument uses are forbidden.
    // So we expect an error. The integration test verifies the gate prevents direct usage.
    expect(() =>
      controllerDispatchClaim(sampleClaim, 'browser_navigate')
    ).toThrow(/Claim validation failed/);

    // Verify that tool adapter was never called (prevented by validation)
    expect(toolAdapter.dispatch).not.toHaveBeenCalled();
  });
});
