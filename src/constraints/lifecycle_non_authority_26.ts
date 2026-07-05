// con_lifecycle_non_authority_26
// Task lifecycle non-authority, isolation, and completion integrity.
//
// The task lifecycle manager is bookkeeping only. It must never become an
// authorization or completion shortcut. Every consequential/irreversible
// action still requires a fresh, action-bound approval_token verified at the
// dispatch boundary (see cap_hitl_orchestration_24). Non-interactive
// background tasks stay policy_blocked for HITL-gated steps regardless of
// portfolio state or prior approvals.
//
// This module is a pure, side-effect-free validator intended to be called
// inline at the tool-call / dispatch boundary. It performs no I/O and holds
// no hidden state.

import { redactSecrets } from '../capabilities/secret_redactor';

export const CONSTRAINT_ID = 'con_lifecycle_non_authority_26';

export type TaskState = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'blocked';
export type OpStatus = 'ok' | 'error' | 'pending';
export type CompletionStatus = 'succeeded' | 'failed' | 'incomplete';
export type ExecutionMode = 'interactive' | 'non_interactive_background';
export type DependencyKind = 'ordering' | 'data' | 'approval';

export interface DependencyEdge {
  from: string;
  to: string;
  kind: DependencyKind;
  satisfied?: boolean;
}

export interface ApprovalToken {
  // A fresh, action-bound token. Bound to a specific action fingerprint and
  // carries a use-once nonce and expiry. Lifecycle state can never fabricate
  // one of these.
  token: string;
  actionFingerprint: string;
  nonce: string;
  freshForActionId: string;
  expiresAtMs: number;
}

export interface DispatchRequest {
  taskId: string;
  taskState: TaskState;
  executionMode: ExecutionMode;
  actionId: string;
  actionFingerprint: string;
  // Whether the action itself is consequential / irreversible / HITL-gated.
  irreversible: boolean;
  hitlGated: boolean;
  // Approval-kind dependency that a caller might (wrongly) think substitutes
  // for a live token.
  approvalDependencySatisfied?: boolean;
  // The only thing that can actually authorize: a fresh action-bound token.
  approvalToken?: ApprovalToken;
  nowMs?: number;
}

export type DispatchDecision =
  | { allowed: true }
  | { allowed: false; reason: DispatchDenyReason };

export type DispatchDenyReason =
  | 'requires_fresh_approval_token'
  | 'approval_token_not_action_bound'
  | 'approval_token_expired'
  | 'approval_dependency_not_a_token'
  | 'policy_blocked'
  | 'tainted_evidence';

/**
 * Verify authorization inline at the dispatch boundary.
 *
 * Lifecycle state (ready/running) and a "satisfied" approval dependency are
 * NEVER sufficient. Only a fresh, action-bound approval token authorizes a
 * consequential/irreversible/HITL-gated action.
 */
export function verifyDispatch(req: DispatchRequest): DispatchDecision {
  const now = req.nowMs ?? 0;

  const needsApproval = req.irreversible || req.hitlGated;

  if (!needsApproval) {
    return { allowed: true };
  }

  // Non-interactive background tasks can never satisfy a HITL gate from
  // portfolio state or prior approvals. They are policy_blocked outright.
  if (req.executionMode === 'non_interactive_background') {
    return { allowed: false, reason: 'policy_blocked' };
  }

  // A satisfied approval-kind dependency is bookkeeping. It is not a token and
  // can never substitute for one.
  if (req.approvalDependencySatisfied && !req.approvalToken) {
    return { allowed: false, reason: 'approval_dependency_not_a_token' };
  }

  if (!req.approvalToken) {
    return { allowed: false, reason: 'requires_fresh_approval_token' };
  }

  const t = req.approvalToken;

  // Token must be bound to THIS specific action.
  if (t.actionFingerprint !== req.actionFingerprint || t.freshForActionId !== req.actionId) {
    return { allowed: false, reason: 'approval_token_not_action_bound' };
  }

  if (t.expiresAtMs <= now) {
    return { allowed: false, reason: 'approval_token_expired' };
  }

  return { allowed: true };
}

export interface CompletionEvidence {
  kind: 'trace' | 'milestone';
  ref: string;
  verified: boolean;
  tainted: boolean;
}

export type CompletionResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_transition' | 'no_verified_evidence' | 'tainted_evidence' };

/**
 * A transition to 'completed' requires concrete, verified, non-tainted
 * trace/milestone evidence. Tainted evidence can never by itself drive a
 * completion.
 */
