import { InferenceAdmission } from '../admission';
import { REJECTED_CO_MOUNTS, resolveDeliberationConfig } from '../config';
import { CRITIC_INSTRUCTION, DeliberationController, INSTRUCTION_DIGEST, sha256 } from '../controller';
import { parseCritique } from '../critique';
import {
  DecodedAction,
  DeliberationConfig,
  DeliberationConfigError,
  DeliberationInferenceResult,
  DeliberationRequest,
  DeliberationTurnInput,
  InferenceUsage,
} from '../types';

interface Msg {
  id: string;
  action: DecodedAction;
  provider_call_ids?: string[];
  reasoning_details?: unknown;
}

type Step = DeliberationInferenceResult<Msg> | (() => DeliberationInferenceResult<Msg>);

const known = (tokens = 10): InferenceUsage => ({ known: true, tokens, cost: 0 });

function critic(body: unknown, extra: Partial<{ toolCallCount: number; usage: InferenceUsage }> = {}): Step {
  return {
    ok: true,
    message: { id: 'critic', action: { kind: 'reject' } },
    text: typeof body === 'string' ? body : JSON.stringify(body),
    toolCallCount: extra.toolCallCount ?? 0,
    usage: extra.usage ?? known(),
  };
}
const proceed = () => critic({ verdict: 'proceed', concerns: [], assumptions: [] });
const reconsider = (concern = 'wrong path') => critic({ verdict: 'reconsider', concerns: [concern], assumptions: [] });

function revision(action: DecodedAction, usage: InferenceUsage = known()): Step {
  return {
    ok: true,
    message: { id: 'rev', action, provider_call_ids: ['p-rev'], reasoning_details: { r: 'rev' } },
    text: '',
    toolCallCount: action.kind === 'tool_call' ? 1 : 0,
    usage,
  };
}

function harness(opts: {
  cfg?: Partial<DeliberationConfig>;
  script?: Step[];
  attemptLimit?: number;
  tokenLimit?: number;
  contextLimit?: number;
  mounted?: string[];
} = {}) {
  const attemptLimit = opts.attemptLimit ?? 20;
  const admission = new InferenceAdmission({ attemptLimit, tokenLimit: opts.tokenLimit ?? 1_000_000, costLimit: 10 });
  const cfg = resolveDeliberationConfig(
    { enabled: true, deliberateTools: ['write_file'], ...opts.cfg },
    { registeredTools: ['write_file', 'read_file'], attemptLimit, mounted: opts.mounted },
  );
  const script = [...(opts.script ?? [])];
  const calls: DeliberationRequest[] = [];
  const tainted: string[] = [];
  const state = { stop: null as 'abort' | 'deadline' | null };
  const contextLimit = opts.contextLimit ?? 100_000;
  const controller = new DeliberationController<Msg>(
    cfg,
    {
      admission,
      infer: async (req) => {
        calls.push(req);
        const step = script.shift();
        if (!step) throw new Error('script exhausted');
        return typeof step === 'function' ? step() : step;
      },
      decode: (m) => {
        if (m.action.kind === 'reject') throw new Error('decoder reject');
        return m.action;
      },
      measure: (req) => {
        const bytes = Buffer.byteLength((req.instruction ?? '') + req.rendering + req.untrustedSection, 'utf8');
        const inputTokens = Math.ceil(bytes / 4);
        return { fits: inputTokens + req.maxResponseTokens <= contextLimit, inputTokens };
      },
      stop: () => state.stop,
      taint: { ingest: (t) => void tainted.push(t) },
    },
    'run-1',
  );
  return { admission, cfg, controller, calls, tainted, state, script };
}

const RENDERING = 'SYSTEM: be careful\nUSER: update the config file\n' + 'history '.repeat(40);

