import crypto from 'node:crypto';

const EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

export interface ActionBinding {
  action_payload: unknown;
  target_adapter: string;
  target_endpoint: string;
  vault_grant_id: string;
  nonce: string;
  timestamp: number;
}

export interface VerificationResult {
  valid: boolean;
  reason: string;
}

export class NonceStore {
  private consumed = new Set<string>();
  consume(nonce: string): boolean {
    if (this.consumed.has(nonce)) return false;
    this.consumed.add(nonce);
    return true;
  }
}

export function canonicalHashPayload(payload: unknown): string {
  // Deterministic JSON serialization; assumes JSON.stringify is stable for the same object.
  const json = JSON.stringify(payload);
  return crypto.createHash('sha256').update(json).digest('hex');
}

export function canonicalizeAction(action: ActionBinding): string {
  const payloadHash = canonicalHashPayload(action.action_payload);
  return `${payloadHash}|${action.target_adapter}|${action.target_endpoint}|${action.vault_grant_id}|${action.nonce}|${action.timestamp}`;
}

export function verifyActionBinding(
  action: ActionBinding,
  approvalToken: string,
  secretKey: string,
  nonceStore: NonceStore,
  currentTime: number = Date.now()
): VerificationResult {
  // Check expiry
  if (currentTime - action.timestamp > EXPIRY_MS) {
    return { valid: false, reason: 'expired' };
  }

  const canonical = canonicalizeAction(action);
  const expectedToken = crypto.createHmac('sha256', secretKey).update(canonical).digest('base64');

  if (approvalToken !== expectedToken) {
    return { valid: false, reason: 'invalid_signature' };
  }

  // Consume nonce atomically after successful verification
  if (!nonceStore.consume(action.nonce)) {
    return { valid: false, reason: 'invalid_signature: nonce already consumed' };
  }

  return { valid: true, reason: 'ok' };
}