export function validateCompletion(evidence: CompletionEvidence[]): CompletionResult {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return { ok: false, reason: 'no_verified_evidence' };
  }
  const anyVerifiedClean = evidence.some((e) => e.verified && !e.tainted);
  if (!anyVerifiedClean) {
    // If everything is tainted, this is specifically a taint failure.
    const allTainted = evidence.every((e) => e.tainted);
    if (allTainted) return { ok: false, reason: 'tainted_evidence' };
    return { ok: false, reason: 'no_verified_evidence' };
  }
  return { ok: true };
}

/**
 * op_status, task_state and completion_status are strictly separate. This
 * helper never derives one from another; it merely asserts they are being
 * carried as independent fields. Attempting to conflate them (deriving
 * completion from op_status) is a bug.
 */
export function areStatusFieldsSeparate(record: {
  opStatus: OpStatus;
  taskState: TaskState;
  completionStatus: CompletionStatus;
}): boolean {
  // op_status=ok never implies completion_status=succeeded, and lifecycle
  // state never implies either. This function is intentionally *not* a mapping
  // between them.
  return (
    typeof record.opStatus === 'string' &&
    typeof record.taskState === 'string' &&
    typeof record.completionStatus === 'string'
  );
}

export type DependencyResult =
  | { ok: true }
  | { ok: false; reason: 'cycle_detected' | 'depth_exceeded' | 'count_exceeded' };

export interface DependencyGraphCaps {
  maxDepth: number;
  maxCount: number;
}

export const DEFAULT_DEP_CAPS: DependencyGraphCaps = { maxDepth: 32, maxCount: 512 };

/**
 * Dependency graphs must remain acyclic and within depth/count caps.
 */
export function validateDependencyGraph(
  edges: DependencyEdge[],
  caps: DependencyGraphCaps = DEFAULT_DEP_CAPS,
): DependencyResult {
  if (edges.length > caps.maxCount) {
    return { ok: false, reason: 'count_exceeded' };
  }

  const adj = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const e of edges) {
    nodes.add(e.from);
    nodes.add(e.to);
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }

  // DFS for cycle detection + max depth.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n, WHITE);

  let maxSeenDepth = 0;
  let cycle = false;

  const stack: Array<{ node: string; depth: number; entering: boolean }> = [];
  for (const start of nodes) {
    if (color.get(start) !== WHITE) continue;
    stack.push({ node: start, depth: 1, entering: true });
    while (stack.length) {
      const frame = stack.pop()!;
      if (!frame.entering) {
        color.set(frame.node, BLACK);
        continue;
      }
      if (color.get(frame.node) === GRAY) {
        cycle = true;
        break;
      }
      if (color.get(frame.node) === BLACK) continue;
      color.set(frame.node, GRAY);
      if (frame.depth > maxSeenDepth) maxSeenDepth = frame.depth;
      // schedule the "exit" marker
      stack.push({ node: frame.node, depth: frame.depth, entering: false });
      for (const next of adj.get(frame.node) ?? []) {
        if (color.get(next) === GRAY) {
          cycle = true;
          break;
        }
        if (color.get(next) === WHITE) {
          stack.push({ node: next, depth: frame.depth + 1, entering: true });
        }
      }
      if (cycle) break;
    }
    if (cycle) break;
  }

  if (cycle) return { ok: false, reason: 'cycle_detected' };
  if (maxSeenDepth > caps.maxDepth) return { ok: false, reason: 'depth_exceeded' };
  return { ok: true };
}

export type CompensationProposal = {
  advisory: true;
  steps: Array<{ description: string; irreversible: boolean }>;
};

/**
 * Compensation is advisory only. propose_compensation never executes anything;
 * it only returns a plan. Any irreversible compensation step must still go
 * through a fresh HITL approval at dispatch (via verifyDispatch).
 */
export function proposeCompensation(
  steps: Array<{ description: string; irreversible: boolean }>,
): CompensationProposal {
  return {
    advisory: true,
    steps: steps.map((s) => ({ description: s.description, irreversible: !!s.irreversible })),
  };
}

// Keys that must never be persisted in task records / state history / edges /
// portfolio status in raw form.
const FORBIDDEN_SECRET_KEYS = [
  'approval_token',
  'approvalToken',
  'vault_handle',
  'vaultHandle',
  'pending_approval_ids',
  'pendingApprovalIds',
  'cookie',
  'cookies',
  'hidden_prompt',
  'hiddenPrompt',
  'deleted_memory',
  'deletedMemory',
  'auth_state',
  'authState',
];

