import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CHILD_MAX_STEPS,
  DEFAULT_MAX_DELEGATIONS,
  DELEGATE_TASK_TOOL,
  LIMIT_CHILD_MAX_STEPS,
  LIMIT_MAX_DELEGATIONS,
  NEVER_ELIGIBLE_TOOLS,
  validateDelegationOption,
} from '../delegation_contract';

// Every tool is mounted AND marked idempotent here, so the only reason an
// allowlist entry can be refused is the never-eligible rule itself, not the
// idempotency or mounted checks.
const allIdempotentMounted = [
  { name: 'list_files', idempotent: true },
  { name: 'read_file', idempotent: true },
  { name: 'write_file', idempotent: true },
  { name: 'edit_file', idempotent: true },
  { name: 'run_code', idempotent: true },
  { name: DELEGATE_TASK_TOOL, idempotent: true },
];

describe('validateDelegationOption: host option follow-up', () => {
  it('pins the never-eligible set', () => {
    expect(DELEGATE_TASK_TOOL).toBe('delegate_task');
    expect([...NEVER_ELIGIBLE_TOOLS].sort()).toEqual(['delegate_task', 'edit_file', 'run_code', 'write_file']);
  });

  it.each([...NEVER_ELIGIBLE_TOOLS])(
    'refuses %s in the allowlist even when it is mounted and idempotent',
    (name) => {
      const r = validateDelegationOption({ enabled: true, allowedTools: ['read_file', name] }, allIdempotentMounted);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(Array.isArray(r.errors)).toBe(true);
        expect(r.errors.length).toBeGreaterThan(0);
        for (const e of r.errors) expect(typeof e).toBe('string');
      }
    },
  );

  it('accepts the eligible tools from the same mounted set with spec defaults', () => {
    const r = validateDelegationOption(
      { enabled: true, allowedTools: ['list_files', 'read_file'] },
      allIdempotentMounted,
    );
    expect(r).toEqual({
      ok: true,
      enabled: true,
      config: {
        allowedTools: ['list_files', 'read_file'],
        maxDelegations: DEFAULT_MAX_DELEGATIONS,
        childMaxSteps: DEFAULT_CHILD_MAX_STEPS,
      },
    });
    expect(DEFAULT_MAX_DELEGATIONS).toBe(2);
    expect(DEFAULT_CHILD_MAX_STEPS).toBe(6);
  });

  it('passes explicit values at the documented upper limits through unchanged', () => {
    expect(LIMIT_MAX_DELEGATIONS).toBe(4);
    expect(LIMIT_CHILD_MAX_STEPS).toBe(12);
    const r = validateDelegationOption(
      {
        enabled: true,
        allowedTools: ['read_file'],
        maxDelegations: LIMIT_MAX_DELEGATIONS,
        childMaxSteps: LIMIT_CHILD_MAX_STEPS,
      },
      allIdempotentMounted,
    );
    expect(r).toEqual({
      ok: true,
      enabled: true,
      config: { allowedTools: ['read_file'], maxDelegations: 4, childMaxSteps: 12 },
    });
  });

  it('refuses a non-idempotent mounted tool but accepts the same tool once idempotent', () => {
    const option = { enabled: true, allowedTools: ['read_file'] };
    const refused = validateDelegationOption(option, [{ name: 'read_file', idempotent: false }]);
    expect(refused.ok).toBe(false);
    const accepted = validateDelegationOption(option, [{ name: 'read_file', idempotent: true }]);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.enabled).toBe(true);
  });

  it('stays disabled (not an error) when enabled is false, regardless of mounted tools', () => {
    expect(validateDelegationOption(undefined, [])).toEqual({ ok: true, enabled: false });
    expect(
      validateDelegationOption({ enabled: false, allowedTools: ['write_file'] }, allIdempotentMounted),
    ).toEqual({ ok: true, enabled: false });
  });
});
