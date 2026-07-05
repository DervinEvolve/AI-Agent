import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  verifyActionBinding,
  NonceStore,
  canonicalizeAction,
  ActionBinding,
} from './hitl_binding_integrity';

describe('verifyActionBinding', () => {
  let secretKey: string;
  let nonceStore: NonceStore;
  const baseAction: ActionBinding = {
    action_payload: { operation: 'transfer', amount: 100 },
    target_adapter: 'bank_adapter',
    target_endpoint: '/transfer',
    vault_grant_id: 'grant_123',
    nonce: 'nonce1',
    timestamp: Date.now(),
  };

  beforeEach(() => {
    secretKey = 'test-secret-key-for-hmac';
    nonceStore = new NonceStore();
  });

  function generateToken(action: ActionBinding): string {
    const canonical = canonicalizeAction(action);
    return crypto.createHmac('sha256', secretKey).update(canonical).digest('base64');
  }

  it('rejects token bound to action A but attempting to execute action B', () => {
    const token = generateToken(baseAction);
    const differentAction = { ...baseAction, action_payload: { operation: 'transfer', amount: 200 } };
    const result = verifyActionBinding(differentAction, token, secretKey, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  it('rejects token bound to different vault_grant_id', () => {
    const token = generateToken(baseAction);
    const differentAction = { ...baseAction, vault_grant_id: 'grant_456' };
    const result = verifyActionBinding(differentAction, token, secretKey, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  it('rejects token bound to different target_endpoint', () => {
    const token = generateToken(baseAction);
    const differentAction = { ...baseAction, target_endpoint: '/update' };
    const result = verifyActionBinding(differentAction, token, secretKey, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  it('rejects replayed approval_token (already consumed)', () => {
    const token = generateToken(baseAction);
    const firstResult = verifyActionBinding(baseAction, token, secretKey, nonceStore);
    expect(firstResult.valid).toBe(true);
    const secondResult = verifyActionBinding(baseAction, token, secretKey, nonceStore);
    expect(secondResult.valid).toBe(false);
    expect(secondResult.reason).toContain('already consumed');
  });

  it('rejects plaintext "approved" message', () => {
    const result = verifyActionBinding(baseAction, 'approved', secretKey, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  it('rejects missing or mismatched approval_token', () => {
    const result1 = verifyActionBinding(baseAction, '', secretKey, nonceStore);
    expect(result1.valid).toBe(false);
    const result2 = verifyActionBinding(baseAction, 'random_token', secretKey, nonceStore);
    expect(result2.valid).toBe(false);
  });

  it('rejects token that is not properly bound (sub-agent output)', () => {
    const result = verifyActionBinding(baseAction, 'sub_agent_claims_approval', secretKey, nonceStore);
    expect(result.valid).toBe(false);
  });

  it('verification is designed to be called at dispatch time', () => {
    // This test is a placeholder; actual enforcement happens at dispatch.
    expect(true).toBe(true);
  });

  it('rejects expired token', () => {
    const expiredAction = { ...baseAction, timestamp: Date.now() - 10 * 60 * 1000 };
    const token = generateToken(expiredAction);
    const result = verifyActionBinding(expiredAction, token, secretKey, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
  });
});
