import { describe, it, expect, beforeEach } from 'vitest';
import { DelegatedAuthVault } from '../cap_delegated_auth_vault_12';

describe('cap_delegated_auth_vault_12 - Trusted Secrets Vault capability', () => {
  let vault: DelegatedAuthVault;

  beforeEach(() => {
    vault = new DelegatedAuthVault();
  });

  it('list_grants returns available pre-authorized credentials with scopes and metadata', async () => {
    const response = await vault.execute({
      action: 'list_grants',
    });
    expect(response.status).toBe('ok');
    expect(response.available_grants).toBeDefined();
    expect(response.available_grants?.length).toBeGreaterThan(0);
    const firstGrant = response.available_grants?.[0];
    expect(firstGrant).toHaveProperty('grant_id');
    expect(firstGrant).toHaveProperty('provider');
    expect(firstGrant).toHaveProperty('scope');
    expect(firstGrant).toHaveProperty('description');
    expect(firstGrant).toHaveProperty('requires_approval_for_use');
    expect(response.provenance.vault_session_id).toMatch(/^vault-sess-/);
  });

  it('request_token with valid grant_id and justification returns masked_token metadata, never raw token', async () => {
    const response = await vault.execute({
      action: 'request_token',
      grant_id: 'grant-github-prod',
      purpose_justification: 'Automated workflow deployment to production environments.',
    });
    expect(response.status).toBe('ok');
    expect(response.token_metadata).toBeDefined();
    expect(response.token_metadata?.masked_token).toContain('...');
    expect(response.token_metadata?.masked_token).not.toContain('SecureLiveGitHubTokenProd123456789');
  });

  it('requesting a token for an unauthorized grant_id is rejected with denied', async () => {
    const response = await vault.execute({
      action: 'request_token',
      grant_id: 'non-existent-grant',
      purpose_justification: 'Need access to make database schema changes.',
    });
    expect(response.status).toBe('denied');
    expect(response.error?.code).toBe('UNAUTHORIZED_GRANT');
  });

  it('requesting a token with an empty or non-specific purpose_justification is rejected', async () => {
    const responseEmpty = await vault.execute({
      action: 'request_token',
      grant_id: 'grant-github-prod',
      purpose_justification: '',
    });
    expect(responseEmpty.status).toBe('denied');
    expect(responseEmpty.error?.code).toBe('INVALID_JUSTIFICATION');

    const responseGeneric = await vault.execute({
      action: 'request_token',
      grant_id: 'grant-github-prod',
      purpose_justification: 'test',
    });
    expect(responseGeneric.status).toBe('denied');
    expect(responseGeneric.error?.code).toBe('INVALID_JUSTIFICATION');
  });

  it('sign_payload uses vault-held keys to sign a payload and returns signature without exposing the private key', async () => {
    const response = await vault.execute({
      action: 'sign_payload',
      grant_id: 'grant-github-prod',
      payload_to_sign: 'my-payload-data-to-sign',
    });
    expect(response.status).toBe('ok');
    expect(response.signed_signature).toBeDefined();
    expect(typeof response.signed_signature).toBe('string');
  });

  it('any attempt to extract raw secret bytes from the vault process returns policy_blocked', () => {
    const response = vault.requestRawSecretBytes('grant-github-prod', 'run_python_sandbox');
    expect(response.status).toBe('policy_blocked');
    expect(response.error).toBeDefined();
  });

  it('vault checks for secret-leak signatures in all outbound adapter requests and redacts them if found', async () => {
    // Request token to register it inside vault
    await vault.execute({
      action: 'request_token',
      grant_id: 'grant-github-prod',
      purpose_justification: 'Vetted pipeline deployment action.',
    });

    const dangerousLog = 'Error connecting to endpoint with token ghp_SecureLiveGitHubTokenProd123456789 and key -----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7e...\n-----END PRIVATE KEY-----';
    const redactedLog = vault.redactOutbound(dangerousLog);

    expect(redactedLog).not.toContain('ghp_SecureLiveGitHubTokenProd123456789');
    expect(redactedLog).not.toContain('-----BEGIN PRIVATE KEY-----');
    expect(redactedLog).toContain('[REDACTED_SECRET_TOKEN]');
    expect(redactedLog).toContain('[REDACTED_PRIVATE_KEY]');
  });
});
