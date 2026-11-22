import { describe, expect, it } from 'vitest';
import {
  AdapterResult,
  ChildInvocation,
  ContextManager,
  ModelAdapter,
  ModelRouter,
  ModelRouterConfig,
  ParentInvocation,
  RenderedRequest,
  ReviewInvocation,
  RouterInvocation,
  SharedAdmissionGate,
  TierConfig,
  Usage,
} from '../cap_model_router_50';

class EchoAdapter implements ModelAdapter {
  readonly id: string;
  readonly provider = 'fixture';
  readonly calls: RenderedRequest[] = [];
  private readonly resultFactory: (request: RenderedRequest, callIndex: number) => AdapterResult;

  constructor(id: string, resultFactory?: (request: RenderedRequest, callIndex: number) => AdapterResult) {
    this.id = id;
    this.resultFactory =
      resultFactory ??
      ((request) => ({
        kind: 'success',
        output: { echoed: request.messages },
        usage: { inputTokens: 1, outputTokens: 1 },
      }));
  }

  async send(request: RenderedRequest): Promise<AdapterResult> {
    const callIndex = this.calls.length;
    this.calls.push(request);
    return this.resultFactory(request, callIndex);
  }
}

class PassthroughContextManager implements ContextManager {
  readonly rendered: RenderedRequest[] = [];
  private readonly overrides = new Map<string, { ok: false; reason: 'context_overflow' | 'continuation_incompatible' | 'render_failed'; message: string }>();

  constructor(private readonly messages: readonly unknown[] = [{ role: 'user', content: 'hello' }]) {}

  skip(tierId: string, reason: 'context_overflow' | 'continuation_incompatible' | 'render_failed'): this {
    this.overrides.set(tierId, { ok: false, reason, message: `${tierId} ${reason}` });
    return this;
  }

  render(invocation: RouterInvocation, tier: TierConfig, attemptOrdinal: number) {
    const override = this.overrides.get(tier.id);
    if (override) {
      return override;
    }
    const request: RenderedRequest = {
      route: invocation.kind === 'parent' ? 'primary' : invocation.kind === 'child' ? 'delegate' : 'review',
      tierId: tier.id,
      adapterId: tier.adapter.id,
      destination: tier.destination,
      attemptToken: `attempt_${attemptOrdinal}`,
      messages: this.messages,
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      reasoningDetails: { summary: [{ type: 'reasoning_text', text: 'preserve me' }] },
    };
    this.rendered.push(request);
    return { ok: true as const, request };
  }
}

class RecordingAdmission implements ContextManager['render'] extends Function {}

function parent(id: string, context: unknown = { task: 'primary' }): ParentInvocation {
  return { kind: 'parent', invocationId: id, context };
}

function child(id: string, childId: string): ChildInvocation {
  return { kind: 'child', invocationId: id, childId, context: { task: 'child' } };
}

function review(id: string): ReviewInvocation {
  return { kind: 'review', invocationId: id, context: { task: 'review' } };
}

function tier(id: string, adapter: ModelAdapter): TierConfig {
  return { id, adapter, destination: `dest-${id}` };
}

function config(
  routes: Partial<Record<'primary' | 'delegate' | 'review', readonly TierConfig[]>>,
  maxFallbackAttempts: Partial<Record<'primary' | 'delegate' | 'review', number>> = {},
): ModelRouterConfig {
  const empty: readonly TierConfig[] = [];
  return {
    routes: {
      primary: routes.primary ?? empty,
      delegate: routes.delegate ?? empty,
      review: routes.review ?? empty,
    },
    maxFallbackAttempts,
  };
}