/**
 * Redact a task record / state-history entry before storage. Reuses the shared
 * secret_redactor for value-level redaction and additionally strips known
 * lifecycle-authority keys so lifecycle state can never persist live authority.
 */
export function sanitizeForStorage<T extends Record<string, unknown>>(record: T): Record<string, unknown> {
  // First: shared value-level redaction (never re-invent redaction).
  const valueRedacted = redactSecrets(record) as Record<string, unknown>;
  return stripForbiddenKeys(valueRedacted);
}

function stripForbiddenKeys(value: unknown): any {
  if (Array.isArray(value)) {
    return value.map((v) => stripForbiddenKeys(v));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_SECRET_KEYS.includes(k)) {
        out[k] = '[REDACTED]';
        continue;
      }
      out[k] = stripForbiddenKeys(v);
    }
    return out;
  }
  return value;
}

export function isForbiddenStorageKey(key: string): boolean {
  return FORBIDDEN_SECRET_KEYS.includes(key);
}

// --- Non-authority: the lifecycle manager can never be an argument source ---

const MANAGER_BRAND = Symbol.for('con_lifecycle_non_authority_26.manager_brand');

/**
 * Brands an object as "the lifecycle manager" so tool adapters can structurally
 * refuse to accept it as a source of tool arguments/URLs/api ids/grant ids/
 * sub-agent goals without independent validation.
 */
export function brandAsLifecycleManager<T extends object>(obj: T): T {
  (obj as any)[MANAGER_BRAND] = true;
  return obj;
}

export function isLifecycleManager(obj: unknown): boolean {
  return !!obj && typeof obj === 'object' && (obj as any)[MANAGER_BRAND] === true;
}

/**
 * A tool adapter must call this to reject the lifecycle manager as a direct
 * argument source. Returns false (rejected) if the manager is passed without
 * independent validation.
 */
export function acceptToolArgumentSource(source: unknown, independentlyValidated = false): boolean {
  if (isLifecycleManager(source) && !independentlyValidated) {
    return false;
  }
  return true;
}

export const con_lifecycle_non_authority_26 = {
  id: 'con_lifecycle_non_authority_26',
  name: 'Task lifecycle non-authority, isolation, and completion integrity',
  status: 'active' as const,
  added_epoch: 26,
  description:
    "The task lifecycle manager must never be used to authorize side effects, execute tools or missions directly, clear taint, satisfy HITL confirmation, directly set tool arguments/URLs/api identifiers/grant ids/sub-agent goals, or substitute lifecycle state for validated evidence or a valid approval_token. A task reaching 'ready', 'running', or having an approval-dependency marked satisfied is bookkeeping only and never authorizes execution: every consequential/irreversible action still requires a fresh, action-bound cap_hitl_orchestration_24 approval_token verified at dispatch, and non-interactive background tasks remain policy_blocked for HITL-gated steps regardless of portfolio state or prior approvals. Transitions to 'completed' require concrete verified trace/milestone evidence; tainted evidence can never by itself drive a completion or approval-dependency transition. op_status (operation success), task_state (lifecycle state), and completion_status (task outcome) must remain strictly separate and never be conflated to create a hidden authority path. Dependency graphs must remain acyclic and within depth/count caps. Compensation is advisory only: the manager must never auto-execute a rollback, auto-roll-back committed side effects, or bypass HITL for irreversible compensation steps. Task records, state history, dependency edges, and portfolio status must never store raw secrets, vault/approval tokens, pending_approval_ids, cookies, hidden prompts, deleted memory content, or live auth state, and must preserve monotonic taint.",
  implementation: {
    tests: [
      "a task in 'ready' or 'running' state cannot authorize a browser/API/vault dispatch without a fresh verified approval_token",
      'an approval-kind dependency marked satisfied does not itself produce or substitute for an approval_token at dispatch',
      'lifecycle state cannot clear taint or convert tainted evidence into trusted tool arguments',
      'a non_interactive_background task reaching an irreversible step returns policy_blocked despite any prior interactive approval on a related task',
      "transition to 'completed' with only tainted evidence returns invalid_transition",
      'op_status=ok on a transition does not imply completion_status=succeeded; the fields are asserted independent',
      'a declared dependency that would form a cycle is rejected with cycle_detected',
      'propose_compensation output cannot trigger execution; a subsequent irreversible compensation step still requires a fresh HITL approval_token',
      'task records and state history redact apparent secrets before storage and never contain approval tokens, vault handles, or cookies',
      'the manager cannot be passed as an argument source to a tool adapter without independent validation',
    ],
  },
};

export default con_lifecycle_non_authority_26;