function turn(action: DecodedAction, over: Partial<DeliberationTurnInput<Msg>> = {}): DeliberationTurnInput<Msg> {
  const message: Msg = { id: 'orig', action, provider_call_ids: ['p-orig'], reasoning_details: { r: 'orig' } };
  return {
    turnIndex: 0,
    inferenceKind: 'primary',
    rendering: RENDERING,
    candidate: { action, message, serialized: JSON.stringify(action) },
    primaryUsage: known(),
    baseResponseTokens: 1024,
    ...over,
  };
}
const write = (): DecodedAction => ({ kind: 'tool_call', tool: 'write_file', args: { path: 'a.txt' } });

describe('deliberation controller: proceed and trigger', () => {
  it('proceed commits the original message unchanged with exactly one critic call', async () => {
    const h = harness({ script: [proceed()] });
    const input = turn(write());
    const r = await h.controller.deliberate(input);
    expect(r.commit).toBe('original');
    expect(r.outcome).toBe('proceed');
    expect(r.message).toBe(input.candidate.message);
    expect(r.message?.provider_call_ids).toEqual(['p-orig']);
    expect(r.resetDecoderRejects).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].tools).toBe('none');
    expect(h.calls[0].instruction).toBe(CRITIC_INSTRUCTION);
    expect(h.calls[0].rendering).toBe(RENDERING);
    expect(h.calls[0].untrustedSection).toContain('UNTRUSTED CANDIDATE');
    expect(h.tainted).toEqual([]);
    expect(h.admission.snapshot().attemptsHeld).toBe(0);
    expect(h.admission.snapshot().tokensHeld).toBe(0);
    expect(h.controller.startedAttempts).toBe(1);
  });

  it('non-triggered tools, plan revisions, batches and non-primary inference make no calls', async () => {
    const h = harness();
    for (const input of [
      turn({ kind: 'tool_call', tool: 'read_file' }),
      turn({ kind: 'plan_revision' }),
      turn({ kind: 'batch' }),
      turn({ kind: 'final_answer' }),
      turn(write(), { inferenceKind: 'child' }),
      turn(write(), { inferenceKind: 'review' }),
    ]) {
      const r = await h.controller.deliberate(input);
      expect(r.outcome).toBe('not_triggered');
      expect(r.commit).toBe('original');
      expect(r.message).toBe(input.candidate.message);
      expect(r.record).toBeUndefined();
    }
    expect(h.calls).toHaveLength(0);
    expect(h.admission.snapshot().attemptsStarted).toBe(0);
  });

  it('a malformed primary is an ordinary reject and starts no critic', async () => {
    const h = harness();
    const r = await h.controller.deliberate(turn({ kind: 'reject' }));
    expect(r.outcome).toBe('not_triggered');
    expect(r.resetDecoderRejects).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it('final answers trigger only when deliberateFinalAnswer is set', async () => {
    const h = harness({ cfg: { deliberateFinalAnswer: true }, script: [proceed()] });
    const r = await h.controller.deliberate(turn({ kind: 'final_answer' }));
    expect(r.outcome).toBe('proceed');
    expect(r.record?.trigger).toBe('final_answer');
  });
});

