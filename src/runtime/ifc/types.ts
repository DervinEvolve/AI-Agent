/**
 * Information-Flow Control (IFC) runtime types.
 *
 * These types are the single source of truth for reason codes and capability
 * identifiers used by the deterministic taint checker. Tests import codes and
 * caps from here so the runtime and its contract cannot drift.
 */

export const IFC_CAPS = {
  informationFlowControl: 'cap_information_flow_control_75',
  approvalGate: 'cap_approval_gate_46',
} as const;

export const IFC_REASON_CODES = {
  taintDenied: 'taint_denied',
  taintIndexSaturated: 'taint_index_saturated',
  taintApprovalRequired: 'taint_approval_required',
  taintApproved: 'taint_approved',
  taintTrustedSpan: 'taint_trusted_span',
  taintNoMatch: 'taint_no_match',
  taintDisabled: 'taint_disabled',
  taintConfigRejected: 'taint_config_rejected',
} as const;

export type IFCReasonCode = (typeof IFC_REASON_CODES)[keyof typeof IFC_REASON_CODES];

export type SinkTier = 'allow' | 'ask' | 'deny';

export type ControlArgClass = 'url' | 'path' | 'argv_token' | 'recipient' | 'destination';

export interface SinkPolicy {
  /** tool name -> control argument name -> tier */
  sinks: Record<string, Record<string, SinkTier>>;
  /** default tier for control-position arguments not explicitly listed */
  defaultControlTier: SinkTier;
  /** data-position arguments are never taint-checked */
  dataArgsExempt: true;
}

export interface IFCConfig {
  enabled: boolean;
  taintSources: string[];
  sinks: SinkPolicy;
  minSpanLength: number;
  maxIndexEntries: number;
  normalization: 'nfkc_casefold_whitespace_collapse';
  base64DecodePasses: 1;
  trustedSpanMaxCodePoints: number;
  /** frozen at startup; runtime must reject mutation attempts */
  frozen: true;
}

export interface TaintRecord {
  call_id: string;
  tool_name: string;
  arg_digest: string;
  matched_shingle_digest: string;
  source_call_id: string;
  policy_digest: string;
}

export interface TaintIndexSnapshot {
  saturated: boolean;
  entryCount: number;
  maxEntries: number;
}

export interface TaintDecision {
  allowed: boolean;
  reason: IFCReasonCode;
  tier: SinkTier;
  matchedShingleDigest?: string;
  sourceCallId?: string;
  record?: TaintRecord;
}

export interface TaintChecker {
  checkControlArg(input: {
    toolName: string;
    argName: string;
    argValue: string;
    callId: string;
    intentDigest: string;
  }): TaintDecision;
  recordUntrustedOutput(input: {
    callId: string;
    toolName: string;
    output: string;
  }): void;
  addTrustedSpan(span: string, provenance: 'user_short' | 'explicit'): void;
  snapshot(): TaintIndexSnapshot;
}

export interface TaintIndex {
  addShingle(shingle: string, sourceCallId: string): void;
  hasShingle(shingle: string): boolean;
  isSaturated(): boolean;
  entryCount(): number;
  maxEntries(): number;
}

export interface ApprovalGateLike {
  requestApproval(input: {
    callId: string;
    toolName: string;
    argName: string;
    argValue: string;
    matchedSpan: string;
    reason: IFCReasonCode;
  }): Promise<'approve' | 'deny' | 'timeout' | 'throw'>;
}
