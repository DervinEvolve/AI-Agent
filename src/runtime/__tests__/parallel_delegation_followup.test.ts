import { describe, it, expect } from 'vitest';
import {
  validateParallelDelegationConfig,
  computeChildEligibleSet,
  validateDelegateManyArgs,
  classifyDelegateManyOutcome,
  validateDelegateManyCitation,
  hasLoneSurrogates,
  DENIED_DELEGATE_MANY_TOOLS,
  type DelegateManyOutput,
} from '../parallel_delegation';

describe('cap_parallel_delegation_mount_40 follow-up validation', () => {
  it('validates parallel config bounds and non-integer values', () => {
    expect(validateParallelDelegationConfig({ enabled: true, maxFanOut: 2, maxConcurrency: 1 })).toEqual({
      enabled: true,
      maxFanOut: 2,
      maxConcurrency: 1,
    });
    expect(() => validateParallelDelegationConfig({ enabled: true, maxFanOut: 1 })).toThrow();
    expect(() => validateParallelDelegationConfig({ enabled: true, maxFanOut: 2.5 })).toThrow();
    expect(() => validateParallelDelegationConfig({ enabled: true, maxConcurrency: 0 })).toThrow();
    expect(() => validateParallelDelegationConfig({ enabled: true, maxConcurrency: 1.5 })).toThrow();
  });

  it('detects lone surrogates while allowing valid surrogate pairs', () => {
    expect(hasLoneSurrogates('hello world')).toBe(false);
    expect(hasLoneSurrogates('\uD83D\uDE00')).toBe(false);
    expect(hasLoneSurrogates('\uD800')).toBe(true);
    expect(hasLoneSurrogates('abc\uDC00def')).toBe(true);
  });

  it('filters child_eligible_set against deny list, allowlist, and idempotency', () => {
    const registryTools = [
      { name: 'read_file', idempotent: true },
      { name: 'list_dir', idempotent: true },
      { name: 'not_allowed', idempotent: true },
      { name: 'non_idempotent', idempotent: false },
      ...Array.from(DENIED_DELEGATE_MANY_TOOLS).map((name) => ({ name, idempotent: true })),
    ];
    const allowlist = registryTools.map((t) => t.name).filter((n) => n !== 'not_allowed');
    const eligible = computeChildEligibleSet(registryTools, allowlist);
    expect(Array.from(eligible).sort()).toEqual(['list_dir', 'read_file']);
  });

  it('validates delegate_many arguments strictly', () => {
    const opts = {
      maxFanOut: 3,
      eligibleTools: new Set(['read_file', 'list_dir']),
      hostMaxChildSteps: 10,
      hostMaxChildTimeoutMs: 5000,
    };

    expect(
      validateDelegateManyArgs(
        {
          tasks: [
            { subtask_id: 'task_1', task: 'Inspect A', allowed_tools: ['read_file'], max_steps: 5, timeout_ms: 1000 },
            { subtask_id: 'task-2', task: 'Inspect B' },
          ],
        },
        opts,
      ).valid,
    ).toBe(true);

    // Duplicate subtask_id
    expect(
      validateDelegateManyArgs(
        {
          tasks: [
            { subtask_id: 'dup', task: 'A' },
            { subtask_id: 'dup', task: 'B' },
          ],
        },
        opts,
      ).valid,
    ).toBe(false);

    // Invalid subtask_id characters
    expect(
      validateDelegateManyArgs(
        { tasks: [{ subtask_id: 'bad id!', task: 'A' }] },
        opts,
      ).valid,
    ).toBe(false);

    // Empty task
    expect(
      validateDelegateManyArgs(
        { tasks: [{ subtask_id: 't1', task: '' }] },
        opts,
      ).valid,
    ).toBe(false);

    // Oversized task (> 4000 UTF-8 bytes)
    expect(
      validateDelegateManyArgs(
        { tasks: [{ subtask_id: 't1', task: 'a'.repeat(4001) }] },
        opts,
      ).valid,
    ).toBe(false);

    // Ineligible per-task tool
    expect(
      validateDelegateManyArgs(
        { tasks: [{ subtask_id: 't1', task: 'A', allowed_tools: ['write_file'] }] },
        opts,
      ).valid,
    ).toBe(false);

    // Out-of-range max_steps and timeout_ms
    expect(
      validateDelegateManyArgs(
        { tasks: [{ subtask_id: 't1', task: 'A', max_steps: 11 }] },
        opts,
      ).valid,
    ).toBe(false);
    expect(
      validateDelegateManyArgs(
        { tasks: [{ subtask_id: 't1', task: 'A', timeout_ms: 50 }] },
        opts,
      ).valid,
    ).toBe(false);
  });

  it('classifies delegate_many outcomes according to started, settled, and ok', () => {
    const base: DelegateManyOutput = {
      started: true,
      ok: true,
      settled: true,
      total_tasks: 1,
      completed_count: 1,
      failed_count: 0,
      truncated: false,
      termination_confirmed: true,
      cleanup_confirmed: true,
      results: [],
    };

    expect(classifyDelegateManyOutcome({ ...base, started: false, ok: false })).toBe('pre_execution_rejection');
    expect(classifyDelegateManyOutcome(base)).toBe('success');
    expect(classifyDelegateManyOutcome({ ...base, ok: false })).toBe('known_failure');
    expect(classifyDelegateManyOutcome({ ...base, settled: false, ok: false })).toBe('unknown');
  });

  it('validates shape-3 citations for completed subtasks even in partial failures', () => {
    const partialOutput: DelegateManyOutput = {
      started: true,
      ok: false,
      settled: true,
      total_tasks: 2,
      completed_count: 1,
      failed_count: 1,
      truncated: false,
      termination_confirmed: true,
      cleanup_confirmed: true,
      results: [
        {
          subtask_id: 'ok_task',
          task_index: 0,
          child_started: true,
          outcome: 'completed',
          summary: 'done',
          citations: [
            { child_call_id: 'c1', tool_name: 'read_file', success: true },
            { child_call_id: 'c2', tool_name: 'read_file', success: false },
          ],
          steps_used: 2,
          termination_confirmed: true,
          cleanup_confirmed: true,
        },
        {
          subtask_id: 'failed_task',
          task_index: 1,
          child_started: true,
          outcome: 'failed',
          summary: 'err',
          citations: [{ child_call_id: 'c3', tool_name: 'read_file', success: true }],
          steps_used: 1,
          termination_confirmed: true,
          cleanup_confirmed: true,
        },
      ],
    };

    expect(
      validateDelegateManyCitation(partialOutput, { subtask_id: 'ok_task', child_call_id: 'c1' }),
    ).toBe(true);
    expect(
      validateDelegateManyCitation(partialOutput, { subtask_id: 'ok_task', child_call_id: 'c2' }),
    ).toBe(false);
    expect(
      validateDelegateManyCitation(partialOutput, { subtask_id: 'failed_task', child_call_id: 'c3' }),
    ).toBe(false);
    expect(
      validateDelegateManyCitation(partialOutput, { subtask_id: 'missing', child_call_id: 'c1' }),
    ).toBe(false);
    expect(
      validateDelegateManyCitation(
        { ...partialOutput, settled: false },
        { subtask_id: 'ok_task', child_call_id: 'c1' },
      ),
    ).toBe(false);
  });
});
