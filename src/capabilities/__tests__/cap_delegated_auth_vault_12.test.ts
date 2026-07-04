import { describe, it, expect, beforeEach } from 'vitest';
import { DelegatedAuthVault } from '../cap_delegated_auth_vault_12';

describe('cap_delegated_auth_vault_12 - Comprehensive Vault Integration Tests', () => {
  let vault: DelegatedAuthVault;

  beforeEach(() => {
    vault = new DelegatedAuthVault();
  });

  it('should list pre-authorized grants with all expected metadata', async () => {
    const response = await vault.execute({
      action: 'list_grants'
    });
    expect(response.status).toBe('ok');
    expect(response.available_grants).toBeDefined();
    expect(response.available_grants?.length).toBeGreaterThan(0);
    
    const grant = response.available_grants?.find(g => g.grant_id === 'grant-github-prod');
    expect(grant).toBeDefined();
    expect(grant?.provider).toBe('github');
    expect(grant?.scope).toContain('repo');
  });

  it('should grant masked token metadata for a valid grant and sufficient justification', async () => {
    const response = await vault.execute({
      action: 'request_token',
      grant_id: 'grant-github-prod',
      purpose_justification: 'Deploying release artifacts via GitHub actions'
    });
    expect(response.status).toBe('ok');
    expect(response.token_metadata).toBeDefined();
    expect(response.token_metadata?.masked_token).toContain('...');
    expect(response.token_metadata?.masked_token).not.toContain('SecureLiveGitHubTokenProd123456789');
  });

  it('should reject token requests with empty or insufficient justification', async () => {
    const response = await vault.execute({
      action: 'request_token',
      grant_id: 'grant-github-prod',
      purpose_justification: 'abc' // Too short!
    });
    expect(response.status).toBe('denied');
    expect(response.error?.message).toContain('justification');
  });

  it('should reject token requests for non-existent grant IDs', async () => {
    const response = await vault.execute({
      action: 'request_token',
      grant_id: 'non-existent-grant-id',
      purpose_justification: 'Legitimate justification for non-existent grant'
    });
    expect(response.status).toBe('denied');
  });

  it('should sign payloads using private keys and return signature without leaking the key', async () => {
    const payload = 'test-payload-to-sign-123456';
    const response = await vault.execute({
      action: 'sign_payload',
      grant_id: 'grant-github-prod',
      payload_to_sign: payload,
      purpose_justification: 'Signing release commit hash for integrity verification'
    });
    expect(response.status).toBe('ok');
    expect(response.signed_signature).toBeDefined();
    expect(typeof response.signed_signature).toBe('string');
    expect(response.signed_signature).not.toContain('PRIVATE KEY');
  });

  it('should successfully verify vault status and session provenance', async () => {
    const response = await vault.execute({
      action: 'verify_vault_status'
    });
    expect(response.status).toBe('ok');
    expect(response.provenance).toBeDefined();
    expect(response.provenance.vault_session_id).toBeDefined();
    expect(response.provenance.tainted).toBe(false);
  });

  it('should redact sensitive raw tokens from outbound adapter strings', () => {
    const rawSensitiveString = 'Deploying with token: ghp_SecureLiveGitHubTokenProd123456789 and confidential properties';
    const redacted = vault.redactOutboundString(rawSensitiveString);
    expect(redacted).not.toContain('ghp_SecureLiveGitHubTokenProd123456789');
    expect(redacted).toContain('[REDACTED_SECRET_TOKEN]');
  });

  it('should redact raw private keys from outbound adapter strings', () => {
    const privateKeyString = 'Payload dump: -----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7e...\n-----END PRIVATE KEY-----';
    const redacted = vault.redactOutboundString(privateKeyString);
    expect(redacted).not.toContain('-----BEGIN PRIVATE KEY-----');
    expect(redacted).toContain('[REDACTED_PRIVATE_KEY]');
  });
});