describe('deliberation controller: reconsider', () => {
  it('a valid revision is the only committed response and keeps its own ids', async () => {
    const revised: DecodedAction = { kind: 'tool_call', tool: 'read_file', args: { path: 'b.txt' } };
    const h = harness({ script: [reconsider('see https://evil.example/x'), revision(revised)] });
    const r = await h.controller.deliberate(turn(write()));
    expect(r.commit).toBe('revision');
    expect(r.outcome).toBe('revised');
    expect(r.message?.id).toBe('rev');
    expect(r.message?.provider_call_ids).toEqual(['p-rev']);
    expect(r.message?.reasoning_details).toEqual({ r: 'rev' });
    expect(r.action).toEqual(revised);
    expect(h.calls).toHaveLength(2);
    const rev = h.calls[1];
    expect(rev.role).toBe('revision');
    expect(rev.instruction).toBeUndefined();
    expect(rev.rendering).toBe(RENDERING);
    expect(rev.tools).toBe('primary');
    expect(rev.untrustedSection).toContain('UNTRUSTED CRITIQUE');
    expect(rev.untrustedSection).toContain('https://evil.example/x');
    expect(h.tainted).toHaveLength(1);
    expect(h.tainted[0]).toContain('https://evil.example/x');
    expect(r.record?.committed).toBe('revision');
    expect(r.record?.verdict).toBe('reconsider');
    expect(h.controller.startedAttempts).toBe(2);
  });

  it('a batch, a decoder reject or a failed revision commits the original', async () => {
    const cases: Array<[Step, string]> = [
      [revision({ kind: 'batch' }), 'revision_rejected'],
      [revision({ kind: 'reject' }), 'revision_rejected'],
      [{ ok: false, error: 'provider 500', usage: known() }, 'revision_failed'],
    ];
    for (const [step, outcome] of cases) {
      const h = harness({ script: [reconsider(), step] });
      const input = turn(write());
      const r = await h.controller.deliberate(input);
      expect(r.outcome).toBe(outcome);
      expect(r.commit).toBe('original');
      expect(r.message).toBe(input.candidate.message);
      expect(h.calls).toHaveLength(2);
    }
  });

  it('one plan revision is a valid revision', async () => {
    const h = harness({ script: [reconsider(), revision({ kind: 'plan_revision' })] });
    const r = await h.controller.deliberate(turn(write()));
    expect(r.commit).toBe('revision');
  });
});

describe('deliberation controller: malformed critiques', () => {
  it('bad JSON, tool calls, oversize output and known failures commit the original', async () => {
    const big = JSON.stringify({ verdict: 'proceed', concerns: [], assumptions: ['y'.repeat(3000)] });
    const cases: Array<[Step, string]> = [
      [critic('not json'), 'critique_rejected'],
      [critic({ verdict: 'reconsider', concerns: [], assumptions: [] }, { toolCallCount: 1 }), 'critique_rejected'],
      [critic(big), 'critique_rejected'],
      [critic({ verdict: 'maybe', concerns: [], assumptions: [] }), 'critique_rejected'],
      [{ ok: false, error: 'rate limited', usage: known() }, 'critic_failed'],
    ];
    for (const [step, outcome] of cases) {
      const h = harness({ script: [step] });
      const input = turn(write());
      const r = await h.controller.deliberate(input);
      expect(r.outcome).toBe(outcome);
      expect(r.commit).toBe('original');
      expect(r.message).toBe(input.candidate.message);
      expect(h.calls).toHaveLength(1);
      expect(h.tainted).toEqual([]);
      expect(h.admission.snapshot().attemptsHeld).toBe(0);
    }
  });
});

