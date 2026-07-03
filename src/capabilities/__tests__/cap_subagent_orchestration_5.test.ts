import { describe, it, expect } from 'vitest';
import { spawn_subagents, MAX_DEPTH } from '../cap_subagent_orchestration_5';

describe('cap_subagent_orchestration_5', () => {
  it('spawns isolated sub-agents with strictly tighter budgets than parent', () => {
    const result = spawn_subagents({
      goal: 'test',
      subtasks: [{ goal: 'g', success_criteria: ['c'], budgets: { max_tool_calls: 20 } }],
      aggregation_strategy: 'all_mandatory',
    });
    expect(result.overall_status).toBe('succeeded');
    expect(result.subagent_results[0].tainted).toBe(true);
  });

  it('taint flag and provenance propagate to parent observations', () => {
    const result = spawn_subagents({
      goal: 'p',
      subtasks: [{ goal: 's', success_criteria: ['ok'] }],
      aggregation_strategy: 'all_mandatory',
      parent_trace_id: 'trace-xyz',
    });
    expect(result.subagent_results[0].tainted).toBe(true);
    expect(result.subagent_results[0].provenance).toContain('parent:trace-xyz');
  });

  it('recursion depth cap prevents infinite delegation', () => {
    const result = spawn_subagents({
      goal: 'deep',
      subtasks: [{ goal: 'sub', success_criteria: ['x'] }],
      aggregation_strategy: 'all_mandatory',
      max_depth: 5,
    }, MAX_DEPTH);
    expect(result.overall_status).toBe('policy_blocked');
  });

  it('result aggregation blocks final_answer unless all mandatory sub-criteria pass', () => {
    const result = spawn_subagents({
      goal: 'agg',
      subtasks: [{ goal: 'm', success_criteria: ['must'] }],
      aggregation_strategy: 'all_mandatory',
    });
    expect(result.aggregated_answer).not.toBeNull();
  });

  it('sub-agent cannot access parent memory scope or exceed parent egress limits', () => {
    const result = spawn_subagents({
      goal: 'iso',
      subtasks: [{ goal: 'w', success_criteria: [] }],
      aggregation_strategy: 'first_valid',
    });
    expect(result.subagent_results.length).toBe(1);
    expect(result.subagent_results[0].tainted).toBe(true);
  });

  it('policy_blocked sub-agent returns structured failure without retry in parent', () => {
    const result = spawn_subagents({
      goal: 'block',
      subtasks: [{ goal: 'b', success_criteria: ['f'] }],
      aggregation_strategy: 'all_mandatory',
    }, MAX_DEPTH);
    expect(result.overall_status).toBe('policy_blocked');
  });
});
