import { describe, it, expect } from 'vitest';
import {
  validateParallelDelegationConfig,
  computeChildEligibleSet,
  validateDelegateManyArgs,
  classifyDelegateManyOutcome,
  validateDelegateManyCitation,
  executeDelegateMany,
  type DelegateManyOutput,
} from '../parallel_delegation';

describe('cap_parallel_delegation_mount_40', () => {
  it('validates HostConfig.delegation.parallel options and defaults', () => {
    expect(validateParallelDelegationConfig(undefined).enabled).toBe(false);
    expect(validateParallelDelegationConfig({ enabled: false }).enabled).toBe(false);
    expect(validateParallelDelegationConfig({ enabled: true })).toEqual({
      enabled: true,
      maxFanOut: 4,
      maxConcurrency: 4,
    });
    expect(() => validateParallelDelegationConfig({ enabled: true, extra: 1 })).toThrow();
    expect(() => validateParallelDelegationConfig({ enabled: true, maxFanOut: 9 })).toThrow();
    expect(() => validateParallelDelegationConfig({ enabled: true, maxFanOut: 3, maxConcurrency: 4 })).toThrow();
  });

  it('computes child_eligible_set excluding denied, non-idempotent, skill_, and mcp_ tools', () => {
    const eligible = computeChildEligibleSet(
      [
        { name: 'read_file', idempotent: true },
        { name: 'write_file', idempotent: false },
        { name: 'delegate_task', idempotent: true },
        { name: 'delegate_many', idempotent: true },
        { name: 'skill_foo', idempotent: true },
        { name: 'mcp_bar', idempotent: true },
      ],
      ['read_file', 'write_file', 'delegate_task', 'delegate_many', 'skill_foo', 'mcp_bar'],
    );
    expect(Array.from(eligible)).toEqual(['read_file']);
  });

  it('rejects invalid_args with started=false', () => {
    const opts = {
      maxFanOut: 4,
      eligibleTools: new Set(['read_file']),
      hostMaxChildSteps: 10,
      hostMaxChildTimeoutMs: 5000,
    };
    expect(validateDelegateManyArgs({ tasks: [], extra: 1 }, opts).valid).toBe(false);
    expect(validateDelegateManyArgs({ tasks: [] }, opts).valid).toBe(false);
    expect(
      validateDelegateManyArgs(
        {
          tasks: [
            { subtask_id: 'a', task: 'one' },
            { subtask_id: 'a', task: 'two' },
          ],
        },
        opts,
      ).valid,
    ).toBe(false);
    expect(
      validateDelegateManyArgs(
        { tasks: [{ subtask_id: 'a', task: 'one', allowed_tools: ['write_file'] }] },
        opts,
      ).valid,
    ).toBe(false);
  });

  it('refuses delegate_many when parent recovery slot is open or unknown outcome is unresolved', async () => {
    const res = await executeDelegateMany({
      parentCallId: 'call_1',
      rawArgs: { tasks: [{ subtask_id: 's1', task: 'do' }] },
      config: { enabled: true, maxFanOut: 4, maxConcurrency: 2 },
      eligibleTools: new Set(['read_file']),
      hostMaxChildSteps: 10,
      hostMaxChildTimeoutMs: 5000,
      parentRecoverySlotOpen: true,
      hasUnresolvedUnknown: false,
      remainingParentSteps: { count: 10 },
      storeFullReport: () => 'obs_1',
      runChild: async () => {
        throw new Error('should not run');
      },
    });
    expect(res.started).toBe(false);
    expect(res.rejected).toBe(true);
  });

  it('runs bounded concurrency, serializes complete(), reserves parent steps, and preserves input order', async () => {
    let active = 0;
    let maxActive = 0;
    let inComplete = 0;
    let maxInComplete = 0;

    const res = await executeDelegateMany({
      parentCallId: 'call_2',
      rawArgs: {
        tasks: [
          { subtask_id: 's1', task: 't1' },
          { subtask_id: 's2', task: 't2' },
          { subtask_id: 's3', task: 't3' },
          { subtask_id: 's4', task: 't4' },
        ],
      },
      config: { enabled: true, maxFanOut: 4, maxConcurrency: 2 },
      eligibleTools: new Set(['read_file']),
      hostMaxChildSteps: 10,
      hostMaxChildTimeoutMs: 5000,
      parentRecoverySlotOpen: false,
      hasUnresolvedUnknown: false,
      remainingParentSteps: { count: 3 },
      storeFullReport: () => 'obs_2',
      runChild: async (ctx) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await ctx.completeWithMutex(async () => {
          inComplete++;
          maxInComplete = Math.max(maxInComplete, inComplete);
          await new Promise((r) => setTimeout(r, 5));
          inComplete--;
        });
        const reserved = ctx.reserveParentStep();
        active--;
        if (!reserved) {
          return {
            child_started: true,
            outcome: 'step_limit',
            summary: 'step limit',
            citations: [],
            steps_used: 0,
            termination_confirmed: true,
            cleanup_confirmed: true,
          };
        }
        return {
          child_started: true,
          outcome: 'completed',
          summary: `done ${ctx.subtask.subtask_id}`,
          citations: [{ child_call_id: `${ctx.parentCallId}:${ctx.subtask.subtask_id}:1`, tool_name: 'read_file', success: true }],
          steps_used: 1,
          termination_confirmed: true,
          cleanup_confirmed: true,
        };
      },
    });

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxInComplete).toBe(1);
    expect(res.results.map((r) => r.subtask_id)).toEqual(['s1', 's2', 's3', 's4']);
    expect(res.completed_count).toBe(3);
    expect(res.failed_count).toBe(1);
    expect(res.settled).toBe(true);
    expect(res.ok).toBe(false);
    expect(
      classifyDelegateManyOutcome({ started: res.started, outerStatus: 'ok', settled: res.settled, ok: res.ok }),
    ).toBe('known_failure');

    const map = new Map<string, DelegateManyOutput>([['call_2', res]]);
    expect(
      validateDelegateManyCitation({ call_id: 'call_2', subtask_id: 's1', child_call_id: 'call_2:s1:1' }, map).valid,
    ).toBe(true);
    expect(
      validateDelegateManyCitation({ call_id: 'call_2', subtask_id: 's4', child_call_id: 'call_2:s4:1' }, map).valid,
    ).toBe(false);
    expect(
      validateDelegateManyCitation(
        { call_id: 'call_2', subtask_id: 's1', child_call_id: 'call_2:s1:1', passage_id: 'p1' },
        map,
      ).valid,
    ).toBe(false);
  });

  it('handles per-task timeout and unsettled child cleanly', async () => {
    const res = await executeDelegateMany({
      parentCallId: 'call_3',
      rawArgs: {
        tasks: [
          { subtask_id: 'hang', task: 'hang forever', timeout_ms: 100 },
          { subtask_id: 'queued', task: 'never starts' },
        ],
      },
      config: { enabled: true, maxFanOut: 4, maxConcurrency: 1 },
      eligibleTools: new Set(['read_file']),
      hostMaxChildSteps: 10,
      hostMaxChildTimeoutMs: 5000,
      parentRecoverySlotOpen: false,
      hasUnresolvedUnknown: false,
      remainingParentSteps: { count: 10 },
      cleanupAllowanceMs: 10,
      storeFullReport: () => 'obs_3',
      runChild: async () => new Promise(() => {}),
    });
    expect(res.settled).toBe(false);
    expect(res.results[1].outcome).toBe('not_started');
    expect(
      classifyDelegateManyOutcome({ started: res.started, outerStatus: 'ok', settled: res.settled, ok: res.ok }),
    ).toBe('unknown');
  });
});