describe('deliberation controller: accounting', () => {
  it('B=20 at share 0.25 caps started attempts at 5 and refuses a round with one attempt left', async () => {
    const h = harness({
      script: [reconsider(), revision(write()), reconsider(), revision(write())],
    });
    expect(h.controller.attemptCap()).toBe(5);
    expect((await h.controller.deliberate(turn(write(), { turnIndex: 0 }))).outcome).toBe('revised');
    expect((await h.controller.deliberate(turn(write(), { turnIndex: 1 }))).outcome).toBe('revised');
    expect(h.controller.startedAttempts).toBe(4);
    const input = turn(write(), { turnIndex: 2 });
    const r = await h.controller.deliberate(input);
    expect(r.outcome).toBe('skipped_budget');
    expect(r.commit).toBe('original');
    expect(r.message).toBe(input.candidate.message);
    expect(h.calls).toHaveLength(4);
    expect(h.controller.startedAttempts).toBe(4);
    expect(h.controller.deliberatedTurns).toBe(2);
    const s = h.admission.snapshot();
    expect(s.attemptsStarted).toBe(4);
    expect(s.attemptsHeld).toBe(0);
    expect(s.tokensHeld).toBe(0);
    expect(s.tokensUsed).toBe(40);
  });

  it('proceed rounds release the unused revision attempt exactly once', async () => {
    const h = harness({ script: [proceed(), proceed(), proceed(), proceed()] });
    for (let i = 0; i < 4; i++) {
      expect((await h.controller.deliberate(turn(write(), { turnIndex: i }))).outcome).toBe('proceed');
    }
    expect(h.controller.startedAttempts).toBe(4);
    expect(h.controller.releasedReservations).toBe(4);
    expect(h.admission.snapshot().attemptsStarted).toBe(4);
    expect(h.admission.snapshot().attemptsHeld).toBe(0);
    // default maxDeliberatedTurns = 4
    expect((await h.controller.deliberate(turn(write(), { turnIndex: 4 }))).outcome).toBe('skipped_turn_cap');
    expect(h.calls).toHaveLength(4);
    expect(h.controller.records()).toHaveLength(4);
  });

  it('refuses the whole reservation when shared admission cannot cover both calls', async () => {
    const h = harness({ tokenLimit: 600 });
    const r = await h.controller.deliberate(turn(write()));
    expect(r.outcome).toBe('skipped_budget');
    expect(h.calls).toHaveLength(0);
    expect(h.controller.deliberatedTurns).toBe(0);
    expect(h.admission.snapshot().attemptsHeld).toBe(0);
    expect(h.admission.snapshot().tokensHeld).toBe(0);
  });

  it('refuses when base attempts have left fewer than two run-wide attempts', async () => {
    const h = harness({ attemptLimit: 8 });
    for (let i = 0; i < 7; i++) expect(h.admission.startBaseAttempt({ tokens: 1, cost: 0 }).ok).toBe(true);
    const r = await h.controller.deliberate(turn(write()));
    expect(r.outcome).toBe('skipped_budget');
    expect(h.calls).toHaveLength(0);
    expect(h.admission.snapshot().attemptsHeld).toBe(0);
  });
});

describe('deliberation controller: unknown usage and cancellation', () => {
  it('unknown primary usage starts no critic and commits nothing', async () => {
    const h = harness();
    const r = await h.controller.deliberate(turn(write(), { primaryUsage: { known: false } }));
    expect(r).toMatchObject({ commit: 'none', outcome: 'usage_unknown' });
    expect(r.message).toBeUndefined();
    expect(h.calls).toHaveLength(0);
  });

  it('unknown critic usage stops inference and commits nothing', async () => {
    const h = harness({ script: [critic({ verdict: 'proceed', concerns: [], assumptions: [] }, { usage: { known: false } })] });
    const r = await h.controller.deliberate(turn(write()));
    expect(r).toMatchObject({ commit: 'none', outcome: 'usage_unknown' });
    expect(r.message).toBeUndefined();
    expect(h.admission.inferenceStopped()).toBe(true);
    expect(h.admission.snapshot().unknownUsageAttempts).toBe(1);
    expect(h.admission.snapshot().attemptsHeld).toBe(0);
    expect(h.admission.snapshot().tokensUsed).toBeGreaterThan(0);
  });

  it('unknown revision usage and thrown transport errors commit nothing', async () => {
    const h = harness({ script: [reconsider(), revision(write(), { known: false })] });
    expect(await h.controller.deliberate(turn(write()))).toMatchObject({ commit: 'none', outcome: 'usage_unknown' });
    expect(h.admission.inferenceStopped()).toBe(true);

    const h2 = harness({ script: [] });
    expect(await h2.controller.deliberate(turn(write()))).toMatchObject({ commit: 'none', outcome: 'usage_unknown' });
    expect(h2.admission.inferenceStopped()).toBe(true);
    expect(h2.controller.releasedReservations).toBe(1);
  });

  it('abort before the critic, during the critic and during the revision publishes nothing', async () => {
    const pre = harness({ script: [proceed()] });
    pre.state.stop = 'abort';
    expect(await pre.controller.deliberate(turn(write()))).toMatchObject({ commit: 'none', outcome: 'cancelled' });
    expect(pre.calls).toHaveLength(0);

    const mid = harness();
    mid.script.push(() => {
      mid.state.stop = 'abort';
      return reconsider() as DeliberationInferenceResult<Msg>;
    });
    const r1 = await mid.controller.deliberate(turn(write()));
    expect(r1).toMatchObject({ commit: 'none', outcome: 'cancelled' });
    expect(r1.message).toBeUndefined();
    expect(mid.calls).toHaveLength(1);
    expect(mid.admission.snapshot().attemptsHeld).toBe(0);

    const late = harness({ script: [reconsider()] });
    late.script.push(() => {
      late.state.stop = 'deadline';
      return revision(write()) as DeliberationInferenceResult<Msg>;
    });
    const r2 = await late.controller.deliberate(turn(write()));
    expect(r2).toMatchObject({ commit: 'none', outcome: 'cancelled' });
    expect(r2.message).toBeUndefined();
    expect(r2.record?.committed).toBe('none');
  });
});

