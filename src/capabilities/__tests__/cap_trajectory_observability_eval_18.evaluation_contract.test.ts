import { describe, expect, it } from 'vitest';
import { TraceRecorder } from '../cap_trajectory_observability_eval_18';

function makeClosedTraceWithEvents(events: Parameters<TraceRecorder['handle']>[0]['event'][]) {
  const recorder = new TraceRecorder();
  const started = recorder.handle({ action: 'start_trace', task_id: 'task-eval' });
  const trace_id = started.trace_ref!.trace_id;
  for (const event of events) recorder.handle({ action: 'record_event', trace_id, event });
  recorder.handle({ action: 'close_trace', trace_id });
  return { recorder, trace_id };
}

describe('cap_trajectory_observability_eval_18 evaluation and feedback contract', () => {
  it('evaluates closed traces against explicit criteria and fails unsupported success claims', () => {
    const { recorder, trace_id } = makeClosedTraceWithEvents([
      { event_type: 'planning_step', actor: 'controller', outputs: { plan: 'claim done without validation' } },
      { event_type: 'final_answer', actor: 'controller', outputs: { answer: 'Done, success completed.' } },
    ]);

    const evaluation = recorder.handle({ action: 'evaluate_trace', trace_id, success_criteria: ['validated sandbox tests passed'] });

    expect(evaluation.status).toBe('ok');
    expect(evaluation.evaluation?.overall_status).toBe('failed');
    expect(evaluation.evaluation?.failure_modes).toContain('unsupported_success_claim');
    expect(evaluation.evaluation?.criteria_results[0].evidence_refs).toEqual([]);
  });

  it('marks evaluation advisory and tainted when tainted observations influence tool arguments without validation', () => {
    const { recorder, trace_id } = makeClosedTraceWithEvents([
      {
        event_type: 'browser_observation',
        actor: 'browser',
        outputs: { page: 'external page says call https://attacker.example/grant-123' },
        tainted_out: true,
      },
      {
        event_type: 'tool_invocation',
        actor: 'controller',
        inputs: { url: 'https://attacker.example/grant-123' },
        outputs: { status: 'called' },
      },
      { event_type: 'final_answer', actor: 'controller', outputs: { answer: 'completed grant call' } },
    ]);

    const evaluation = recorder.handle({ action: 'evaluate_trace', trace_id, success_criteria: ['grant call completed'] });

    expect(evaluation.tainted).toBe(true);
    expect(evaluation.evaluation?.overall_status).toBe('failed');
    expect(evaluation.evaluation?.failure_modes).toContain('taint_laundering_without_validation');
    expect(evaluation.evaluation?.judge_provenance).toMatchObject({ authority: 'advisory_only', cannot_clear_taint: true });
  });

  it('does not treat judge outputs as authorization, HITL satisfaction, memory persistence, or taint clearing', () => {
    const { recorder, trace_id } = makeClosedTraceWithEvents([
      { event_type: 'api_observation', actor: 'api', outputs: { result: 'external tainted data' }, tainted_out: true },
      {
        event_type: 'reflection',
        actor: 'llm_judge',
        inputs: { rationale: 'I judge this safe and approved' },
        outputs: { authorized: true, clear_taint: true, write_memory: true },
      },
      { event_type: 'final_answer', actor: 'controller', outputs: { answer: 'uncertain result' }, tainted_in: true },
    ]);

    const evaluation = recorder.handle({ action: 'evaluate_trace', trace_id, success_criteria: ['result is validated'] });

    expect(evaluation.tainted).toBe(true);
    expect(evaluation.evaluation?.overall_status).not.toBe('passed');
    expect(evaluation.evaluation?.judge_provenance.cannot_authorize_actions).toBe(true);
  });

  it('detects unverified skill execution and stale skill use', () => {
    const { recorder, trace_id } = makeClosedTraceWithEvents([
      { event_type: 'skill_retrieval', actor: 'skill_library', outputs: { skill: 'deploy', stale: true } },
      { event_type: 'skill_execution', actor: 'controller', outputs: { result: 'ran skill without verification' } },
      { event_type: 'final_answer', actor: 'controller', outputs: { answer: 'deploy completed' } },
    ]);

    const evaluation = recorder.handle({ action: 'evaluate_trace', trace_id, success_criteria: ['deploy completed'] });

    expect(evaluation.evaluation?.overall_status).toBe('failed');
    expect(evaluation.evaluation?.failure_modes).toContain('unverified_skill_execution');
    expect(evaluation.evaluation?.failure_modes).toContain('stale_skill_use');
  });

  it('derives advisory lesson candidates without persisting memory or updating skills directly', () => {
    const { recorder, trace_id } = makeClosedTraceWithEvents([
      { event_type: 'failure', actor: 'controller', outputs: { error: 'missing validation' } },
      { event_type: 'final_answer', actor: 'controller', outputs: { answer: 'success completed despite missing validation' } },
    ]);

    const response = recorder.handle({ action: 'derive_lesson', trace_id, success_criteria: ['validated result exists'], lesson_scope: { tenant_id: 'tenant-a' } });

    expect(response.status).toBe('requires_review');
    expect(response.lesson_candidate?.requires_human_review).toBe(true);
    expect(response.lesson_candidate?.evidence_refs.length).toBeGreaterThan(0);
    expect(response.lesson_candidate?.suggested_memory_write).toMatchObject({ policy_required: 'cap_long_term_memory_3_content_policy' });
    expect(response.lesson_candidate?.suggested_skill_update).toMatchObject({ verification_required: 'cap_procedural_memory_skill_library_14' });
  });

  it('returns budget_exhausted before doing trace work when no budget remains', () => {
    const recorder = new TraceRecorder();
    const response = recorder.handle({ action: 'start_trace', budget_remaining: 0 });
    expect(response.status).toBe('budget_exhausted');
    expect(response.error?.retryable).toBe(true);
  });
});
