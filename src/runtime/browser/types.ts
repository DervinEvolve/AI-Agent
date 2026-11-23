export type BrowserActionKind = 'click' | 'type' | 'select' | 'focus' | 'scroll' | 'submit';

export interface SnapshotRef {
  readonly run_id: string;
  readonly snapshot_id: string;
  readonly ref_id: string;
  readonly document_id: string;
  readonly dom_generation: number;
  readonly target_id: string;
  readonly role?: string;
  readonly name?: string;
  readonly input_type?: string;
}

export interface BrowserActionRequest {
  readonly ref: SnapshotRef;
  readonly action: BrowserActionKind;
  readonly value?: string;
  readonly scroll_delta_y?: number;
}

export interface BrowserActionResult {
  readonly ok: boolean;
  readonly termination_confirmed: boolean;
  readonly action: BrowserActionKind;
  readonly snapshot_id: string;
  readonly ref_id: string;
  readonly document_id?: string;
  readonly dom_generation?: number;
  readonly error_code?: string;
  readonly error?: string;
}

export interface BrowserNavigateResult {
  readonly ok: boolean;
  readonly termination_confirmed: boolean;
  readonly url: string;
  readonly document_id?: string;
  readonly dom_generation?: number;
  readonly status?: number;
  readonly pinned_address?: string;
  readonly error_code?: string;
  readonly error?: string;
}

export interface BrowserSnapshotEntry {
  readonly ref: SnapshotRef;
  readonly text?: string;
  readonly tag?: string;
  readonly disabled?: boolean;
}

export interface BrowserSnapshotResult {
  readonly ok: boolean;
  readonly termination_confirmed: boolean;
  readonly snapshot_id: string;
  readonly document_id: string;
  readonly dom_generation: number;
  readonly url: string;
  readonly text_excerpt: string;
  readonly refs: readonly BrowserSnapshotEntry[];
  readonly error_code?: string;
  readonly error?: string;
}

export type NavigationAuthorizer = (canonicalUrl: string) => Promise<boolean> | boolean;

export type DnsResolver = (hostname: string) => Promise<readonly string[]>;

export interface BrowserPolicy {
  readonly allowedHosts: readonly string[];
  readonly allowedPorts?: readonly number[];
  readonly maxRedirects?: number;
  readonly navigationAuthorizer?: NavigationAuthorizer;
  readonly navigationAuthorizerTimeoutMs?: number;
}

export interface NavigationPolicyDecision {
  readonly allowed: boolean;
  readonly canonicalUrl?: string;
  readonly hostname?: string;
  readonly port?: number;
  readonly pinnedAddress?: string;
  readonly reason?: string;
}

export interface PagePortCapabilities {
  readonly requestInterception: boolean;
  readonly pinnedConnections: boolean;
  readonly guardedTargets: boolean;
  readonly lifecycleReporting: boolean;
}

export interface PageIdentity {
  readonly documentId: string;
  readonly domGeneration: number;
  readonly url: string;
}

export interface PageSnapshotPayload {
  readonly documentId: string;
  readonly domGeneration: number;
  readonly url: string;
  readonly textExcerpt: string;
  readonly elements: readonly {
    readonly targetId: string;
    readonly role?: string;
    readonly name?: string;
    readonly inputType?: string;
    readonly text?: string;
    readonly tag?: string;
    readonly disabled?: boolean;
  }[];
}

export interface PagePort {
  readonly capabilities: PagePortCapabilities;
  getIdentity(): Promise<PageIdentity>;
  navigate(url: string, pinnedAddress: string): Promise<{
    ok: boolean;
    terminationConfirmed: boolean;
    documentId?: string;
    domGeneration?: number;
    status?: number;
    errorCode?: string;
    error?: string;
  }>;
  snapshot(): Promise<PageSnapshotPayload & { ok: boolean; terminationConfirmed: boolean; errorCode?: string; error?: string }>;
  actGuarded(request: {
    ref: SnapshotRef;
    action: BrowserActionKind;
    value?: string;
    scrollDeltaY?: number;
  }): Promise<{
    ok: boolean;
    terminationConfirmed: boolean;
    documentId?: string;
    domGeneration?: number;
    errorCode?: string;
    error?: string;
  }>;
  awaitSettlement(): Promise<boolean>;
  dispose(): Promise<boolean>;
}

export interface BrowserSessionConfig {
  readonly runId: string;
  readonly policy: BrowserPolicy;
  readonly pagePort: PagePort;
  readonly dnsResolver: DnsResolver;
  readonly production?: boolean;
  readonly maxSnapshotChars?: number;
  readonly maxSnapshotRefs?: number;
}

export interface SnapshotRefResolution {
  readonly ok: boolean;
  readonly ref?: SnapshotRef;
  readonly reason?: string;
}

export { evaluateNavigationPolicy } from './policy';
export { resolveSnapshotRef } from './snapshot_refs';
