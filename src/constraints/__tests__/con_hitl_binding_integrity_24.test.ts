import { describe, it, expect, beforeEach } from 'vitest';
import { verifyApprovalToken, ActionTuple, ApprovalToken, NonceStore } from '../con_hitl_binding_integrity_24';
import crypto from 'crypto';

function createToken(action: ActionTuple, secret: string, nonce: string, expiry: number): ApprovalToken {
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(action.action_payload, Object.keys(action.action_payload).sort())).digest('hex');
  const dataToSign = `${payloadHash}:${action.target_adapter}:${action.target_endpoint}:${action.vault_grant_id}:${nonce}:${expiry}`;
  const signature = crypto.createHmac('sha256', secret).update(dataToSign).digest('hex');
  return {
    action_payload_hash: payloadHash,
    target_adapter: action.target_adapter,
    target_endpoint: action.target_endpoint,
    vault_grant_id: action.vault_grant_id,
    nonce,
    expiry,
    signature,
  };
}

class InMemoryNonceStore implements NonceStore {
  private consumed = new Set<string>();
  isConsumed(nonce: string): boolean {
    return this.consumed.has(nonce);
  }
  consume(nonce: string): void {
    this.consumed.add(nonce);
  }
}

describe('con_hitl_binding_integrity_24 verification', () => {
  const secret = 'test-secret-key';
  const actionA: ActionTuple = {
    action_payload: { command: 'transfer', amount: 100, to: 'alice' },
    target_adapter: 'payment_adapter',
    target_endpoint: '/transfer',
    vault_grant_id: 'grant-123',
    timestamp: Date.now(),
  };
  const actionB: ActionTuple = {
    action_payload: { command: 'transfer', amount: 200, to: 'bob' },
    target_adapter: 'payment_adapter',
    target_endpoint: '/transfer',
    vault_grant_id: 'grant-123',
    timestamp: Date.now(),
  };

  let nonceStore: InMemoryNonceStore;

  beforeEach(() => {
    nonceStore = new InMemoryNonceStore();
  });

  it('a dispatch with an approval_token bound to action A but attempting to execute action B returns invalid_signature', () => {
    const token = createToken(actionA, secret, 'nonce1', Date.now() + 60000);
    const result = verifyApprovalToken(actionB, token, secret, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_signature');
    expect(result.reason).toContain('payload hash mismatch');
  });

  it('a dispatch with an approval_token bound to a different vault_grant_id returns invalid_signature', () => {
    const actionWithDifferentGrant = { ...actionA, vault_grant_id: 'grant-999' };
    const token = createToken(actionA, secret, 'nonce2', Date.now() + 60000);
    const result = verifyApprovalToken(actionWithDifferentGrant, token, secret, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_signature');
    expect(result.reason).toContain('Vault grant ID mismatch');
  });

  it('a dispatch with an approval_token bound to a different target_endpoint returns invalid_signature', () => {
    const actionWithDifferentEndpoint = { ...actionA, target_endpoint: '/other' };
    const token = createToken(actionA, secret, 'nonce3', Date.now() + 60000);
    const result = verifyApprovalToken(actionWithDifferentEndpoint, token, secret, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_signature');
    expect(result.reason).toContain('Target endpoint mismatch');
  });

  it('a replayed approval_token (already consumed) returns invalid_signature', () => {
    const token = createToken(actionA, secret, 'nonce4', Date.now() + 60000);
    const result1 = verifyApprovalToken(actionA, token, secret, nonceStore);
    expect(result1.valid).toBe(true);
    const result2 = verifyApprovalToken(actionA, token, secret, nonceStore);
    expect(result2.valid).toBe(false);
    expect(result2.error).toBe('invalid_signature');
    expect(result2.reason).toContain('Nonce already consumed');
  });

  it("a plaintext 'approved' message without cryptographic binding token is rejected by the orchestrator", () => {
    const result = verifyApprovalToken(actionA, null as any, secret, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_signature');
    expect(result.reason).toContain('Missing or invalid approval token');

    const result2 = verifyApprovalToken(actionA, 'approved' as any, secret, nonceStore);
    expect(result2.valid).toBe(false);
    expect(result2.error).toBe('invalid_signature');
  });

  it('context, memory, or claim content cannot substitute for a missing or mismatched approval_token', () => {
    const context = { memory: 'user said okay', claims: { approved: true } };
    const result = verifyApprovalToken(actionA, context as any, secret, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_signature');
  });

  it('sub-agent output claiming approval is rejected; only the cryptographically verified token from the orchestrator is valid', () => {
    const subAgentOutput = { type: 'approval', message: 'I approve this action', token: 'fake' };
    const result = verifyApprovalToken(actionA, subAgentOutput as any, secret, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_signature');
  });

  it("token verification runs at dispatch time in the adapter's verification hook, not in the controller prompt", () => {
    const token = createToken(actionA, secret, 'nonce5', Date.now() + 60000);
    let executed = false;
    const dispatch = (action: ActionTuple, token: ApprovalToken) => {
      const result = verifyApprovalToken(action, token, secret, nonceStore);
      if (result.valid) {
        executed = true;
      } else {
        throw new Error(`Dispatch blocked: ${result.reason}`);
      }
    };

    dispatch(actionA, token);
    expect(executed).toBe(true);

    executed = false;
    const badToken = createToken(actionB, secret, 'nonce6', Date.now() + 60000);
    expect(() => dispatch(actionA, badToken)).toThrow(/Dispatch blocked/);
    expect(executed).toBe(false);
  });

  it('valid token passes verification', () => {
    const token = createToken(actionA, secret, 'nonce7', Date.now() + 60000);
    const result = verifyApprovalToken(actionA, token, secret, nonceStore);
    expect(result.valid).toBe(true);
  });

  it('expired token is rejected', () => {
    const token = createToken(actionA, secret, 'nonce8', Date.now() - 1000);
    const result = verifyApprovalToken(actionA, token, secret, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_signature');
    expect(result.reason).toContain('expired');
  });

  it('token with invalid signature is rejected', () => {
    const token = createToken(actionA, secret, 'nonce9', Date.now() + 60000);
    token.signature = 'invalid';
    const result = verifyApprovalToken(actionA, token, secret, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_signature');
    expect(result.reason).toContain('Signature verification failed');
  });
});