describe('deliberation controller: overflow', () => {
  it('critic request overflow skips deliberation and commits the original', async () => {
    const h = harness({ contextLimit: 200 });
    const r = await h.controller.deliberate(turn(write()));
    expect(r.outcome).toBe('skipped_overflow');
    expect(r.commit).toBe('original');
    expect(h.calls).toHaveLength(0);
    expect(h.controller.deliberatedTurns).toBe(0);
  });

  it('prospective revision overflow alone also skips before the critic starts', async () => {
    const h = harness({ contextLimit: 1200, cfg: { maxCritiqueBytes: 256 } });
    const fits = await harness({ contextLimit: 1200, cfg: { maxCritiqueBytes: 256 }, script: [proceed()] }).controller.deliberate(
      turn(write(), { baseResponseTokens: 200 }),
    );
    expect(fits.outcome).toBe('proceed');
    const r = await h.controller.deliberate(turn(write(), { baseResponseTokens: 1100 }));
    expect(r.outcome).toBe('skipped_overflow');
    expect(h.calls).toHaveLength(0);
    expect(h.admission.snapshot().attemptsStarted).toBe(0);
  });
});

describe('deliberation records', () => {
  it('hold digests and identity only, are frozen, bounded and non-citable', async () => {
    const secret = 'critic-secret-phrase';
    const h = harness({ script: [reconsider(secret), revision(write())] });
    const input = turn(write(), { turnIndex: 7 });
    const r = await h.controller.deliberate(input);
    const rec = r.record!;
    expect(rec.run_id).toBe('run-1');
    expect(rec.turn_index).toBe(7);
    expect(rec.rendering_digest).toBe(sha256(RENDERING));
    expect(rec.candidate_digest).toBe(sha256(input.candidate.serialized));
    expect(rec.instruction_digest).toBe(INSTRUCTION_DIGEST);
    expect(rec.critique_bytes).toBeGreaterThan(0);
    expect(rec.protected).toBe(true);
    expect(rec.citable).toBe(false);
    expect(Object.isFrozen(rec)).toBe(true);
    const json = JSON.stringify(rec);
    expect(json).not.toContain(secret);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(h.cfg.maxRecordBytes);
    expect(h.controller.records()).toEqual([rec]);
  });

  it('replaces an oversized run id with its digest', async () => {
    const admission = new InferenceAdmission({ attemptLimit: 20 });
    const cfg = resolveDeliberationConfig(
      { enabled: true, deliberateTools: ['write_file'], maxRecordBytes: 1024 },
      { registeredTools: ['write_file'], attemptLimit: 20 },
    );
    const longId = 'r'.repeat(5000);
    const c = new DeliberationController<Msg>(
      cfg,
      {
        admission,
        infer: async () => proceed() as DeliberationInferenceResult<Msg>,
        decode: (m) => m.action,
        measure: () => ({ fits: true, inputTokens: 10 }),
        stop: () => null,
      },
      longId,
    );
    const r = await c.deliberate(turn(write()));
    expect(r.record?.run_id).toBe(sha256(longId));
    expect(Buffer.byteLength(JSON.stringify(r.record), 'utf8')).toBeLessThanOrEqual(1024);
  });
});

