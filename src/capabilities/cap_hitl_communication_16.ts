/**
 * cap_hitl_communication_16 — Canonical HITL policy gate.
 *
 * This is the **single** surface through which the agent requests human
 * confirmation for high-stakes, state-changing, authenticated, taint-triggered,
 * costly, irreversible, or unknown-consequence actions.
 *
 * As of epoch 25 it delegates asynchronous multi-channel delivery,
 * cryptographic binding, timeout management, and approval token verification to
 * `cap_hitl_orchestration_24` while retaining responsibility for:
 *   - The canonical HITL policy gate (risk class, taint, irreversibility, etc.)
 *   - Structured form / proposal rendering
 *   - The controller-facing API for pausing/resuming the task branch awaiting
 *     approval
 */

import {
  hitl_orchestrator,
  type HITLRequestPayload,
  type HITLApprovalState,
  type HITLApprovalToken,
} from './cap_hitl_orchestration_24';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InteractiveContext =
  | 'browser'
  | 'cli'
  | 'ide'
  | 'dashboard'
  | 'api';

export type NonInteractiveContext =
  | 'sub_agent'
  | 'scheduled'
  | 'event_triggered'
  | 'headless';

export type ExecutionContext = InteractiveContext | NonInteractiveContext;

export interface ActionProfile {
  /** Human-readable description of the action. */
  description: string;
  riskClass: 'low' | 'medium' | 'high' | 'critical';
  taintSources: string[];
  irreversible: boolean;
  estimatedCost: string;
  unknownConsequences: boolean;
  /** Whether the action mutates external state. */
  stateChanging: boolean;
  /** Whether the action requires authentication. */
  requiresAuthentication: boolean;
}

export interface HITLDecision {
  requiresApproval: boolean;
  reason: string;
  /** Only populated when requiresApproval is true. */
  approvalId?: string;
  /** Only populated when the context is non-interactive. */
  policyBlocked?: boolean;
}

export interface StructuredForm {
  title: string;
  sections: Array<{
    heading: string;
    fields: Array<{
      label: string;
      value: string;
      kind: 'text' | 'code' | 'diff' | 'link';
    }>;
  }>;
  confirmLabel: string;
  denyLabel: string;
}

// ---------------------------------------------------------------------------
// Policy gate — pure function, exported for direct testing
// ---------------------------------------------------------------------------

/**
 * Determine whether an action requires human approval based on its risk
 * profile, taint, irreversibility, cost, and unknown-consequence rules.
 *
 * This is the canonical policy gate.  All adapters (browser automation,
 * vault_auth, api_client, etc.) MUST route through this function.
 */
export function evaluateHITLPolicy(
  profile: ActionProfile,
  context: ExecutionContext,
): { requiresApproval: boolean; reason: string } {
  // Non-interactive contexts never wait for a human.
  if (isNonInteractive(context)) {
    return {
      requiresApproval: false,
      reason: `Non-interactive context (${context}) — policy blocked`,
    };
  }

  // Critical risk always requires approval.
  if (profile.riskClass === 'critical') {
    return { requiresApproval: true, reason: 'Critical risk class' };
  }

  // High risk requires approval.
  if (profile.riskClass === 'high') {
    return { requiresApproval: true, reason: 'High risk class' };
  }

  // Irreversible actions require approval.
  if (profile.irreversible) {
    return {
      requiresApproval: true,
      reason: 'Action is irreversible',
    };
  }

  // Taint-triggered actions require approval.
  if (profile.taintSources.length > 0) {
    return {
      requiresApproval: true,
      reason: `Action is tainted by sources: ${profile.taintSources.join(', ')}`,
    };
  }

  // Unknown consequences require approval.
  if (profile.unknownConsequences) {
    return {
      requiresApproval: true,
      reason: 'Action has unknown consequences',
    };
  }

  // Costly actions (heuristic: estimatedCost is non-trivial).
  if (profile.estimatedCost && profile.estimatedCost !== '$0' && profile.estimatedCost !== 'free') {
    return {
      requiresApproval: true,
      reason: `Action has non-trivial cost: ${profile.estimatedCost}`,
    };
  }

  return { requiresApproval: false, reason: 'Below HITL threshold' };
}

// ---------------------------------------------------------------------------
// Structured form rendering
// ---------------------------------------------------------------------------

/**
 * Render a structured form / proposal for human review.
 *
 * This stays in cap_hitl_communication_16 because it is tightly coupled to the
 * policy surface — it knows how to present consequences, risk class, taint
 * sources, etc. in a human-friendly format.
 */
