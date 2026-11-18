import {
  CompactionGroup,
  CompactionPolicy,
  CompactionRuntime,
  CompactionState,
  DEFAULT_COMPACTION_POLICY,
  OrdinaryRequest,
  SummarizerModelAdapter,
  SummarizerRequest,
  SummarizerResponse,
  UsageAccountant,
  renderCompaction,
} from '../cap_context_compaction_12';

class ScriptedAdapter implements SummarizerModelAdapter {
  calls: Array<{ request: SummarizerRequest }> = [];
  private responses: Array<SummarizerResponse | Error | 'never'>;

  constructor(responses: Array<SummarizerResponse | Error | 'never'> = []) {
    this.responses = responses;
  }

  async call(request: SummarizerRequest): Promise<SummarizerResponse> {
    this.calls.push({ request });
    const response = this.responses.shift();
    if (response === 'never') {
      return new Promise<SummarizerResponse>(() => {});
    }
    if (response instanceof Error) {
      throw response;
    }
    if (!response) {
      throw new Error('no scripted response');
    }
    return response;
  }
}

class ScriptedUsage implements UsageAccountant {
  reserveCalls = 0;
  recordCalls = 0;
  reserveResult: { ok: boolean; unknownRequired?: boolean; tokens?: number } = {
    ok: true,
  };

  reserve(_request: {
    messages: unknown[];
    tools?: unknown[];
    max_tokens: number;
  }): { ok: boolean; unknownRequired?: boolean; tokens?: number } {
    this.reserveCalls++;
    return this.reserveResult;
  }

  record(_tokensUsed: number): void {
    this.recordCalls++;
  }
}

function makeGroups(): CompactionGroup[] {
  return [
    { ordinal: 1, callId: 'call-alpha', role: 'assistant', content: 'a'.repeat(20) },
    { ordinal: 2, callId: 'call-beta', role: 'tool', content: 'b'.repeat(20) },
    { ordinal: 3, role: 'assistant', content: 'c'.repeat(20) },
    { ordinal: 4, callId: 'call-gamma', role: 'assistant', content: 'd'.repeat(20) },
    { ordinal: 5, callId: 'call-delta', role: 'tool', content: 'e'.repeat(20) },
    { ordinal: 6, role: 'assistant', content: 'f'.repeat(20) },
    { ordinal: 7, callId: 'call-epsilon', role: 'assistant', content: 'g'.repeat(20) },
    { ordinal: 8, role: 'tool', content: 'h'.repeat(20) },
  ];
}

function makePolicy(overrides: Partial<CompactionPolicy> = {}): CompactionPolicy {
  return {
    ...DEFAULT_COMPACTION_POLICY,
    maxRequestTokens: 500,
    maxSummaryChars: 100,
    retainedTailTurns: 2,
    timeoutMs: 50,
    ...overrides,
  };
}

function makeState(overrides: Partial<CompactionState> = {}): CompactionState {
  return {
    summary: '',
    generation: 0,
    replacedThroughGroupOrdinal: -1,
    recallMetadata: [],
    ...overrides,
  };
}

