import { describe, it, expect, beforeEach } from 'vitest';
import { StructuredApiIntegrationCapability, BudgetTracker } from '../cap_structured_api_integration_15';

describe('cap_structured_api_integration_15 - Robust and Complete Coverage', () => {
  let capability: StructuredApiIntegrationCapability;
  let mockBudgetTracker: BudgetTracker;
  let budgetReserveSuccess = true;

  beforeEach(() => {
    budgetReserveSuccess = true;
    mockBudgetTracker = {
      reserve: (_bytes: number, _operations: number) => budgetReserveSuccess
    };
    capability = new StructuredApiIntegrationCapability({
      budgetTracker: mockBudgetTracker
    });

    capability.registerVaultGrant({
      id: 'grant_123',
      token: 'super-secret-vault-token-xyz',
      domainAllowlist: ['api.github.com', 'api.stripe.com']
    });
  });

  it('should successfully parse a valid OpenAPI specification string', async () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/v1/emails/send': {
          post: {
            summary: 'Send an email',
            parameters: [{ name: 'api_key', in: 'header' }]
          }
        }
      }
    };

    const res = await capability.execute({
      action: 'discover_endpoints',
      api_identifier: 'api.github.com',
      openapi_spec_ref: JSON.stringify(spec),
      purpose_justification: 'Discover email endpoint details'
    });

    expect(res.status).toBe('ok');
    expect(res.endpoints).toBeDefined();
    expect(res.endpoints?.[0].path).toBe('/v1/emails/send');
    expect(res.endpoints?.[0].method).toBe('POST');
    expect(res.endpoints?.[0].parameters).toContain('api_key');
  });

  it('should fail with policy_blocked when domain is not in the allowlist', async () => {
    const res = await capability.execute({
      action: 'call_rest',
      api_identifier: 'malicious-domain.com',
      endpoint_path: '/v1/data',
      method: 'GET',
      vault_grant_id: 'grant_123',
      purpose_justification: 'Exfiltrate some info'
    });

    expect(res.status).toBe('policy_blocked');
    expect(res.error?.code).toBe('DOMAIN_NOT_ALLOWED');
  });

  it('should fail with budget_exhausted when BudgetTracker reserves false', async () => {
    budgetReserveSuccess = false;
    const res = await capability.execute({
      action: 'call_rest',
      api_identifier: 'api.github.com',
      endpoint_path: '/v1/users',
      method: 'GET',
      vault_grant_id: 'grant_123',
      purpose_justification: 'Fetch user details'
    });

    expect(res.status).toBe('budget_exhausted');
  });
});