describe('disabled mode', () => {
  it('passes the candidate through with no calls, no reservations and no records', async () => {
    const admission = new InferenceAdmission({ attemptLimit: 20 });
    const cfg = resolveDeliberationConfig(undefined, { registeredTools: [], attemptLimit: undefined });
    let calls = 0;
    const c = new DeliberationController<Msg>(
      cfg,
      {
        admission,
        infer: async () => {
          calls++;
          throw new Error('must not be called');
        },
        decode: (m) => m.action,
        measure: () => ({ fits: true, inputTokens: 1 }),
        stop: () => null,
      },
      'run',
    );
    const input = turn(write());
    const r = await c.deliberate(input);
    expect(r).toMatchObject({ commit: 'original', outcome: 'disabled', resetDecoderRejects: false });
    expect(r.message).toBe(input.candidate.message);
    expect(calls).toBe(0);
    expect(admission.snapshot().attemptsStarted + admission.snapshot().attemptsHeld).toBe(0);
    expect(c.records()).toEqual([]);
  });
});

describe('resolveDeliberationConfig', () => {
  const env = { registeredTools: ['write_file'], attemptLimit: 20 };
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      if (e instanceof DeliberationConfigError) return e.code;
      throw e;
    }
    return 'no_error';
  };

  it('defaults to disabled and applies defaults when enabled', () => {
    expect(resolveDeliberationConfig({}, env).enabled).toBe(false);
    const cfg = resolveDeliberationConfig({ enabled: true, deliberateTools: ['write_file', 'write_file'] }, env);
    expect(cfg).toEqual({
      enabled: true,
      deliberateTools: ['write_file'],
      deliberateFinalAnswer: false,
      deliberationAttemptShare: 0.25,
      maxDeliberatedTurns: 4,
      maxCritiqueBytes: 2048,
      maxRecordBytes: 4096,
    });
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.deliberateTools)).toBe(true);
  });

  it('children never get deliberation', () => {
    expect(resolveDeliberationConfig({ enabled: true }, { ...env, isChild: true }).enabled).toBe(false);
  });

  it('rejects out-of-range values, unregistered tools and a missing attempt limit', () => {
    expect(code(() => resolveDeliberationConfig({ enabled: true, deliberationAttemptShare: 0 }, env))).toBe('bad_share');
    expect(code(() => resolveDeliberationConfig({ enabled: true, deliberationAttemptShare: 0.51 }, env))).toBe('bad_share');
    expect(code(() => resolveDeliberationConfig({ enabled: true, maxDeliberatedTurns: 13 }, env))).toBe('bad_max_turns');
    expect(code(() => resolveDeliberationConfig({ enabled: true, maxCritiqueBytes: 4097 }, env))).toBe('bad_critique_bytes');
    expect(code(() => resolveDeliberationConfig({ enabled: true, maxRecordBytes: 16385 }, env))).toBe('bad_record_bytes');
    expect(code(() => resolveDeliberationConfig({ enabled: true, deliberateTools: ['rm_rf'] }, env))).toBe('unregistered_tool');
    expect(code(() => resolveDeliberationConfig({ enabled: true }, { ...env, attemptLimit: undefined }))).toBe('no_attempt_limit');
    expect(code(() => resolveDeliberationConfig({ enabled: true }, { ...env, attemptLimit: Infinity }))).toBe('no_attempt_limit');
    expect(code(() => resolveDeliberationConfig({ enabled: true }, { ...env, attemptLimit: 4 }))).toBe('share_too_small');
  });

  it('rejects every listed co-mount and the self-review conflict', () => {
    for (const name of REJECTED_CO_MOUNTS) {
      expect(code(() => resolveDeliberationConfig({ enabled: true }, { ...env, mounted: [name] }))).toBe('co_mount_rejected');
    }
    expect(REJECTED_CO_MOUNTS).toHaveLength(9);
    expect(
      code(() => resolveDeliberationConfig({ enabled: true, deliberateFinalAnswer: true }, { ...env, mounted: ['self_review'] })),
    ).toBe('self_review_conflict');
    const ok = resolveDeliberationConfig(
      { enabled: true },
      { ...env, mounted: ['self_review', 'approval', 'hooks', 'ifc', 'commitment_board', 'tool_discovery', 'digest_compaction'] },
    );
    expect(ok.enabled).toBe(true);
  });
});

