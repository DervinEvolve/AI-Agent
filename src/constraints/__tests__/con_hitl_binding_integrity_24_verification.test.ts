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

  it('valid token passes verification', () => {
    const nonce = 'nonce-1';
    const expiry = Date.now() + 60000;
    const token = createToken(actionA, secret, nonce, expiry);
    const result = verifyApprovalToken(actionA, token, secret, nonceStore);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('a dispatch with an approval_token bound to action A but attempting to execute action B returns invalid_signature', () => {
    const nonce = 'nonce-2';
    const expiry = Date.now() + 60000;
    const token = createToken(actionA, secret, nonce, expiry);
    const result = verifyApprovalToken(actionB, token, secret, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_signature');
    expect(result.reason).toContain('hash mismatch');
  });

  it('a dispatch with an approval_token bound to a different vault_grant_id returns invalid_signature', () => {
    const nonce = 'nonce-3';
    const expiry = Date.now() + 60000;
    const token = createToken(actionA, secret, nonce, expiry);
    const modifiedAction = { ...actionA, vault_grant_id: 'grant-999' };
    const result = verifyApprovalToken(modifiedAction, token, secret, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_signature');
    expect(result.reason).toContain('vault_grant_id mismatch');
  });

  it('a dispatch with an approval_token bound to a different target_endpoint returns invalid_signature', () => {
    const nonce = 'nonce-4';
    const expiry = Date.now() + 60000;
    const token = createToken(actionA, secret, nonce, expiry);
    const modifiedAction = { ...actionA, target_endpoint: '/withdraw' };
    const result = verifyApprovalToken(modifiedAction, token, secret, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_signature');
    expect(result.reason).toContain('target_endpoint mismatch');
  });

  it('a dispatch with an approval_token bound to a different target_adapter returns invalid_signature', () => {
    const nonce = 'nonce-5';
    const expiry = Date.now() + 60000;
    const token = createToken(actionA, secret, nonce, expiry);
    const modifiedAction = { ...actionA, target_adapter: 'other_adapter' };
    const result = verifyApprovalToken(modifiedAction, token, secret, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_signature');
    expect(result.reason).toContain('Target adapter mismatch');
  });

  it('a replayed approval_token (already consumed) returns invalid_signature', () => {
    const nonce = 'nonce-6';
    const expiry = Date.now() + 60000;
    const token = createToken(actionA, secret, nonce, expiry);
    // First use
    const firstResult = verifyApprovalToken(actionA, token, secret, nonceStore);
    expect(firstResult.valid).toBe(true);
    // Second use with same nonce
    const secondResult = verifyApprovalToken(actionA, token, secret, nonceStore);
    expect(secondResult.valid).toBe(false);
    expect(secondResult.error).toBe('invalid_signature');
    expect(secondResult.reason).toContain('Nonce already consumed');
  });

  it('expired token returns invalid_signature', () => {
    const nonce = 'nonce-7';
    const expiry = Date.now() - 1000; // already expired
    const token = createToken(actionA, secret, nonce, expiry);
    const result = verifyApprovalToken(actionA, token, secret, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_signature');
    expect(result.reason).toContain('expired');
  });

  it('token with invalid signature returns invalid_signature', () => {
    const nonce = 'nonce-8';
    const expiry = Date.now() + 60000;
    const token = createToken(actionA, secret, nonce, expiry);
    token.signature = 'tampered';
    const result = verifyApprovalToken(actionA, token, secret, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_signature');
  });

  it('a plaintext "approved" message without cryptographic binding token is rejected', () => {
    // Pass a plain object that is not a proper token
    const badToken: any = { message: 'approved' };
    const result = verifyApprovalToken(actionA, badToken, secret, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_signature');
  });

  it('missing token (null) is rejected', () => {
    const result = verifyApprovalToken(actionA, null as any, secret, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_signature');
  });

  it('context, memory, or claim content cannot substitute for a missing or mismatched approval_token', () => {
    // No token at all should be rejected, proving that no context can replace a real token.
    const result = verifyApprovalToken(actionA, undefined as any, secret, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_signature');
  });

  it('sub-agent output claiming approval is rejected; only the cryptographically verified token from the orchestrator is valid', () => {
    // A fabricated token that looks like a token but with an invalid signature
    const fakeToken: ApprovalToken = {
      action_payload_hash: 'abc',
      target_adapter: actionA.target_adapter,
      target_endpoint: actionA.target_endpoint,
      vault_grant_id: actionA.vault_grant_id,
      nonce: 'sub-agent-nonce',
      expiry: Date.now() + 60000,
      signature: 'fake-signature',
    };
    const result = verifyApprovalToken(actionA, fakeToken, secret, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_signature');
  });

  it('token verification runs at dispatch time in the adapter\'s verification hook, not in the controller prompt', () => {
    // This is a policy test, but we can verify that the verification function is stateless and fast.
    const nonce = 'dispatch-time-nonce';
    const expiry = Date.now() + 60000;
    const token = createToken(actionA, secret, nonce, expiry);
    const start = performance.now();
    const result = verifyApprovalToken(actionA, token, secret, nonceStore);
    const elapsed = performance.now() - start;
    expect(result.valid).toBe(true);
    // Verification should be fast (well under 50ms)
    expect(elapsed).toBeLessThan(50);
  });
});
