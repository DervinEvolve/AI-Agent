export type ModelRoute = 'primary' | 'delegate' | 'review';

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  unknown?: boolean;
}

export interface ParentInvocation {
  kind: 'parent';
  invocationId: string;
  context: unknown;
}

export interface ChildInvocation {
  kind: 'child';
  invocationId: string;
  childId: string;
  context: unknown;
}

export interface ReviewInvocation {
  kind: 'review';
  invocationId: string;
  context: unknown;
}

export type RouterInvocation = ParentInvocation | ChildInvocation | ReviewInvocation;

export interface RenderedRequest {
  readonly route: ModelRoute;
  readonly tierId: string;
  readonly adapterId: string;
  readonly destination: string;
  readonly attemptToken: string;
  readonly messages: readonly unknown[];
  readonly tools?: readonly unknown[];
  readonly maxTokens?: number;
  readonly responseFormat?: unknown;
  readonly reasoningDetails?: unknown;
}

export interface AdapterSuccess {
  kind: 'success';
  output: unknown;
  usage?: Usage;
  toolCalls?: readonly unknown[];
  reasoningDetails?: unknown;
}

export type TransientTransportCode =
  | 'http_408'
  | 'http_429'
  | 'http_5xx'
  | 'connection_reset'
  | 'timeout'
  | 'transient_unavailable';

export interface AdapterTransientFailure {
  kind: 'transient';
  code: TransientTransportCode;
  message: string;
  usage?: Usage;
}

export interface AdapterNonTransientFailure {
  kind: 'failure';
  reason: string;
  message: string;
  usage?: Usage;
}

export type AdapterResult = AdapterSuccess | AdapterTransientFailure | AdapterNonTransientFailure;

export interface ModelAdapter {
  readonly id: string;
  readonly provider: string;
  send(request: RenderedRequest): Promise<AdapterResult>;
}

export interface TierConfig {
  readonly id: string;
  readonly adapter: ModelAdapter;
  readonly destination: string;
  readonly contextLimits?: {
    readonly maxInputTokens?: number;
    readonly maxOutputTokens?: number;
  };
  readonly continuationCompatible?: boolean;
  readonly renderer?: string;
}

export type RenderFailureReason = 'context_overflow' | 'continuation_incompatible' | 'render_failed';

export type RenderResult =
  | { ok: true; request: RenderedRequest }
  | { ok: false; reason: RenderFailureReason; message: string };

export interface ContextManager {
  render(invocation: RouterInvocation, tier: TierConfig, attemptOrdinal: number): RenderResult;
}

export interface AdmissionRequest {
  route: ModelRoute;
  tierId: string;
  attemptOrdinal: number;
  attemptToken: string;
  usageEstimate?: Usage;
}

export type AdmissionDeniedReason = 'usage_unknown' | 'admission_exhausted' | 'blocked';

export type AdmissionDecision =
  | { granted: true; admissionId: string; usageKnown: boolean }
  | { granted: false; reason: AdmissionDeniedReason; message: string };

export interface AdmissionGate {
  acquire(request: AdmissionRequest): Promise<AdmissionDecision>;
  settleUsage(admissionId: string, usage?: Usage): void;
}

export interface RouterRecord {
  route: ModelRoute;
  invocationId: string;
  childId?: string;
  tierId: string;
  attemptOrdinal: number;
  adapterId: string;
  destination: string;
  outcome: 'success' | 'transient_failure' | 'non_transient_failure' | 'skipped';
  skipReason?: string;
  triggerReason?: string;
  usageKnown: boolean;
  attemptToken: string;
}

export type RouterFailureReason =
  | 'model_unavailable'
  | 'context_overflow'
  | 'continuation_incompatible'
  | 'usage_unknown'
  | 'admission_exhausted'
  | 'cancelled'
  | 'deadline_exceeded'
  | 'adapter_rejected'
  | 'render_failed'
  | 'circuit_open';

export interface RouterSuccess {
  status: 'success';
  response: AdapterSuccess;
  route: ModelRoute;
  tierId: string;
  adapterId: string;
  destination: string;
  attemptOrdinal: number;
  attemptToken: string;
  invocationId: string;
  childId?: string;
  records: readonly RouterRecord[];
}

export interface RouterFailure {
  status: 'failure';
  reason: RouterFailureReason;
  message: string;
  route: ModelRoute;
  attemptToken: string;
  invocationId: string;
  childId?: string;
  records: readonly RouterRecord[];
}

