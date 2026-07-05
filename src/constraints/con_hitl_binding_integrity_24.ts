import crypto from 'crypto';

export interface ActionTuple {
  action_payload: any;
  target_adapter: string;
  target_endpoint: string;
  vault_grant_id: string;
  timestamp: number;
}

export interface ApprovalToken {
  action_payload_hash: string;
  target_adapter: string;
  target_endpoint: string;
  vault_grant_id: string;
  nonce: string;
  expiry: number; // Unix timestamp in milliseconds
  signature: string;
}

export interface VerificationResult {
  valid: boolean;
  error?: string;
  reason?: string;
}

export interface NonceStore {
  isConsumed(nonce: string): boolean;
  consume(nonce: string): void;
}

function canonicalizePayload(payload: any): string {
  return JSON.stringify(payload, Object.keys(payload).sort());
}

function hashPayload(payload: any): string {
  const canonical = canonicalizePayload(payload);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function canonicalizeTokenData(token: Omit<ApprovalToken, 'signature'>): string {
  return `${token.action_payload_hash}:${token.target_adapter}:${token.target_endpoint}:${token.vault_grant_id}:${token.nonce}:${token.expiry}`;
}

export function verifyApprovalToken(
  action: ActionTuple,
  token: ApprovalToken,
  secret: string,
  nonceStore: NonceStore,
  options?: { clockSkew?: number }
): VerificationResult {
  const clockSkew = options?.clockSkew ?? 5 * 60 * 1000; // 5 minutes default

  if (!token || typeof token !== 'object') {
    return { valid: false, error: 'invalid_signature', reason: 'Missing or invalid approval token' };
  }

  const computedPayloadHash = hashPayload(action.action_payload);
  if (computedPayloadHash !== token.action_payload_hash) {
    return { valid: false, error: 'invalid_signature', reason: 'Action payload hash mismatch' };
  }

  if (token.target_adapter !== action.target_adapter) {
    return { valid: false, error: 'invalid_signature', reason: 'Target adapter mismatch' };
  }
  if (token.target_endpoint !== action.target_endpoint) {
    return { valid: false, error: 'invalid_signature', reason: 'Target endpoint mismatch' };
  }
  if (token.vault_grant_id !== action.vault_grant_id) {
    return { valid: false, error: 'invalid_signature', reason: 'Vault grant ID mismatch' };
  }

  const now = Date.now();
  if (token.expiry + clockSkew < now) {
    return { valid: false, error: 'invalid_signature', reason: 'Approval token expired' };
  }

  if (nonceStore.isConsumed(token.nonce)) {
    return { valid: false, error: 'invalid_signature', reason: 'Nonce already consumed (replay detected)' };
  }

  const dataToSign = canonicalizeTokenData({
    action_payload_hash: token.action_payload_hash,
    target_adapter: token.target_adapter,
    target_endpoint: token.target_endpoint,
    vault_grant_id: token.vault_grant_id,
    nonce: token.nonce,
    expiry: token.expiry,
  });
  const expectedSignature = crypto.createHmac('sha256', secret).update(dataToSign).digest('hex');
  if (token.signature !== expectedSignature) {
    return { valid: false, error: 'invalid_signature', reason: 'Signature verification failed' };
  }

  nonceStore.consume(token.nonce);

  return { valid: true };
}

export const constraint = {
  id: 'con_hitl_binding_integrity_24',
  name: 'Cryptographic HITL binding integrity and non-repudiation',
  status: 'active',
  added_epoch: 25,
  description: `Every HITL approval for a consequential, irreversible, state-changing, costly, authenticated, or unknown-consequence action must be cryptographically bound to the exact action payload, target adapter, target endpoint, vault grant, and timestamp. At dispatch time, the executing adapter must verify the approval_token against the canonicalized action tuple; any mismatch in action_payload_hash, target_adapter, target_endpoint, vault_grant_id, or nonce must result in invalid_signature and policy_blocked, regardless of any claims, dialogue state, memory, traces, or controller context. Approval tokens are single-use and must be cryptographically invalidated after one successful verification. Prompt-injection attacks that modify the action payload after approval produce a different binding_hash and are mathematically prevented from executing. No context, memory, trace, claim, dialogue state, or sub-agent output can substitute for a valid, unexpired, action-bound approval_token. Plaintext approvals without cryptographic binding are rejected. This constraint applies to cap_hitl_communication_16, cap_hitl_orchestration_24, and any future approval mechanism.`,
  implementation: {
    tests: [
      "a dispatch with an approval_token bound to action A but attempting to execute action B returns invalid_signature",
      "a dispatch with an approval_token bound to a different vault_grant_id returns invalid_signature",
      "a dispatch with an approval_token bound to a different target_endpoint returns invalid_signature",
      "a replayed approval_token (already consumed) returns invalid_signature",
      "a plaintext 'approved' message without cryptographic binding token is rejected by the orchestrator",
      "context, memory, or claim content cannot substitute for a missing or mismatched approval_token",
      "sub-agent output claiming approval is rejected; only the cryptographically verified token from the orchestrator is valid",
      "token verification runs at dispatch time in the adapter's verification hook, not in the controller prompt"
    ]
  }
};