export function renderStructuredForm(profile: ActionProfile): StructuredForm {
  const sections: StructuredForm['sections'] = [
    {
      heading: 'Action',
      fields: [
        { label: 'Description', value: profile.description, kind: 'text' },
      ],
    },
    {
      heading: 'Risk Assessment',
      fields: [
        { label: 'Risk Class', value: profile.riskClass, kind: 'text' },
        {
          label: 'Irreversible',
          value: profile.irreversible ? 'Yes' : 'No',
          kind: 'text',
        },
        {
          label: 'State-Changing',
          value: profile.stateChanging ? 'Yes' : 'No',
          kind: 'text',
        },
        {
          label: 'Requires Authentication',
          value: profile.requiresAuthentication ? 'Yes' : 'No',
          kind: 'text',
        },
        { label: 'Estimated Cost', value: profile.estimatedCost, kind: 'text' },
        {
          label: 'Unknown Consequences',
          value: profile.unknownConsequences ? 'Yes' : 'No',
          kind: 'text',
        },
      ],
    },
  ];

  if (profile.taintSources.length > 0) {
    sections.push({
      heading: 'Taint Sources',
      fields: profile.taintSources.map((s) => ({
        label: 'Source',
        value: s,
        kind: 'text' as const,
      })),
    });
  }

  return {
    title: 'Human Approval Required',
    sections,
    confirmLabel: 'Approve',
    denyLabel: 'Deny',
  };
}

// ---------------------------------------------------------------------------
// Main HITL entry-point — delegates to orchestrator
// ---------------------------------------------------------------------------

export interface RequestApprovalOptions {
  taskId: string;
  profile: ActionProfile;
  context: ExecutionContext;
  channels?: Array<'slack' | 'email' | 'dashboard' | 'webhook'>;
  timeoutMs?: number;
  sequenceNumber?: number;
}

/**
 * Request human approval for an action.
 *
 * 1. Evaluates the canonical HITL policy gate.
 * 2. If non-interactive context → returns `policy_blocked`.
 * 3. If approval is required → delegates to `hitl_orchestrator.request_approval`
 *    for async delivery, binding, and channel management.
 * 4. Returns the `approvalId` so the controller can poll `check_status` or
 *    await a callback.
 */
export function requestApproval(
  opts: RequestApprovalOptions,
): HITLDecision {
  const { profile, context } = opts;

  // 1. Policy gate
  const policy = evaluateHITLPolicy(profile, context);

  if (isNonInteractive(context)) {
    return {
      requiresApproval: false,
      reason: policy.reason,
      policyBlocked: true,
    };
  }

  if (!policy.requiresApproval) {
    return {
      requiresApproval: false,
      reason: policy.reason,
    };
  }

  // 2. Render the structured form (stays in this capability)
  const form = renderStructuredForm(profile);

  // 3. Build the orchestrator payload
  const payload: HITLRequestPayload = {
    taskId: opts.taskId,
    summary: profile.description,
    form: form as unknown as Record<string, unknown>,
    riskProfile: {
      riskClass: profile.riskClass,
      taintSources: profile.taintSources,
      irreversible: profile.irreversible,
      estimatedCost: profile.estimatedCost,
      unknownConsequences: profile.unknownConsequences,
    },
    channels: opts.channels ?? ['dashboard'],
    timeoutMs: opts.timeoutMs ?? 300_000, // 5 minutes default
    sequenceNumber: opts.sequenceNumber ?? Date.now(),
  };

  // 4. Delegate to orchestrator
  const state = hitl_orchestrator.request_approval(payload);

  return {
    requiresApproval: true,
    reason: policy.reason,
    approvalId: state.approvalId,
  };
}

/**
 * Check the status of a previously-requested approval.
 *
 * Thin wrapper around `hitl_orchestrator.check_status` so the controller
 * only needs to import this capability.
 */
export function checkApprovalStatus(
  approvalId: string,
): HITLApprovalState | null {
  return hitl_orchestrator.check_status(approvalId);
}

/**
 * Apply a human decision token (received out-of-band) to a pending approval.
 */
export function applyDecision(
  token: HITLApprovalToken,
): HITLApprovalState | null {
  return hitl_orchestrator.apply_decision(token);
}

/**
 * Cancel a pending approval.
 */
export function cancelApproval(approvalId: string): boolean {
  return hitl_orchestrator.cancel(approvalId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NON_INTERACTIVE_CONTEXTS: ReadonlySet<string> = new Set([
  'sub_agent',
  'scheduled',
  'event_triggered',
  'headless',
]);

function isNonInteractive(context: ExecutionContext): boolean {
  return NON_INTERACTIVE_CONTEXTS.has(context);
}