export type RouterResult = RouterSuccess | RouterFailure;

export interface ModelRouterConfig {
  routes: Record<ModelRoute, readonly TierConfig[]>;
  maxFallbackAttempts?: Partial<Record<ModelRoute, number>>;
  circuitThreshold?: number;
}

export interface ModelRouterDependencies {
  contextManager: ContextManager;
  admission: AdmissionGate;
  createId?: () => string;
}

export type AbortReason = 'cancelled' | 'deadline_exceeded';

export interface RouterInvocationOptions {
  attemptToken?: string;
  shouldAbort?: () => AbortReason | false;
  usageEstimate?: Usage;
}

export class RunLocalCircuitBreaker {
  private readonly consecutive = new Map<string, number>();
  private readonly threshold: number;

  constructor(threshold = 2) {
    const normalized = Math.max(1, Math.floor(threshold));
    this.threshold = normalized;
  }

  isOpen(key: string): boolean {
    return (this.consecutive.get(key) ?? 0) >= this.threshold;
  }

  recordTransient(key: string): boolean {
    const next = (this.consecutive.get(key) ?? 0) + 1;
    this.consecutive.set(key, next);
    return next >= this.threshold;
  }

  recordSuccess(key: string): void {
    this.consecutive.set(key, 0);
  }
}

export class SharedAdmissionGate implements AdmissionGate {
  private calls = 0;
  private usedInputTokens = 0;
  private usedOutputTokens = 0;
  private blockedReason: AdmissionDeniedReason | null = null;
  private readonly reservations = new Map<
    string,
    { inputTokens: number; outputTokens: number; settled: boolean }
  >();
  private nextAdmissionId = 1;

  constructor(
    private readonly limits: {
      maxModelCalls?: number;
      maxInputTokens?: number;
      maxOutputTokens?: number;
    } = {},
  ) {}

  async acquire(request: AdmissionRequest): Promise<AdmissionDecision> {
    if (this.blockedReason) {
      return {
        granted: false,
        reason: this.blockedReason,
        message: `Admission is blocked for the remainder of the run: ${this.blockedReason}`,
      };
    }

    if (this.limits.maxModelCalls !== undefined && this.calls >= this.limits.maxModelCalls) {
      return {
        granted: false,
        reason: 'admission_exhausted',
        message: 'Model-call admission limit exhausted',
      };
    }

    const estimate = request.usageEstimate ?? {};
    const hasTokenCap =
      this.limits.maxInputTokens !== undefined || this.limits.maxOutputTokens !== undefined;

    if (estimate.unknown && hasTokenCap) {
      this.blockAll('usage_unknown');
      return {
        granted: false,
        reason: 'usage_unknown',
        message: 'Unknown usage with an active token cap blocks all subsequent inference',
      };
    }

    const estimatedInput = estimate.inputTokens ?? 0;
    const estimatedOutput = estimate.outputTokens ?? 0;

    if (
      this.limits.maxInputTokens !== undefined &&
      this.usedInputTokens + estimatedInput > this.limits.maxInputTokens
    ) {
      return {
        granted: false,
        reason: 'admission_exhausted',
        message: 'Input-token admission limit exhausted',
      };
    }

    if (
      this.limits.maxOutputTokens !== undefined &&
      this.usedOutputTokens + estimatedOutput > this.limits.maxOutputTokens
    ) {
      return {
        granted: false,
        reason: 'admission_exhausted',
        message: 'Output-token admission limit exhausted',
      };
    }

    const admissionId = `admission_${this.nextAdmissionId++}`;
    this.calls += 1;
    this.usedInputTokens += estimatedInput;
    this.usedOutputTokens += estimatedOutput;
    this.reservations.set(admissionId, {
      inputTokens: estimatedInput,
      outputTokens: estimatedOutput,
      settled: false,
    });

    return {
      granted: true,
      admissionId,
      usageKnown: !estimate.unknown,
    };
  }

  settleUsage(admissionId: string, usage?: Usage): void {
    const reservation = this.reservations.get(admissionId);
    if (!reservation || reservation.settled) {
      return;
    }

    const hasTokenCap =
      this.limits.maxInputTokens !== undefined || this.limits.maxOutputTokens !== undefined;

    if (usage?.unknown && hasTokenCap) {
      this.blockAll('usage_unknown');
      reservation.settled = true;
      return;
    }

    if (usage && !usage.unknown) {
      this.usedInputTokens -= reservation.inputTokens;
      this.usedOutputTokens -= reservation.outputTokens;
      this.usedInputTokens += usage.inputTokens ?? 0;
      this.usedOutputTokens += usage.outputTokens ?? 0;
    }

    reservation.settled = true;
  }