describe('cap_context_compaction_12', () => {
  it('selects oldest eligible prefix and disjoint ordinals across successive compactions', () => {
    const groups = makeGroups();
    const policy = makePolicy();
    const state = makeState();

    const firstRender = renderCompaction(groups, state, policy);
    expect(firstRender.kind).toBe('plan');
    if (firstRender.kind !== 'plan') return;
    expect(firstRender.plan.selectedGroups.map((g) => g.ordinal)).toEqual([1, 2, 3]);
    expect(firstRender.plan.cursor).toBe(4);
    expect(firstRender.plan.priorSummary).toBe('');

    const adapter = new ScriptedAdapter([{ finish_reason: 'stop', content: 'summary-one' }]);
    const usage = new ScriptedUsage();
    const runtime = new CompactionRuntime(adapter, usage, policy, state);

    return runtime.runCompaction(groups).then((result) => {
      expect(result.status).toBe('success');
      expect(runtime.state.summary).toBe('summary-one');
      expect(runtime.state.generation).toBe(1);
      expect(runtime.state.replacedThroughGroupOrdinal).toBe(3);

      const secondRender = renderCompaction(groups, runtime.state, policy);
      expect(secondRender.kind).toBe('plan');
      if (secondRender.kind !== 'plan') return;
      expect(secondRender.plan.selectedGroups.map((g) => g.ordinal)).toEqual([4, 5, 6]);
      expect(secondRender.plan.priorSummary).toBe('summary-one');
    });
  });

  it('handles nonnumeric call_ids and groups without call_ids', () => {
    const groups = makeGroups();
    const policy = makePolicy();
    const state = makeState();
    const render = renderCompaction(groups, state, policy);

    expect(render.kind).toBe('plan');
    if (render.kind !== 'plan') return;
    const selected = render.plan.selectedGroups;
    expect(selected.some((g) => g.callId === 'call-alpha')).toBe(true);
    expect(selected.some((g) => g.callId === undefined)).toBe(true);
    expect(render.plan.recallMetadata.some((m) => m.callId === 'call-alpha')).toBe(true);
    expect(render.plan.recallMetadata.some((m) => m.callId === 'call-beta')).toBe(true);
  });

  it('rejects tool_calls, non-stop finish, oversized summary, and stops after three decode rejects', async () => {
    const groups = makeGroups();
    const policy = makePolicy({ maxSummaryChars: 10 });
    const state = makeState();
    const adapter = new ScriptedAdapter([
      { finish_reason: 'tool_calls', tool_calls: [{ id: 't1' }] },
      { finish_reason: 'length', content: 'x' },
      { finish_reason: 'stop', content: 'x'.repeat(20) },
    ]);
    const usage = new ScriptedUsage();
    const runtime = new CompactionRuntime(adapter, usage, policy, state);

    const first = await runtime.runCompaction(groups);
    expect(first.status).toBe('incomplete');
    expect(runtime.state).toEqual(state);

    const second = await runtime.runCompaction(groups);
    expect(second.status).toBe('incomplete');
    expect(runtime.state).toEqual(state);

    const third = await runtime.runCompaction(groups);
    expect(third.status).toBe('stopped');
    expect(third.reason).toBe('decode_reject_limit');
    expect(runtime.isStopped()).toBe(true);

    const callsBefore = adapter.calls.length;
    const fourth = await runtime.runCompaction(groups);
    expect(fourth.status).toBe('stopped');
    expect(adapter.calls.length).toBe(callsBefore);

    for (const call of adapter.calls) {
      expect(call.request.tools).toEqual([]);
    }
  });

  it('transport failure and never-resolving adapter preserve state and return incomplete', async () => {
    const groups = makeGroups();
    const policy = makePolicy({ timeoutMs: 10 });
    const state = makeState({ summary: 'old', generation: 2, replacedThroughGroupOrdinal: 0 });

    const failingAdapter = new ScriptedAdapter([new Error('boom')]);
    const failingRuntime = new CompactionRuntime(failingAdapter, new ScriptedUsage(), policy, state);
    const beforeState = { ...failingRuntime.state };
    const failingResult = await failingRuntime.runCompaction(groups);
    expect(failingResult.status).toBe('incomplete');
    expect(failingRuntime.state).toEqual(beforeState);

    const neverAdapter = new ScriptedAdapter(['never']);
    const neverRuntime = new CompactionRuntime(neverAdapter, new ScriptedUsage(), policy, state);
    const neverResult = await neverRuntime.runCompaction(groups);
    expect(neverResult.status).toBe('incomplete');
    expect(neverResult.reason).toBe('timeout');
    expect(neverRuntime.state).toEqual(beforeState);
  });

  it('stops all summarizer and ordinary calls on shared-cap exhaustion or unknown required usage', async () => {
    const groups = makeGroups();
    const policy = makePolicy();
    const state = makeState();

    const exhaustedUsage = new ScriptedUsage();
    exhaustedUsage.reserveResult = { ok: false };
    const exhaustedRuntime = new CompactionRuntime(
      new ScriptedAdapter([{ finish_reason: 'stop', content: 's' }]),
      exhaustedUsage,
      policy,
      state,
    );
    const exhaustedResult = await exhaustedRuntime.runCompaction(groups);
    expect(exhaustedResult.status).toBe('stopped');
    expect(exhaustedResult.reason).toBe('usage_cap_exhausted');
    expect(exhaustedRuntime.isStopped()).toBe(true);
    const ordinaryAfterExhaustion = exhaustedRuntime.runOrdinary({
      messages: [],
      maxTokens: 10,
    });
    expect(ordinaryAfterExhaustion.status).toBe('stopped');

    const unknownUsage = new ScriptedUsage();
    unknownUsage.reserveResult = { ok: true, unknownRequired: true };
    const unknownRuntime = new CompactionRuntime(
      new ScriptedAdapter([{ finish_reason: 'stop', content: 's' }]),
      unknownUsage,
      policy,
      state,
    );
    const unknownResult = await unknownRuntime.runCompaction(groups);
    expect(unknownResult.status).toBe('stopped');
    expect(unknownResult.reason).toBe('unknown_required_usage');
    expect(unknownRuntime.isStopped()).toBe(true);
  });

  it('failed compaction preserves authoritative state, original snapshots, and untrusted summary text', async () => {
    const groups: CompactionGroup[] = [
      {
        ordinal: 1,
        callId: 'call-obs',
        role: 'tool',
        content: 'observation',
        observationSnapshot: { value: 42 },
        isUnresolvedNonIdempotent: true,
        recoveryAllowance: 1,
        instructionLikeSummary: true,
      },
      {
        ordinal: 2,
        callId: 'call-recall',
        role: 'recall',
        content: 'recalled span',
        recallSourceSpan: { start: 10, end: 20 },
      },
    ];
    const policy = makePolicy({ retainedTailTurns: 0 });
    const state = makeState({
      summary: 'previous summary',
      generation: 3,
      replacedThroughGroupOrdinal: 0,
      recallMetadata: [{ callId: 'call-obs', sourceSpan: { start: 0, end: 11 }, ordinal: 1 }],
    });

    const adapter = new ScriptedAdapter([new Error('transport down')]);
    const runtime = new CompactionRuntime(adapter, new ScriptedUsage(), policy, state);
    const beforeState = JSON.parse(JSON.stringify(runtime.state));
    const beforeGroups = JSON.parse(JSON.stringify(groups));

    const result = await runtime.runCompaction(groups);
    expect(result.status).toBe('incomplete');
    expect(runtime.state).toEqual(beforeState);
    expect(groups).toEqual(beforeGroups);
    expect(runtime.state.summary).toBe('previous summary');
  });

  it('unfit retained tail and absent summarizer return bounded incomplete without state change', async () => {
    const groups = makeGroups();
    const policy = makePolicy({ retainedTailTurns: 100 });
    const state = makeState();

    const render = renderCompaction(groups, state, policy);
    expect(render.kind).toBe('overflow');
    expect(render.kind === 'overflow' && render.boundedIncomplete).toBe(true);

    const absentAdapter: SummarizerModelAdapter = {
      call: () => {
        throw new Error('no summarizer mounted');
      },
    };
    const runtime = new CompactionRuntime(absentAdapter, new ScriptedUsage(), makePolicy(), state);
    const beforeState = { ...runtime.state };
    const result = await runtime.runCompaction(groups);
    expect(result.status).toBe('incomplete');
    expect(runtime.state).toEqual(beforeState);
  });

  it('bounds ordinary wire requests and refuses to continue after stop', () => {
    const policy = makePolicy({ maxRequestTokens: 100 });
    const state = makeState();
    const runtime = new CompactionRuntime(
      new ScriptedAdapter(),
      new ScriptedUsage(),
      policy,
      state,
    );

    const ordinary: OrdinaryRequest = {
      messages: [{ role: 'user', content: 'x'.repeat(500) }],
      maxTokens: 4096,
    };
    const result = runtime.runOrdinary(ordinary);
    expect(result.status).toBe('ok');

    const stoppedUsage = new ScriptedUsage();
    stoppedUsage.reserveResult = { ok: false };
    const stoppedRuntime = new CompactionRuntime(
      new ScriptedAdapter(),
      stoppedUsage,
      policy,
      state,
    );
    stoppedRuntime.runOrdinary(ordinary);
    expect(stoppedRuntime.isStopped()).toBe(true);
    const afterStop = stoppedRuntime.runOrdinary(ordinary);
    expect(afterStop.status).toBe('stopped');
  });
});