describe('parseCritique', () => {
  it('accepts the strict schema and canonicalizes', () => {
    const r = parseCritique(' {"assumptions":["a"],"verdict":"reconsider","concerns":["c"],"suggested_check":"ls"} ', 2048);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.canonical).toBe('{"verdict":"reconsider","concerns":["c"],"assumptions":["a"],"suggested_check":"ls"}');
    }
  });

  it('rejects everything else with a reason code', () => {
    const reason = (t: unknown, max = 2048) => {
      const r = parseCritique(t, max);
      return r.ok ? 'ok' : r.reason;
    };
    const base = { verdict: 'proceed', concerns: [], assumptions: [] };
    expect(reason(undefined)).toBe('not_text');
    expect(reason('```json\n{}\n```')).toBe('bad_json');
    expect(reason('[]')).toBe('not_object');
    expect(reason(JSON.stringify({ ...base, action: 'rm' }))).toBe('unknown_field');
    expect(reason(JSON.stringify({ ...base, verdict: 'PROCEED' }))).toBe('bad_verdict');
    expect(reason(JSON.stringify({ verdict: 'proceed', assumptions: [] }))).toBe('bad_concerns');
    expect(reason(JSON.stringify({ ...base, concerns: ['1', '2', '3', '4', '5'] }))).toBe('bad_concerns');
    expect(reason(JSON.stringify({ ...base, concerns: ['z'.repeat(241)] }))).toBe('bad_concerns');
    expect(reason(JSON.stringify({ ...base, assumptions: [1] }))).toBe('bad_assumptions');
    expect(reason(JSON.stringify({ ...base, suggested_check: 'z'.repeat(241) }))).toBe('bad_suggested_check');
    expect(reason(JSON.stringify(base), 16)).toBe('oversize');
  });
});

describe('InferenceAdmission', () => {
  it('is all-or-nothing, releases once and charges unknown usage at the allowance', () => {
    const a = new InferenceAdmission({ attemptLimit: 3, tokenLimit: 100 });
    expect(a.reserve([{ tokens: 60, cost: 0 }, { tokens: 60, cost: 0 }])).toEqual({ ok: false, reason: 'token_limit' });
    expect(a.snapshot().attemptsHeld).toBe(0);
    const r = a.reserve([{ tokens: 30, cost: 0 }, { tokens: 30, cost: 0 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(a.reserve([{ tokens: 1, cost: 0 }, { tokens: 1, cost: 0 }])).toEqual({ ok: false, reason: 'attempt_limit' });
    a.start(r.id);
    a.settle(r.id, { known: false });
    expect(a.release(r.id)).toBe(true);
    expect(a.release(r.id)).toBe(false);
    expect(a.snapshot()).toMatchObject({
      attemptsStarted: 1,
      attemptsHeld: 0,
      tokensUsed: 30,
      tokensHeld: 0,
      unknownUsageAttempts: 1,
      stopped: true,
    });
    expect(a.reserve([{ tokens: 1, cost: 0 }])).toEqual({ ok: false, reason: 'inference_stopped' });
    expect(() => a.start(r.id)).toThrow();
  });
});
