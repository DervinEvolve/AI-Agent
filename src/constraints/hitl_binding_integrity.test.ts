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
    // First use succeeds
    const first = verifyActionBinding(baseAction, token, secretKey, nonceStore);
    expect(first.valid).toBe(true);
    // Second use with same nonce fails
    const second = verifyActionBinding(baseAction, token, secretKey, nonceStore);
    expect(second.valid).toBe(false);
    expect(second.reason).toBe('invalid_signature: nonce already consumed');
  });

  it('rejects plaintext "approved" as token (no proper HMAC binding)', () => {
    const result = verifyActionBinding(baseAction, 'approved', secretKey, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  it('accepts a correctly generated token', () => {
    const token = generateToken(baseAction);
    const result = verifyActionBinding(baseAction, token, secretKey, nonceStore);
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('ok');
  });

  it('rejects expired token', () => {
    const oldAction = { ...baseAction, timestamp: Date.now() - 6 * 60 * 1000 }; // 6 min ago
    const token = generateToken(oldAction);
    const result = verifyActionBinding(oldAction, token, secretKey, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('rejects token generated with wrong secret', () => {
    const wrongSecret = 'wrong-secret';
    const token = crypto
      .createHmac('sha256', wrongSecret)
      .update(canonicalizeAction(baseAction))
      .digest('base64');
    const result = verifyActionBinding(baseAction, token, secretKey, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  it('rejects tampered nonce (nonce mismatch invalidates signature)', () => {
    const token = generateToken(baseAction);
    const tamperedAction = { ...baseAction, nonce: 'different-nonce' };
    const result = verifyActionBinding(tamperedAction, token, secretKey, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  it('rejects tampered timestamp (timestamp mismatch invalidates signature)', () => {
    const token = generateToken(baseAction);
    const tamperedAction = { ...baseAction, timestamp: baseAction.timestamp + 1 };
    const result = verifyActionBinding(tamperedAction, token, secretKey, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  it('rejects tampered target_adapter', () => {
    const token = generateToken(baseAction);
    const tamperedAction = { ...baseAction, target_adapter: 'other_adapter' };
    const result = verifyActionBinding(tamperedAction, token, secretKey, nonceStore);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });
});