describe('cap_model_router_50', () => {
  it('routes parent, child, and review invocations to primary, delegate, and review tiers', async () => {
    const primaryAdapter = new EchoAdapter('primary');
    const delegateAdapter = new EchoAdapter('delegate');
    const reviewAdapter = new EchoAdapter('review');
    const router = new ModelRouter(
      config({
        primary: [tier('p', primaryAdapter)],
        delegate: [tier('d', delegateAdapter)],
        review: [tier('r', reviewAdapter)],
      }),
      { contextManager: new PassthroughContextManager(), admission: new SharedAdmissionGate() },
    );

    const parentResult = await router.route(parent('parent-1'));
    const childResult = await router.route(child('child-1', 'subtask-7'));
    const reviewResult = await router.route(review('review-1'));

    expect(parentResult.status).toBe('success');
    if (parentResult.status === 'success') {
      expect(parentResult.route).toBe('primary');
      expect(parentResult.adapterId).toBe('primary');
    }
    expect(childResult.status).toBe('success');
    if (childResult.status === 'success') {
      expect(childResult.route).toBe('delegate');
      expect(childResult.childId).toBe('subtask-7');
      expect(childResult.adapterId).toBe('delegate');
    }
    expect(reviewResult.status).toBe('success');
    if (reviewResult.status === 'success') {
      expect(reviewResult.route).toBe('review');
      expect(reviewResult.adapterId).toBe('review');
    }
    expect(primaryAdapter.calls).toHaveLength(1);
    expect(delegateAdapter.calls).toHaveLength(1);
    expect(reviewAdapter.calls).toHaveLength(1);
  });

  it('falls back on structured transient failures, bounded by maxFallbackAttempts with no wraparound', async () => {
    const first = new EchoAdapter('first', () => ({
      kind: 'transient',
      code: 'http_429',
      message: 'rate limited',
      usage: { inputTokens: 1, outputTokens: 0 },
    }));
    const second = new EchoAdapter('second');
    const router = new ModelRouter(
      config({ primary: [tier('first', first), tier('second', second)] }, { primary: 1 }),
      { contextManager: new PassthroughContextManager(), admission: new SharedAdmissionGate() },
    );

    const result = await router.route(parent('p'));
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.adapterId).toBe('second');
      expect(result.attemptOrdinal).toBe(1);
    }
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);

    const noFallback = new ModelRouter(
      config({ primary: [tier('first', first), tier('second', second)] }, { primary: 0 }),
      { contextManager: new PassthroughContextManager(), admission: new SharedAdmissionGate() },
    );
    const failed = await noFallback.route(parent('p2'));
    expect(failed.status).toBe('failure');
    if (failed.status === 'failure') {
      expect(failed.reason).toBe('model_unavailable');
    }
    expect(first.calls).toHaveLength(2);
    expect(second.calls).toHaveLength(1);
  });

  it('does not fall back on non-transient failures', async () => {
    const first = new EchoAdapter('first', () => ({
      kind: 'failure',
      reason: 'authentication_error',
      message: 'bad key',
    }));
    const second = new EchoAdapter('second');
    const router = new ModelRouter(
      config({ primary: [tier('first', first), tier('second', second)] }, { primary: 1 }),
      { contextManager: new PassthroughContextManager(), admission: new SharedAdmissionGate() },
    );

    const result = await router.route(parent('p'));
    expect(result.status).toBe('failure');
    if (result.status === 'failure') {
      expect(result.reason).toBe('adapter_rejected');
    }
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(0);
  });

  it('opens a circuit after consecutive transient failures and skips it on later invocations', async () => {
    const flaky = new EchoAdapter('flaky', (_request, callIndex) =>
      callIndex === 1
        ? { kind: 'success', output: { ok: true }, usage: { inputTokens: 1, outputTokens: 1 } }
        : { kind: 'transient', code: 'timeout', message: 'slow', usage: { inputTokens: 1 } },
    );
    const backup = new EchoAdapter('backup');
    const router = new ModelRouter(
      config({ primary: [tier('flaky', flaky), tier('backup', backup)] }, { primary: 1 }),
      { contextManager: new PassthroughContextManager(), admission: new SharedAdmissionGate(), createId: () => 'fixed-token' },
    );

    await router.route(parent('p1'));
    await router.route(parent('p2'));
    const third = await router.route(parent('p3'));

    expect(third.status).toBe('success');
    if (third.status === 'success') {
      expect(third.adapterId).toBe('backup');
      expect(third.records.some((record) => record.outcome === 'skipped' && record.skipReason === 'circuit_open')).toBe(true);
    }
    expect(flaky.calls).toHaveLength(2);
    expect(backup.calls).toHaveLength(3);
  });

  it('skips context-incompatible tiers without admission or send', async () => {
    const incompatible = new EchoAdapter('incompatible');
    const good = new EchoAdapter('good');
    const contextManager = new PassthroughContextManager().skip('incompatible', 'context_overflow');
    const admission = new SharedAdmissionGate();
    const router = new ModelRouter(
      config({ primary: [tier('incompatible', incompatible), tier('good', good)] }, { primary: 1 }),
      { contextManager, admission },
    );

    const result = await router.route(parent('p'));
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.adapterId).toBe('good');
    }
    expect(incompatible.calls).toHaveLength(0);
    expect(good.calls).toHaveLength(1);
    expect(result.records.some((record) => record.outcome === 'skipped' && record.skipReason === 'context_overflow')).toBe(true);
  });

  it('blocks all subsequent inference when unknown usage meets an active token cap', async () => {
    const adapter = new EchoAdapter('a');
    const gate = new SharedAdmissionGate({ maxInputTokens: 10 });
    const router = new ModelRouter(
      config({ primary: [tier('a', adapter)] }),
      { contextManager: new PassthroughContextManager(), admission: gate },
    );

    const first = await router.route(parent('p1'), { usageEstimate: { unknown: true } });
    expect(first.status).toBe('failure');
    if (first.status === 'failure') {
      expect(first.reason).toBe('usage_unknown');
    }
    expect(adapter.calls).toHaveLength(0);
    expect(gate.isBlocked()).toBe(true);

    const second = await router.route(parent('p2'), { usageEstimate: { inputTokens: 1, outputTokens: 1 } });
    expect(second.status).toBe('failure');
    if (second.status === 'failure') {
      expect(second.reason).toBe('usage_unknown');
    }
    expect(adapter.calls).toHaveLength(0);
  });

  it('checks cancellation before every send and returns a typed failure', async () => {
    const adapter = new EchoAdapter('a');
    const router = new ModelRouter(
      config({ primary: [tier('a', adapter)] }),
      { contextManager: new PassthroughContextManager(), admission: new SharedAdmissionGate() },
    );

    const result = await router.route(parent('p'), { shouldAbort: () => 'cancelled' });
    expect(result.status).toBe('failure');
    if (result.status === 'failure') {
      expect(result.reason).toBe('cancelled');
    }
    expect(adapter.calls).toHaveLength(0);
  });

  it('preserves canonical tool_call IDs and reasoning_details references on success', async () => {
    const toolCalls = [{ id: 'call_original_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }];
    const reasoningDetails = { summary: [{ type: 'reasoning_text', text: 'keep me' }] };
    const adapter = new EchoAdapter('a', (request) => ({
      kind: 'success',
      output: { ok: true },
      toolCalls,
      reasoningDetails,
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const contextManager = new PassthroughContextManager([{ role: 'user', content: 'hello' }]);
    const router = new ModelRouter(
      config({ primary: [tier('a', adapter)] }),
      { contextManager, admission: new SharedAdmissionGate() },
    );

    const result = await router.route(parent('p'));
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.response.toolCalls).toBe(toolCalls);
      expect(result.response.reasoningDetails).toBe(reasoningDetails);
      expect(result.response.toolCalls?.[0]).toMatchObject({ id: 'call_original_1' });
    }
  });

  it('records route, invocation, child, tier, adapter, destination, and usage-known status', async () => {
    const adapter = new EchoAdapter('a', () => ({
      kind: 'success',
      output: { ok: true },
      usage: { inputTokens: 3, outputTokens: 2 },
    }));
    const router = new ModelRouter(
      config({ delegate: [tier('a', adapter)] }),
      { contextManager: new PassthroughContextManager(), admission: new SharedAdmissionGate() },
    );

    const result = await router.route(child('inv-9', 'child-4'));
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.route).toBe('delegate');
      expect(result.invocationId).toBe('inv-9');
      expect(result.childId).toBe('child-4');
      expect(result.records[0]).toMatchObject({
        route: 'delegate',
        invocationId: 'inv-9',
        childId: 'child-4',
        tierId: 'a',
        adapterId: 'a',
        destination: 'dest-a',
        outcome: 'success',
        usageKnown: true,
      });
    }
  });
});
