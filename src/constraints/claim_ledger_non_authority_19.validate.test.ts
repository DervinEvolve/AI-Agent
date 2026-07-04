import { describe, it, expect } from 'vitest';
import { validateClaim } from './claim_ledger_non_authority_19';

const cleanClaim = {
  id: 'claim-1',
  content: { result: 'analysis' },
  tainted: false,
};

const taintedClaim = {
  id: 'claim-2',
  content: { result: 'suspicious' },
  tainted: true,
};

describe('validateClaim', () => {
  it('rejects authorization purpose', () => {
    const errors = validateClaim(cleanClaim, { purpose: 'authorization' });
    expect(errors).toHaveLength(1);
    expect(errors[0].rule).toBe('no-authorization');
  });

  it('rejects hitl_gate purpose', () => {
    const errors = validateClaim(cleanClaim, { purpose: 'hitl_gate' });
    expect(errors).toHaveLength(1);
    expect(errors[0].rule).toBe('no-hitl-gate');
  });

  it('rejects tool_argument purpose', () => {
    const errors = validateClaim(cleanClaim, { purpose: 'tool_argument', toolName: 'browser' });
    expect(errors).toHaveLength(1);
    expect(errors[0].rule).toBe('no-tool-argument');
  });

  it('rejects memory_write purpose', () => {
    const errors = validateClaim(cleanClaim, { purpose: 'memory_write' });
    expect(errors).toHaveLength(1);
    expect(errors[0].rule).toBe('no-direct-memory-write');
  });

  it('rejects tainted claim for skill_verification', () => {
    const errors = validateClaim(taintedClaim, { purpose: 'skill_verification' });
    expect(errors).toHaveLength(1);
    expect(errors[0].rule).toBe('no-taint-clearing');
  });

  it('rejects tainted claim for milestone_completion', () => {
    const errors = validateClaim(taintedClaim, { purpose: 'milestone_completion' });
    expect(errors).toHaveLength(1);
    expect(errors[0].rule).toBe('no-taint-clearing');
  });

  it('allows clean claim for skill_verification', () => {
    const errors = validateClaim(cleanClaim, { purpose: 'skill_verification' });
    expect(errors).toHaveLength(0);
  });

  it('allows clean claim for milestone_completion', () => {
    const errors = validateClaim(cleanClaim, { purpose: 'milestone_completion' });
    expect(errors).toHaveLength(0);
  });

  it('returns multiple errors for multiple violations? (not applicable, but verify single error per call)', () => {
    // The function returns one error per prohibited purpose; the spec doesn't combine, but we test that it correctly returns only the relevant error.
    const errors = validateClaim(taintedClaim, { purpose: 'authorization' });
    expect(errors).toHaveLength(1);
    expect(errors[0].rule).toBe('no-authorization');
    // taint is irrelevant for authorization
  });

  it('does not reject a tainted claim for a non-prohibited purpose (e.g., a hypothetical advisory purpose)', () => {
    // If a purpose other than the prohibited ones is passed, no error should be raised.
    const errors = validateClaim(taintedClaim, { purpose: 'advisory' as any });
    expect(errors).toHaveLength(0);
  });
});