  blockAll(reason: AdmissionDeniedReason): void {
    this.blockedReason = reason;
  }

  isBlocked(): boolean {
    return this.blockedReason !== null;
  }
}

export class ModelRouter {
  private readonly config: ModelRouterConfig;
  private readonly contextManager: ContextManager;
  private readonly admission: AdmissionGate;
  private readonly circuit: RunLocalCircuitBreaker;
  private readonly createId: () => string;
  private idCounter = 0;

  constructor(config: ModelRouterConfig, dependencies: ModelRouterDependencies) {
    this.config = config;
    this.contextManager = dependencies.contextManager;
    this.admission = dependencies.admission;
    this.createId =
      dependencies.createId ??
      (() => {
        this.idCounter += 1;
        return `inv_${Date.now()}_${this.idCounter}`;
      });

    for (const route of ['primary', 'delegate', 'review'] as const) {
      const tiers = config.routes[route];
      if (!tiers || tiers.length === 0) {
        throw new Error(`ModelRouter requires a nonempty tier list for route: ${route}`);
      }
      const maxFallback = config.maxFallbackAttempts?.[route] ?? 0;
      if (!Number.isInteger(maxFallback) || maxFallback < 0 || maxFallback > 3) {
        throw new Error(`maxFallbackAttempts for ${route} must be an integer from 0 through 3`);
      }
    }

    const threshold = config.circuitThreshold ?? 2;
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new Error('circuitThreshold must be a positive integer');
    }
    this.circuit = new RunLocalCircuitBreaker(threshold);
  }

  async route(
    invocation: RouterInvocation,
    options: RouterInvocationOptions = {},
  ): Promise<RouterResult> {
    const route = routeForInvocation(invocation);
    const tiers = this.config.routes[route];
    const maxFallback = this.config.maxFallbackAttempts?.[route] ?? 0;
    const eligibleCount = Math.min(tiers.length, 1 + maxFallback);
    const attemptToken = options.attemptToken ?? this.createId();
    const records: RouterRecord[] = [];
    let lastTransient: AdapterTransientFailure | undefined;
    let firstSkipReason: RenderFailureReason | 'circuit_open' | undefined;

    for (let attemptOrdinal = 0; attemptOrdinal < eligibleCount; attemptOrdinal += 1) {
      const tier = tiers[attemptOrdinal];
      if (!tier) {
        break;
      }

      const circuitKey = `${route}:${tier.id}`;
      if (this.circuit.isOpen(circuitKey)) {
        records.push(
          this.makeRecord(invocation, route, tier, attemptOrdinal, attemptToken, {
            outcome: 'skipped',
            skipReason: 'circuit_open',
            usageKnown: true,
          }),
        );
        firstSkipReason = firstSkipReason ?? 'circuit_open';
        continue;
      }

      const abortBeforeRender = options.shouldAbort?.();
      if (abortBeforeRender) {
        records.push(
          this.makeRecord(invocation, route, tier, attemptOrdinal, attemptToken, {
            outcome: 'skipped',
            skipReason: abortBeforeRender,
            usageKnown: true,
          }),
        );
        return this.failure(
          invocation,
          route,
          attemptToken,
          abortBeforeRender,
          `Aborted before send: ${abortBeforeRender}`,
          records,
        );
      }

      const render = this.contextManager.render(invocation, tier, attemptOrdinal);
      if (!render.ok) {
        records.push(
          this.makeRecord(invocation, route, tier, attemptOrdinal, attemptToken, {
            outcome: 'skipped',
            skipReason: render.reason,
            usageKnown: true,
          }),
        );
        firstSkipReason = firstSkipReason ?? render.reason;
        continue;
      }

      const admission = await this.admission.acquire({
        route,
        tierId: tier.id,
        attemptOrdinal,
        attemptToken,
        usageEstimate: options.usageEstimate,
      });

      if (!admission.granted) {
        records.push(
          this.makeRecord(invocation, route, tier, attemptOrdinal, attemptToken, {
            outcome: 'skipped',
            skipReason: admission.reason,
            usageKnown: false,
          }),
        );
        return this.failure(
          invocation,
          route,
          attemptToken,
          mapAdmissionDeniedReason(admission.reason),
          admission.message,
          records,
        );
      }

      const abortAfterAdmission = options.shouldAbort?.();
      if (abortAfterAdmission) {
        this.admission.settleUsage(admission.admissionId, undefined);
        records.push(
          this.makeRecord(invocation, route, tier, attemptOrdinal, attemptToken, {
            outcome: 'skipped',
            skipReason: abortAfterAdmission,
            usageKnown: admission.usageKnown,
          }),
        );
        return this.failure(
          invocation,
          route,
          attemptToken,
          abortAfterAdmission,
          `Aborted after admission, before send: ${abortAfterAdmission}`,
          records,
        );
      }

      let result: AdapterResult;
      try {
        result = await tier.adapter.send(render.request);
      } catch (error) {
        result = {
          kind: 'failure',
          reason: 'adapter_threw',
          message: error instanceof Error ? error.message : String(error),
        };
      }

      this.admission.settleUsage(admission.admissionId, result.usage);

      if (result.kind === 'success') {
        this.circuit.recordSuccess(circuitKey);
        records.push(
          this.makeRecord(invocation, route, tier, attemptOrdinal, attemptToken, {
            outcome: 'success',
            usageKnown: admission.usageKnown && !result.usage?.unknown,
          }),
        );
        return {
          status: 'success',
          response: result,
          route,
          tierId: tier.id,
          adapterId: tier.adapter.id,
          destination: tier.destination,
          attemptOrdinal,
          attemptToken,
          invocationId: invocation.invocationId,
          childId: invocation.kind === 'child' ? invocation.childId : undefined,
          records,
        };
      }

      if (result.kind === 'transient') {
        this.circuit.recordTransient(circuitKey);
        lastTransient = result;
        records.push(
          this.makeRecord(invocation, route, tier, attemptOrdinal, attemptToken, {
            outcome: 'transient_failure',
            triggerReason: result.code,
            usageKnown: admission.usageKnown && !result.usage?.unknown,
          }),
        );
        continue;
      }

      records.push(
        this.makeRecord(invocation, route, tier, attemptOrdinal, attemptToken, {
          outcome: 'non_transient_failure',
          triggerReason: result.reason,
          usageKnown: admission.usageKnown && !result.usage?.unknown,
        }),
      );
      return this.failure(
        invocation,
        route,
        attemptToken,
        'adapter_rejected',
        result.message || result.reason,
        records,
      );
    }

    const reason = lastTransient
      ? 'model_unavailable'
      : firstSkipReason
        ? mapRenderFailureReason(firstSkipReason)
        : 'model_unavailable';

    return this.failure(
      invocation,
      route,
      attemptToken,
      reason,
      lastTransient?.message ?? 'No tier returned a response',
      records,
    );
  }

  private makeRecord(
    invocation: RouterInvocation,
    route: ModelRoute,
    tier: TierConfig,
    attemptOrdinal: number,
    attemptToken: string,
    fields: {
      outcome: RouterRecord['outcome'];
      skipReason?: string;
      triggerReason?: string;
      usageKnown: boolean;
    },
  ): RouterRecord {
    return {
      route,
      invocationId: invocation.invocationId,
      childId: invocation.kind === 'child' ? invocation.childId : undefined,
      tierId: tier.id,
      attemptOrdinal,
      adapterId: tier.adapter.id,
      destination: tier.destination,
      outcome: fields.outcome,
      skipReason: fields.skipReason,
      triggerReason: fields.triggerReason,
      usageKnown: fields.usageKnown,
      attemptToken,
    };
  }

  private failure(
    invocation: RouterInvocation,
    route: ModelRoute,
    attemptToken: string,
    reason: RouterFailureReason,
    message: string,
    records: readonly RouterRecord[],
  ): RouterFailure {
    return {
      status: 'failure',
      reason,
      message,
      route,
      attemptToken,
      invocationId: invocation.invocationId,
      childId: invocation.kind === 'child' ? invocation.childId : undefined,
      records,
    };
  }
}

function routeForInvocation(invocation: RouterInvocation): ModelRoute {
  if (invocation.kind === 'parent') {
    return 'primary';
  }
  if (invocation.kind === 'child') {
    return 'delegate';
  }
  return 'review';
}

function mapAdmissionDeniedReason(reason: AdmissionDeniedReason): RouterFailureReason {
  if (reason === 'blocked') {
    return 'usage_unknown';
  }
  return reason;
}

function mapRenderFailureReason(reason: RenderFailureReason | 'circuit_open'): RouterFailureReason {
  return reason;
}
