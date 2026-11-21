import { createHash, randomUUID } from 'crypto';
import { ToolRegistry } from './tool_registry';

export type ApprovalTier = 'allow' | 'deny' | 'ask';
export type ApprovalDecision = 'approve' | 'deny';

export interface ApprovalRequest {
  callId: string;
  toolName: string;
  canonicalArgs: string;
  argumentDigest: string;
  policyDigest: string;
  toolIdentity?: string;
}

export interface Approver {
  (request: ApprovalRequest): ApprovalDecision;
}

export interface ApprovalRecord {
  callId: string;
  toolName: string;
  argumentDigest: string;
  policyDigest: string;
  decision: ApprovalDecision | 'allow' | 'timeout' | 'error';
  exactBytes: string;
  timestamp: string;
}

export interface ApprovalPolicy {
  /** Tier applied to tools not listed in `tiers`. Defaults to 'deny' unless explicitly set to 'allow'. */
  defaultTier?: ApprovalTier;
  /** Tool-name-keyed tier configuration. Values may be a tier or an object with tier plus pinned identity. */
  tiers?: Record<string, ApprovalTier | { tier: ApprovalTier; identity?: string }>;
  approver?: Approver;
  approverTimeoutMs?: number;
  delegation?: {
    allowedTools?: string[];
  };
}

/**
 * Canonicalize a JSON value according to the core RFC 8785 JCS rules:
 * object keys sorted, no insignificant whitespace, deterministic number
 * formatting for finite numbers.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const body = keys
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

export function sha256Digest(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function policyDigest(policy: ApprovalPolicy): string {
  const normalized = {
    defaultTier: policy.defaultTier ?? 'deny',
    tiers: policy.tiers ?? {},
  };
  return sha256Digest(canonicalizeJson(normalized));
}

/**
 * ApprovalGatedToolRegistry wraps an existing ToolRegistry and applies the
 * host-configured approval policy before dispatch. It preserves the original
 * registry's schema validation, content authorizers, quota admission, and
 * dispatch behavior; the approval gate runs after schema validation and before
 * the wrapped registry's own admission/dispatch logic.
 */
export class ApprovalGatedToolRegistry {
  private policy?: ApprovalPolicy;
  private readonly deniedIntents = new Set<string>();
  private readonly records: ApprovalRecord[] = [];

  constructor(
    private readonly registry: ToolRegistry,
    policy?: ApprovalPolicy,
  ) {
    if (policy) {
      this.attachApprovalPolicy(policy);
    }
  }

  attachApprovalPolicy(policy: ApprovalPolicy): void {
    this.validatePolicy(policy);
    this.policy = policy;
  }

  register(tool: unknown): void {
    (this.registry as unknown as { register(tool: unknown): void }).register(tool);
  }

  getRecords(): readonly ApprovalRecord[] {
    return this.records;
  }

  async call(toolName: string, args: unknown): Promise<unknown> {
    const registryAny = this.registry as unknown as {
      tools?: Map<string, { schema?: { safeParse?: (value: unknown) => { success: boolean; data?: unknown } } }>;
      getTool?: (name: string) => { schema?: { safeParse?: (value: unknown) => { success: boolean; data?: unknown } } } | undefined;
      call(name: string, args: unknown): Promise<unknown>;
    };

    const tool =
      registryAny.tools?.get?.(toolName) ??
      registryAny.getTool?.(toolName);

    if (!tool) {
      return this.registry.call(toolName, args);
    }

    // Schema validation must run before any approval decision.
    if (tool.schema && typeof tool.schema.safeParse === 'function') {
      const parsed = tool.schema.safeParse(args);
      if (!parsed.success) {
        return this.registry.call(toolName, args);
      }
      args = parsed.data;
    }

    const policy = this.policy;
    if (!policy) {
      // Absent configuration preserves existing behavior exactly.
      return this.registry.call(toolName, args);
    }

    const callId = randomUUID();
    const canonicalArgs = canonicalizeJson(args);
    const argumentDigest = sha256Digest(canonicalArgs);
    const pDigest = policyDigest(policy);

    const tierEntry = policy.tiers?.[toolName];
    let tier: ApprovalTier;
    let identity: string | undefined;
    if (tierEntry) {
      if (typeof tierEntry === 'string') {
        tier = tierEntry;
      } else {
        tier = tierEntry.tier;
        identity = tierEntry.identity;
      }
    } else {
      tier = policy.defaultTier ?? 'deny';
    }

    const intentKey = `${toolName}:${argumentDigest}`;
    if (this.deniedIntents.has(intentKey)) {
      return { status: 'approval_denied', started: false };
    }

    const record = (
      decision: ApprovalRecord['decision'],
    ): ApprovalRecord => ({
      callId,
      toolName,
      argumentDigest,
      policyDigest: pDigest,
      decision,
      exactBytes: canonicalArgs,
      timestamp: new Date().toISOString(),
    });

    if (tier === 'deny') {
      this.deniedIntents.add(intentKey);
      this.records.push(record('deny'));
      return { status: 'approval_denied', started: false };
    }

    if (tier === 'allow') {
      this.records.push(record('allow'));
      return this.registry.call(toolName, args);
    }

    // tier === 'ask'
    if (!policy.approver) {
      this.deniedIntents.add(intentKey);
      this.records.push(record('deny'));
      return { status: 'approval_denied', started: false };
    }

    const request: ApprovalRequest = {
      callId,
      toolName,
      canonicalArgs,
      argumentDigest,
      policyDigest: pDigest,
      toolIdentity: identity,
    };

    const timeoutMs = policy.approverTimeoutMs ?? 5000;
    const start = Date.now();
    let decision: ApprovalDecision;
    try {
      decision = policy.approver(request);
    } catch {
      this.deniedIntents.add(intentKey);
      this.records.push(record('error'));
      return { status: 'approval_denied', started: false };
    }

    if (Date.now() - start > timeoutMs) {
      this.deniedIntents.add(intentKey);
      this.records.push(record('timeout'));
      return { status: 'approval_denied', started: false };
    }

    if (decision !== 'approve') {
      this.deniedIntents.add(intentKey);
      this.records.push(record(decision));
      return { status: 'approval_denied', started: false };
    }

    this.records.push(record('approve'));
    return this.registry.call(toolName, args);
  }

  private validatePolicy(policy: ApprovalPolicy): void {
    const allowed = policy.delegation?.allowedTools;
    if (!allowed) return;
    for (const toolName of allowed) {
      const entry = policy.tiers?.[toolName];
      const tier = typeof entry === 'string' ? entry : entry?.tier;
      if (tier === 'ask') {
        throw new Error(
          `Ask-tier tool ${toolName} cannot be listed in delegation.allowedTools`,
        );
      }
    }
  }
}
