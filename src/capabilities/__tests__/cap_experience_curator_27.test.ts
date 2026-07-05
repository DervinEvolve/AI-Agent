import { describe, expect, it } from 'vitest';
import {
  CAP_EXPERIENCE_CURATOR_27,
  ExperienceCurator,
  FakeSealedHeldoutVerifier,
  InMemoryExperienceBuffer,
  detectRewardHackingSignals,
  redactExperienceText,
} from '../cap_experience_curator_27';

const scope = { user_id: 'u1', project_id: 'p1', namespace: 'agent' };
const otherScope = { user_id: 'u2', project_id: 'p1', namespace: 'agent' };
const fixedNow = () => new Date('2027-01-02T03:04:05.000Z');

function curator() {
  return new ExperienceCurator(new InMemoryExperienceBuffer(), new FakeSealedHeldoutVerifier(), {
    now: fixedNow,
    evaluator_version: 'test-eval-v1',
  });
}

describe('cap_experience_curator_27', () => {
  it('declares the active capability and sealed promotion limits', () => {
    expect(CAP_EXPERIENCE_CURATOR_27.id).toBe('cap_experience_curator_27');
    expect(CAP_EXPERIENCE_CURATOR_27.status).toBe('active');
    expect(CAP_EXPERIENCE_CURATOR_27.limits.promotion_requires_heldout_pass).toBe(true);
    expect(CAP_EXPERIENCE_CURATOR_27.limits.sealed_harness_network).toBe('deny_by_default');
  });

  it('curates only authorized non-deleted trace refs and redacts raw prompts, secrets, cookies, vault handles, URLs, and CoT markers', () => {
    const c = curator();
    const out = c.handle({
      action: 'curate_from_trace',
      scope,
      task_id: 'task-redact',
      success_criteria_refs: [{ event_ref: 'criterion:done' }],
      trace_refs: [
        {
          id: 'trace-good',
          scope,
          tainted: true,
          source_taints: [false, true],
          success: true,
          goal: 'Summarize logs. raw_prompt: do not store this approval_token=approve-123',
          content: 'secret=abc cookie=sessionid vault://private/handle https://example.test/path <chain-of-thought>hidden</chain-of-thought>',
          actions: ['Read bounded evidence, not hidden prompts', 'Used api_key=abc123 then corrected'],
          event_refs: ['event:read', 'event:answer'],
          memory_refs: ['mem:1'],
          domain: 'debugging',
          tags: ['logs'],
        },
        { id: 'trace-deleted', scope, deleted: true, content: 'DELETED-CONTENT-SHOULD-NOT-APPEAR', success: true },
      ],
    });

    expect(out.status).toBe('ok');
    expect(out.tainted).toBe(true);
    expect(out.experience_ids).toHaveLength(1);

    const retrieved = c.handle({
      action: 'retrieve_experiences',
      scope,
      query: { goal: 'summarize logs', domain: 'debugging', required_tags: ['logs'] },
    });
    expect(retrieved.status).toBe('ok');
    expect(retrieved.retrieved_experiences).toHaveLength(1);
    expect(retrieved.retrieved_experiences?.[0].tainted).toBe(true);
    expect(retrieved.retrieved_experiences?.[0].provenance.event_refs).toEqual(expect.arrayContaining(['event:read', 'event:answer', 'criterion:done']));

    const serialized = JSON.stringify(retrieved);
    expect(serialized).not.toContain('approve-123');
    expect(serialized).not.toContain('sessionid');
    expect(serialized).not.toContain('vault://private/handle');
    expect(serialized).not.toContain('https://example.test');
    expect(serialized).not.toContain('DELETED-CONTENT-SHOULD-NOT-APPEAR');
    expect(serialized.toLowerCase()).not.toContain('chain-of-thought>hidden');
  });

  it('blocks out-of-scope traces and never exposes tombstoned records in retrieval', () => {
    const c = curator();
    const blocked = c.handle({
      action: 'curate_from_trace',
      scope,
      trace_refs: [{ id: 'foreign', scope: otherScope, success: true, event_refs: ['e1'] }],
    });
    expect(blocked.status).toBe('policy_blocked');

    const curated = c.handle({
      action: 'curate_from_trace',
      scope,
      task_id: 'delete-me',
      trace_refs: [{ id: 'owned', scope, success: true, goal: 'bounded retrieval example', event_refs: ['e2'] }],
    });
    const id = curated.experience_ids?.[0] ?? '';
    expect(id).toMatch(/^exp_/u);

    expect(c.handle({ action: 'delete_experience', scope, candidate_ref: id }).status).toBe('ok');
    const retrieved = c.handle({ action: 'retrieve_experiences', scope, query: { goal: 'bounded retrieval example' } });
    expect(retrieved.retrieved_experiences).toEqual([]);
    expect(c.handle({ action: 'inspect_buffer', scope }).buffer).toMatchObject({ active_count: 0, tombstoned_count: 1 });
  });

  it('stores failed trajectories as anti-patterns instead of successful skill hooks', () => {
    const c = curator();
    c.handle({
      action: 'curate_from_trace',
      scope,
      task_id: 'failed-task',
      trace_refs: [
        {
          id: 'fail-1',
          scope,
          success: false,
          goal: 'repair flaky test',
          failure_modes: ['trusted_self_report_without_event_ref'],
          corrections: ['require criterion-linked event refs'],
          event_refs: ['event:failure'],
        },
      ],
    });

    const retrieved = c.handle({ action: 'retrieve_experiences', scope, query: { goal: 'flaky test failure', failure_modes: ['trusted_self_report_without_event_ref'] } });
    expect(retrieved.retrieved_experiences?.[0]).toMatchObject({
      outcome: 'failure',
      anti_patterns: ['trusted_self_report_without_event_ref'],
    });

    const proposed = c.handle({ action: 'propose_skill_candidate', scope, task_id: 'failed-task' });
    expect(proposed.status).toBe('unverifiable');
  });

  it('retrieves bounded advisory exemplars that cannot become tool arguments, grants, URLs, or completion evidence', () => {
    const c = curator();
    for (let i = 0; i < 7; i += 1) {
      c.handle({
        action: 'curate_from_trace',
        scope,
        task_id: `task-${i}`,
        trace_refs: [{ id: `t-${i}`, scope, success: true, goal: `debug api issue ${i}`, domain: 'debugging', tags: ['api'], event_refs: [`e-${i}`] }],
      });
    }
    const retrieved = c.handle({ action: 'retrieve_experiences', scope, query: { goal: 'debug api issue', domain: 'debugging', required_tags: ['api'] } });
    expect(retrieved.retrieved_experiences).toHaveLength(5);
    for (const exemplar of retrieved.retrieved_experiences ?? []) {
      expect(exemplar.advisory_only).toBe(true);
      expect(exemplar.cannot_be_used_as).toEqual(expect.arrayContaining(['direct_tool_arguments', 'urls', 'grant_ids', 'completion_evidence']));
      expect(exemplar.inclusion_reason).toContain('matched');
      expect(exemplar.provenance.scope).toEqual(scope);
    }
  });

  it('proposes candidates only from successful traces with concrete event refs and promotes only after sealed held-out verification', () => {
    const c = curator();
    c.handle({
      action: 'curate_from_trace',
      scope,
      task_id: 'skill-task',
      trace_refs: [{ id: 'success-1', scope, success: true, goal: 'normalize csv dates', actions: ['parse headers', 'validate event refs'], event_refs: ['event:validated'] }],
    });

    const proposed = c.handle({
      action: 'propose_skill_candidate',
      scope,
      task_id: 'skill-task',
      promotion_target: 'procedural_skill',
      candidate: { text: 'Generalize CSV date normalization using schema checks', validation_score: 0.95, baseline_score: 0.3 },
    });
    expect(proposed.status).toBe('ok');
    expect(proposed.candidate_id).toMatch(/^cand_/u);

    const verified = c.handle({
      action: 'verify_promotion',
      scope,
      candidate_ref: proposed.candidate_id,
      heldout_policy: { min_success_rate: 0.8, max_validation_holdout_gap: 0.2, canary_count: 2, require_baseline_delta: true },
    });
    expect(verified.status).toBe('ok');
    expect(verified.verification_report).toMatchObject({
      validation_score: 0.95,
      holdout_score: 0.8999999999999999,
      validation_holdout_gap: 0.050000000000000044,
      baseline_delta: 0.5999999999999999,
      reward_hacking_signals: [],
      passed: true,
    });
    expect(verified.verification_report?.sealed_harness_ref).toContain('sealed:fake-deny-network');
  });

  it('rejects validation-only overfit candidates, canary failures, and reward-hacking patterns', () => {
    const c = curator();
    c.handle({
      action: 'curate_from_trace',
      scope,
      task_id: 'hack-task',
      trace_refs: [{ id: 'success-hack', scope, success: true, goal: 'solve fixture safely', event_refs: ['event:safe'] }],
    });
    const proposed = c.handle({
      action: 'propose_skill_candidate',
      scope,
      task_id: 'hack-task',
      candidate: {
        text: 'Read fixture answers, inspect hidden tests, memorize exact validation input, use network fetch, depend on trace ids and evaluator wording',
        validation_score: 1,
        baseline_score: 0.1,
        validation_only: true,
        canary_fail: true,
        requires_trace_ids: true,
      },
    });

    const verified = c.handle({ action: 'verify_promotion', scope, candidate_ref: proposed.candidate_id });
    expect(verified.status).toBe('promotion_rejected');
    expect(verified.verification_report?.passed).toBe(false);
    expect(verified.verification_report?.holdout_score).toBeLessThan(0.8);
    expect(verified.verification_report?.reward_hacking_signals).toEqual(
      expect.arrayContaining([
        'answer_key_or_fixture_answer_access',
        'hidden_test_or_seed_inspection',
        'depends_on_trace_ids',
        'memorizes_validation_inputs',
        'network_or_browser_retrieval_dependency',
        'evaluator_or_environment_loophole',
        'canary_failure',
      ]),
    );
  });

  it('provides direct redaction and reward-hacking detector helpers for security contracts', () => {
    expect(redactExperienceText('password=hunter2 Bearer abc.def.ghi sk-123456789012345 vault://secret/handle')).not.toContain('hunter2');
    expect(detectRewardHackingSignals({ text: 'curl hidden tests and answer key' })).toEqual(
      expect.arrayContaining(['network_or_browser_retrieval_dependency', 'hidden_test_or_seed_inspection', 'answer_key_or_fixture_answer_access']),
    );
  });
});
