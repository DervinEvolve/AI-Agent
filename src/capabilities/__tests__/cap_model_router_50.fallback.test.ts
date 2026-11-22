import { describe, expect, it } from 'vitest';
import {
  AdapterResult,
  ModelAdapter,
  ModelRouter,
  ModelRouterConfig,
  ParentInvocation,
  RenderedRequest,
  RouterInvocation,
  SharedAdmissionGate,
  TierConfig,
} from '../cap_model_router_50';

class StaticAdapter implements ModelAdapter {
  readonly provider = 'fixture';
  readonly calls: RenderedRequest[] = [];

  constructor(
    readonly id: string,
    private readonly result: AdapterResult,
  ) {}

  async send(request: RenderedRequest): Promise<AdapterResult> {
    this.calls.push(request);
    return this.result;
  }
}

class PassthroughContextManager {
  render(invocation: RouterInvocation, tier: TierConfig, attemptOrdinal: number): any {
    return {
      ok: true,
      request: {
        route: invocation.kind === 'parent' ? 'primary' : invocation.kind === 'child' ? 'delegate' : 'review',
        tierId: tier.id,
        adapterId: tier.adapter.id,
        destination: tier.destination,
        attemptToken: `${tier.id}-${attemptOrdinal}`,
        messages: [{ role: 'user', content: 'hello' }],
      } satisfies RenderedRequest,
    };
  }
}

class PermitAdmission {
  readonly acquireCalls: string[] = [];
  acquire(..._args: unknown[]): any {
    this.acquireCalls.push('acquire');
    return true;
  }
}

describe('ModelRouter fallback', () => {
  it('falls back to the next eligible tier after a transient failure and returns its success', async () => {
    const primaryAdapter = new StaticAdapter('primary', {
      kind: 'transient',
      code: 'timeout',
      message: 'timeout',
    });
    const fallbackAdapter = new StaticAdapter('fallback', {
      kind: 'success',
      output: { tier: 'fallback' },
      usage: { inputTokens: 2, outputTokens: 3 },
    });

    const tiers: TierConfig[] = [
      { id: 'tier-primary', adapter: primaryAdapter, destination: 'dest-primary' },
      { id: 'tier-fallback', adapter: fallbackAdapter, destination: 'dest-fallback' },
    ];

    const admission = new PermitAdmission();

    const config = {
      routes: {
        primary: tiers,
        delegate: [],
        review: [],
      },
      maxFallbackAttempts: {
        primary: 1,
        delegate: 0,
        review: 0,
      },
      circuitBreakerThreshold: 2,
      admission,
      contextManager: new PassthroughContextManager(),
    } as unknown as ModelRouterConfig;

    const router = new ModelRouter(config);
    const invocation: ParentInvocation = {
      kind: 'parent',
      invocationId: 'parent-1',
      context: { sessionId: 'session-1' },
    };

    const result = await (router as any).route(invocation);

    expect(primaryAdapter.calls).toHaveLength(1);
    expect(fallbackAdapter.calls).toHaveLength(1);
    expect(primaryAdapter.calls[0]).toMatchObject({
      tierId: 'tier-primary',
      adapterId: 'primary',
      route: 'primary',
    });
    expect(fallbackAdapter.calls[0]).toMatchObject({
      tierId: 'tier-fallback',
      adapterId: 'fallback',
      route: 'primary',
    });
    expect(result).toMatchObject({
      kind: 'success',
      output: { tier: 'fallback' },
      usage: { inputTokens: 2, outputTokens: 3 },
    });
    expect(admission.acquireCalls.length).toBeGreaterThanOrEqual(2);
  });
});
