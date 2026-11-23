import { evaluateNavigationPolicy } from './policy';
import { resolveSnapshotRef } from './snapshot_refs';
import type {
  BrowserActionRequest,
  BrowserActionResult,
  BrowserNavigateResult,
  BrowserSessionConfig,
  BrowserSnapshotEntry,
  BrowserSnapshotResult,
  SnapshotRef,
} from './types';

export interface BrowserToolMetadata {
  readonly name: 'browser_navigate' | 'browser_snapshot' | 'browser_act';
  readonly idempotent: false;
  readonly concurrentSafe: false;
  readonly excludeFromDelegation: true;
}

export const BROWSER_TOOL_METADATA: readonly BrowserToolMetadata[] = [
  {
    name: 'browser_navigate',
    idempotent: false,
    concurrentSafe: false,
    excludeFromDelegation: true,
  },
  {
    name: 'browser_snapshot',
    idempotent: false,
    concurrentSafe: false,
    excludeFromDelegation: true,
  },
  {
    name: 'browser_act',
    idempotent: false,
    concurrentSafe: false,
    excludeFromDelegation: true,
  },
];

export class BrowserSession {
  private readonly config: BrowserSessionConfig;
  private activeSnapshotId: string | null = null;
  private activeRefs = new Map<string, SnapshotRef>();
  private snapshotCounter = 0;
  private taintedByTimeout = false;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(config: BrowserSessionConfig) {
    const caps = config.pagePort.capabilities;
    if (
      !caps.requestInterception ||
      !caps.pinnedConnections ||
      !caps.guardedTargets ||
      !caps.lifecycleReporting
    ) {
      throw new Error('PagePort missing required capabilities: interception, pinning, guardedTargets, lifecycleReporting');
    }
    this.config = config;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  markOuterTimeout(): void {
    this.taintedByTimeout = true;
  }

  async awaitAuthoritativeSettlement(): Promise<boolean> {
    const settled = await this.config.pagePort.awaitSettlement();
    if (settled) {
      this.taintedByTimeout = false;
    }
    return settled;
  }

  private invalidateRefs(): void {
    this.activeSnapshotId = null;
    this.activeRefs.clear();
  }

  async navigate(rawUrl: string, redirectCount = 0): Promise<BrowserNavigateResult> {
    return this.serialize(async () => {
      if (this.disposed) {
        return {
          ok: false,
          termination_confirmed: true,
          url: rawUrl,
          error_code: 'session_disposed',
          error: 'Browser session is disposed',
        };
      }
      if (this.taintedByTimeout) {
        return {
          ok: false,
          termination_confirmed: false,
          url: rawUrl,
          error_code: 'session_tainted_by_timeout',
          error: 'Browser session is tainted until authoritative settlement',
        };
      }

      this.invalidateRefs();
      const decision = await evaluateNavigationPolicy(
        rawUrl,
        this.config.policy,
        this.config.dnsResolver,
        redirectCount,
      );
      if (!decision.allowed || !decision.canonicalUrl || !decision.pinnedAddress) {
        return {
          ok: false,
          termination_confirmed: true,
          url: rawUrl,
          error_code: decision.reason ?? 'navigation_denied',
          error: `Navigation denied: ${decision.reason ?? 'policy_rejected'}`,
        };
      }

      const res = await this.config.pagePort.navigate(
        decision.canonicalUrl,
        decision.pinnedAddress,
      );
      return {
        ok: res.ok,
        termination_confirmed: res.terminationConfirmed,
        url: decision.canonicalUrl,
        document_id: res.documentId,
        dom_generation: res.domGeneration,
        status: res.status,
        pinned_address: decision.pinnedAddress,
        error_code: res.errorCode,
        error: res.error,
      };
    });
  }

  async snapshot(): Promise<BrowserSnapshotResult> {
    return this.serialize(async () => {
      if (this.disposed) {
        return {
          ok: false,
          termination_confirmed: true,
          snapshot_id: '',
          document_id: '',
          dom_generation: 0,
          url: '',
          text_excerpt: '',
          refs: [],
          error_code: 'session_disposed',
          error: 'Browser session is disposed',
        };
      }
      if (this.taintedByTimeout) {
        return {
          ok: false,
          termination_confirmed: false,
          snapshot_id: '',
          document_id: '',
          dom_generation: 0,
          url: '',
          text_excerpt: '',
          refs: [],
          error_code: 'session_tainted_by_timeout',
          error: 'Browser session is tainted until authoritative settlement',
        };
      }

      const raw = await this.config.pagePort.snapshot();
      if (!raw.ok) {
        return {
          ok: false,
          termination_confirmed: raw.terminationConfirmed,
          snapshot_id: '',
          document_id: raw.documentId,
          dom_generation: raw.domGeneration,
          url: raw.url,
          text_excerpt: '',
          refs: [],
          error_code: raw.errorCode ?? 'snapshot_failed',
          error: raw.error,
        };
      }

      this.snapshotCounter += 1;
      const snapshotId = `snap_${this.config.runId}_${this.snapshotCounter}`;
      const maxRefs = this.config.maxSnapshotRefs ?? 100;
      const maxChars = this.config.maxSnapshotChars ?? 4000;
      const newRefs = new Map<string, SnapshotRef>();
      const entries: BrowserSnapshotEntry[] = [];

      for (let i = 0; i < Math.min(raw.elements.length, maxRefs); i += 1) {
        const el = raw.elements[i];
        const refId = `ref_${i + 1}`;
        const ref: SnapshotRef = {
          run_id: this.config.runId,
          snapshot_id: snapshotId,
          ref_id: refId,
          document_id: raw.documentId,
          dom_generation: raw.domGeneration,
          target_id: el.targetId,
          role: el.role,
          name: el.name,
          input_type: el.inputType,
        };
        newRefs.set(refId, ref);
        entries.push({
          ref,
          text: el.text,
          tag: el.tag,
          disabled: el.disabled,
        });
      }

      this.activeSnapshotId = snapshotId;
      this.activeRefs = newRefs;

      return {
        ok: true,
        termination_confirmed: raw.terminationConfirmed,
        snapshot_id: snapshotId,
        document_id: raw.documentId,
        dom_generation: raw.domGeneration,
        url: raw.url,
        text_excerpt: raw.textExcerpt.slice(0, maxChars),
        refs: entries,
      };
    });
  }

  async act(request: BrowserActionRequest): Promise<BrowserActionResult> {
    return this.serialize(async () => {
      if (this.disposed) {
        return {
          ok: false,
          termination_confirmed: true,
          action: request.action,
          snapshot_id: request.ref.snapshot_id,
          ref_id: request.ref.ref_id,
          error_code: 'session_disposed',
          error: 'Browser session is disposed',
        };
      }
      if (this.taintedByTimeout) {
        return {
          ok: false,
          termination_confirmed: false,
          action: request.action,
          snapshot_id: request.ref.snapshot_id,
          ref_id: request.ref.ref_id,
          error_code: 'session_tainted_by_timeout',
          error: 'Browser session is tainted until authoritative settlement',
        };
      }

      if (request.ref.input_type === 'password' || request.ref.input_type === 'file') {
        this.invalidateRefs();
        return {
          ok: false,
          termination_confirmed: true,
          action: request.action,
          snapshot_id: request.ref.snapshot_id,
          ref_id: request.ref.ref_id,
          error_code: 'forbidden_input_type',
          error: `Action blocked for input_type=${request.ref.input_type}`,
        };
      }

      const currentIdentity = await this.config.pagePort.getIdentity();
      const resolved = resolveSnapshotRef(
        request.ref,
        this.config.runId,
        this.activeSnapshotId,
        this.activeRefs,
        currentIdentity,
      );

      // Every attempted action invalidates active refs.
      this.invalidateRefs();

      if (!resolved.ok || !resolved.ref) {
        return {
          ok: false,
          termination_confirmed: true,
          action: request.action,
          snapshot_id: request.ref.snapshot_id,
          ref_id: request.ref.ref_id,
          error_code: resolved.reason ?? 'ref_resolution_failed',
          error: `Ref resolution failed: ${resolved.reason ?? 'invalid_ref'}`,
        };
      }

      const res = await this.config.pagePort.actGuarded({
        ref: resolved.ref,
        action: request.action,
        value: request.value,
        scrollDeltaY: request.scroll_delta_y,
      });

      return {
        ok: res.ok,
        termination_confirmed: res.terminationConfirmed,
        action: request.action,
        snapshot_id: request.ref.snapshot_id,
        ref_id: request.ref.ref_id,
        document_id: res.documentId,
        dom_generation: res.domGeneration,
        error_code: res.errorCode,
        error: res.error,
      };
    });
  }

  async dispose(): Promise<{ ok: boolean }> {
    return this.serialize(async () => {
      const ok = await this.config.pagePort.dispose();
      this.disposed = true;
      this.invalidateRefs();
      return { ok };
    });
  }
}
