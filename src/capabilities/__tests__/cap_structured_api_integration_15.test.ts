import { describe, it, expect, beforeEach } from 'vitest';
import { StructuredApiIntegrationCapability, BudgetTracker } from '../cap_structured_api_integration_15';

describe('cap_structured_api_integration_15 - Sandboxed external API integration', () => {
  let capability: StructuredApiIntegrationCapability;
  let mockBudgetTracker: BudgetTracker;
  let budgetReserveSuccess: boolean;

  beforeEach(() => {
    budgetReserveSuccess = true;
    mockBudgetTracker = {
      reserve: () => budgetReserveSuccess
    };
    capability = new StructuredApiIntegrationCapability({
      budgetTracker: mockBudgetTracker
    });
    
    // Register a valid vault grant for testing
    capability.registerVaultGrant({
      id: 'grant_123',
      token: 'masked-auth-token-xyz',
      domainAllowlist: ['api.github.com', 'api.stripe.com']
    });
  });

  it('discover_endpoints parses an OpenAPI spec artifact and returns endpoints list', async () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/v1/users': {
          get: {
            summary: 'List users',
            parameters: [{ name: 'limit', in: 'query' }]
          }
        }
      }
    };

    const result = await capability.execute({
      action: 'discover_endpoints',
      api_identifier: 'api.github.com',
      openapi_spec_ref: JSON.stringify(spec),
      purpose_justification: 'Fetch endpoints for integration'
    });

    expect(result.status).toBe('ok');
    expect(result.endpoints).toBeDefined();
    expect(result.endpoints?.[0].path).toBe('/v1/users');
    expect(result.endpoints?.[0].method).toBe('GET');
    expect(result.endpoints?.[0].parameters).toContain('limit');
  });

  it('call_rest with an invalid or unallowlisted domain is rejected', async () => {
    const result = await capability.execute({
      action: 'call_rest',
      api_identifier: 'untrusted-domain.com',
      endpoint_path: '/v1/data',
      method: 'GET',
      vault_grant_id: 'grant_123',
      purpose_justification: 'Attempt untrusted access'
    });

    expect(result.status).toBe('policy_blocked');
    expect(result.error?.code).toBe('DOMAIN_NOT_ALLOWLISTED');
  });

  it('call_rest automatically injects vault grant headers and validates with allowlist', async () => {
    const result = await capability.execute({
      action: 'call_rest',
      api_identifier: 'api.github.com',
      endpoint_path: '/user',
      method: 'GET',
      vault_grant_id: 'grant_123',
      purpose_justification: 'Fetch authorized user profile'
    });

    expect(result.status).toBe('ok');
    expect(result.response_headers?.['x-vault-session-id']).toBe('grant_123');
    expect(result.provenance.vault_session_id).toBe('grant_123');
  });

  it('call_rest containing raw secrets in fields is rejected by policy_enforcer', async () => {
    const result = await capability.execute({
      action: 'call_rest',
      api_identifier: 'api.github.com',
      endpoint_path: '/user',
      method: 'GET',
      vault_grant_id: 'grant_123',
      parameters: {
        api_key: 'raw-unmasked-token-123'
      },
      purpose_justification: 'Fetch profile with credentials'
    });

    expect(result.status).toBe('policy_blocked');
    expect(result.error?.code).toBe('RAW_CREDS_DETECTED');
  });

  it('API responses are automatically redacted by secret_redactor', async () => {
    const result = await capability.execute({
      action: 'call_rest',
      api_identifier: 'api.github.com',
      endpoint_path: '/debug',
      method: 'GET',
      vault_grant_id: 'grant_123',
      purpose_justification: 'Fetch debug info'
    });

    expect(result.status).toBe('ok');
    // Verify that the simulated mock key value is redacted
    const bodyString = JSON.stringify(result.response_body);
    expect(bodyString).not.toContain('supersecret_value_to_redact');
  });

  it('GraphQL queries are validated before dispatch', async () => {
    const result = await capability.execute({
      action: 'call_graphql',
      api_identifier: 'api.github.com',
      graphql_query: 'invalid { syntax }',
      vault_grant_id: 'grant_123',
      purpose_justification: 'Execute GraphQL query'
    });

    expect(result.status).toBe('schema_mismatch');
    expect(result.error?.code).toBe('INVALID_GRAPHQL_SYNTAX');
  });

  it('state-changing REST methods trigger requires_user_approval when not pre-approved', async () => {
    const result = await capability.execute({
      action: 'call_rest',
      api_identifier: 'api.github.com',
      endpoint_path: '/v1/users',
      method: 'POST',
      vault_grant_id: 'grant_123',
      purpose_justification: 'Create new user'
    });

    expect(result.status).toBe('requires_user_approval');
  });

  it('state-changing REST methods succeed when interactive session is approved', async () => {
    capability.setApprovedInteractiveSession(true);
    const result = await capability.execute({
      action: 'call_rest',
      api_identifier: 'api.github.com',
      endpoint_path: '/v1/users',
      method: 'POST',
      vault_grant_id: 'grant_123',
      purpose_justification: 'Create new user'
    });

    expect(result.status).toBe('ok');
  });

  it('returns budget_exhausted if BudgetTracker fails reservation', async () => {
    budgetReserveSuccess = false;
    const result = await capability.execute({
      action: 'call_rest',
      api_identifier: 'api.github.com',
      endpoint_path: '/v1/users',
      method: 'GET',
      vault_grant_id: 'grant_123',
      purpose_justification: 'Normal fetch'
    });

    expect(result.status).toBe('budget_exhausted');
  });
});
