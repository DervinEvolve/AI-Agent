import { redactSecrets } from './secret_redactor';

// Minimal interfaces to mock or simulate dependencies from Epoch 12 & 13
export interface VaultGrant {
  id: string;
  token: string;
  domainAllowlist: string[];
}

export interface BudgetTracker {
  reserve(bytes: number, operations: number): boolean;
}

export interface ApiClientInputs {
  action: 'discover_endpoints' | 'call_rest' | 'call_graphql' | 'validate_spec';
  api_identifier: string;
  openapi_spec_ref?: string;
  endpoint_path?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  parameters?: Record<string, any>;
  request_body?: Record<string, any>;
  graphql_query?: string;
  vault_grant_id?: string;
  purpose_justification: string;
}

export interface ApiClientOutputs {
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  status: 'ok' | 'failed' | 'policy_blocked' | 'budget_exhausted' | 'requires_user_approval' | 'schema_mismatch';
  response_body?: Record<string, any>;
  response_headers?: Record<string, string>;
  http_status?: number;
  tainted: true;
  provenance: {
    target_url: string;
    method: string;
    timestamp: string;
    vault_session_id?: string;
    bytes_received: number;
  };
  endpoints?: Array<{
    path: string;
    method: string;
    parameters?: string[];
    description?: string;
  }>;
}

export class StructuredApiIntegrationCapability {
  private vaultGrants: Map<string, VaultGrant> = new Map();
  private budgetTracker?: BudgetTracker;
  private approvedInteractiveSession: boolean = false;
  private rateLimitCounter: number = 0;
  private lastRequestTime: number = 0;

  constructor(options?: {
    budgetTracker?: BudgetTracker;
    approvedInteractiveSession?: boolean;
  }) {
    this.budgetTracker = options?.budgetTracker;
    this.approvedInteractiveSession = options?.approvedInteractiveSession || false;
  }

  public registerVaultGrant(grant: VaultGrant): void {
    this.vaultGrants.set(grant.id, grant);
  }

  public setApprovedInteractiveSession(approved: boolean): void {
    this.approvedInteractiveSession = approved;
  }

  /**
   * Main handler executing the api_client capability
   */
  public async execute(inputs: ApiClientInputs): Promise<ApiClientOutputs> {
    const timestamp = new Date().toISOString();
    const targetUrl = `https://${inputs.api_identifier}${inputs.endpoint_path || ''}`;

    // 1. Budget Accounting
    if (this.budgetTracker) {
      const success = this.budgetTracker.reserve(1024, 1);
      if (!success) {
        return {
          status: 'budget_exhausted',
          error: { code: 'BUDGET_EXHAUSTED', message: 'Insufficient resource budget', retryable: false },
          tainted: true,
          provenance: { target_url: targetUrl, method: inputs.method || 'GET', timestamp, bytes_received: 0 }
        };
      }
    }

    // 2. Outbound Security Policy Enforcement (Strict domain check)
    let grant: VaultGrant | undefined;
    if (inputs.vault_grant_id) {
      grant = this.vaultGrants.get(inputs.vault_grant_id);
    }

    const allowedDomains = grant ? grant.domainAllowlist : [];
    const isDomainAllowed = allowedDomains.some(domain => 
      inputs.api_identifier === domain || inputs.api_identifier.endsWith('.' + domain)
    );

    if (!isDomainAllowed) {
      return {
        status: 'policy_blocked',
        error: { code: 'DOMAIN_NOT_ALLOWLISTED', message: `Domain ${inputs.api_identifier} is not allowlisted in vault grant`, retryable: false },
        tainted: true,
        provenance: { target_url: targetUrl, method: inputs.method || 'GET', timestamp, bytes_received: 0 }
      };
    }

    // 3. Outbound Security Policy Enforcement (Blocking raw credentials in parameters/body)
    const rawSecretRegex = /(?:key|passwd|password|secret|token|auth|credential|private_key)\s*[:=]/i;
    const checkPayloadForSecrets = (payload: any): boolean => {
      if (!payload) return false;
      const str = JSON.stringify(payload);
      return rawSecretRegex.test(str);
    };

    if (checkPayloadForSecrets(inputs.parameters) || checkPayloadForSecrets(inputs.request_body)) {
      return {
        status: 'policy_blocked',
        error: { code: 'RAW_CREDS_DETECTED', message: 'Outbound payload contains raw credentials', retryable: false },
        tainted: true,
        provenance: { target_url: targetUrl, method: inputs.method || 'GET', timestamp, bytes_received: 0 }
      };
    }

    // 4. Rate-limiting Throttling and Backoff
    const now = Date.now();
    if (now - this.lastRequestTime < 100) { // 100ms rapid request threshold
      this.rateLimitCounter++;
      if (this.rateLimitCounter > 3) {
        // Simulate backoff delay
        await new Promise(resolve => setTimeout(resolve, 50));
        this.rateLimitCounter = 0;
      }
    } else {
      this.rateLimitCounter = 0;
    }
    this.lastRequestTime = now;

    // 5. Action Handlers
    if (inputs.action === 'discover_endpoints') {
      return this.handleDiscoverEndpoints(inputs, targetUrl, timestamp);
    }

    if (inputs.action === 'validate_spec') {
      return this.handleValidateSpec(inputs, targetUrl, timestamp);
    }

    if (inputs.action === 'call_graphql') {
      return this.handleCallGraphQL(inputs, targetUrl, timestamp, grant);
    }

    if (inputs.action === 'call_rest') {
      return this.handleCallRest(inputs, targetUrl, timestamp, grant);
    }

    return {
      status: 'failed',
      error: { code: 'INVALID_ACTION', message: `Action ${inputs.action} is not supported`, retryable: false },
      tainted: true,
      provenance: { target_url: targetUrl, method: inputs.method || 'GET', timestamp, bytes_received: 0 }
    };
  }

  private handleDiscoverEndpoints(inputs: ApiClientInputs, targetUrl: string, timestamp: string): ApiClientOutputs {
    if (!inputs.openapi_spec_ref) {
      return {
        status: 'failed',
        error: { code: 'MISSING_SPEC_REF', message: 'openapi_spec_ref is required for discover_endpoints', retryable: false },
        tainted: true,
        provenance: { target_url: targetUrl, method: 'GET', timestamp, bytes_received: 0 }
      };
    }

    // Parse mock OpenAPI Spec
    try {
      const spec = JSON.parse(inputs.openapi_spec_ref);
      const endpoints: Array<{ path: string; method: string; parameters?: string[]; description?: string }> = [];
      
      if (spec.paths) {
        for (const path of Object.keys(spec.paths)) {
          for (const method of Object.keys(spec.paths[path])) {
            const details = spec.paths[path][method];
            endpoints.push({
              path,
              method: method.toUpperCase(),
              description: details.description || details.summary || '',
              parameters: details.parameters?.map((p: any) => p.name) || []
            });
          }
        }
      }

      return {
        status: 'ok',
        endpoints,
        tainted: true,
        provenance: { target_url: targetUrl, method: 'GET', timestamp, bytes_received: JSON.stringify(endpoints).length }
      };
    } catch (e) {
      return {
        status: 'schema_mismatch',
        error: { code: 'SPEC_PARSE_FAILED', message: 'Failed to parse openapi_spec_ref JSON', retryable: false },
        tainted: true,
        provenance: { target_url: targetUrl, method: 'GET', timestamp, bytes_received: 0 }
      };
    }
  }

  private handleValidateSpec(inputs: ApiClientInputs, targetUrl: string, timestamp: string): ApiClientOutputs {
    if (!inputs.openapi_spec_ref) {
      return {
        status: 'schema_mismatch',
        error: { code: 'MISSING_SPEC_REF', message: 'openapi_spec_ref is required for validate_spec', retryable: false },
        tainted: true,
        provenance: { target_url: targetUrl, method: 'GET', timestamp, bytes_received: 0 }
      };
    }
    try {
      const parsed = JSON.parse(inputs.openapi_spec_ref);
      if (!parsed.openapi && !parsed.swagger) {
        throw new Error('Not a valid OpenAPI schema');
      }
      return {
        status: 'ok',
        tainted: true,
        provenance: { target_url: targetUrl, method: 'GET', timestamp, bytes_received: 0 }
      };
    } catch (e: any) {
      return {
        status: 'schema_mismatch',
        error: { code: 'INVALID_OPENAPI_SPEC', message: e.message || 'Invalid spec schema', retryable: false },
        tainted: true,
        provenance: { target_url: targetUrl, method: 'GET', timestamp, bytes_received: 0 }
      };
    }
  }

  private handleCallGraphQL(inputs: ApiClientInputs, targetUrl: string, timestamp: string, grant?: VaultGrant): ApiClientOutputs {
    const query = inputs.graphql_query || '';
    
    // Basic GraphQL validation
    if (!query.includes('query') && !query.includes('mutation')) {
      return {
        status: 'schema_mismatch',
        error: { code: 'INVALID_GRAPHQL_SYNTAX', message: 'GraphQL query must contain query or mutation definition', retryable: false },
        tainted: true,
        provenance: { target_url: targetUrl, method: 'POST', timestamp, bytes_received: 0 }
      };
    }

    // User approval check for state-changing mutations
    const isMutation = query.trim().startsWith('mutation');
    if (isMutation && !this.approvedInteractiveSession) {
      return {
        status: 'requires_user_approval',
        tainted: true,
        provenance: { target_url: targetUrl, method: 'POST', timestamp, bytes_received: 0 }
      };
    }

    // Simulated execution
    const rawResponse = {
      data: {
        message: 'GraphQL executed successfully',
        token: 'secret-auth-token-should-be-redacted'
      }
    };

    // Injected token header simulation
    const responseHeaders: Record<string, string> = {
      'content-type': 'application/json'
    };
    if (grant) {
      responseHeaders['x-vault-session-id'] = grant.id;
    }

    // Redact response using secret_redactor
    const redactedBody = JSON.parse(redactSecrets(JSON.stringify(rawResponse)));

    return {
      status: 'ok',
      response_body: redactedBody,
      response_headers: responseHeaders,
      http_status: 200,
      tainted: true,
      provenance: {
        target_url: targetUrl,
        method: 'POST',
        timestamp,
        vault_session_id: grant?.id,
        bytes_received: JSON.stringify(redactedBody).length
      }
    };
  }

  private handleCallRest(inputs: ApiClientInputs, targetUrl: string, timestamp: string, grant?: VaultGrant): ApiClientOutputs {
    const method = inputs.method || 'GET';
    const stateChangingMethods = ['POST', 'PUT', 'DELETE', 'PATCH'];

    // User approval check for state-changing HTTP methods
    if (stateChangingMethods.includes(method) && !this.approvedInteractiveSession) {
      return {
        status: 'requires_user_approval',
        tainted: true,
        provenance: { target_url: targetUrl, method, timestamp, bytes_received: 0 }
      };
    }

    // Simulated Payload size limit of 1MB
    const simulatedResponseSize = 500; // standard payload
    if (simulatedResponseSize > 1024 * 1024) {
      return {
        status: 'failed',
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Payload exceeds maximum limit of 1MB', retryable: false },
        tainted: true,
        provenance: { target_url: targetUrl, method, timestamp, bytes_received: 0 }
      };
    }

    // Simulated execution
    const rawResponse = {
      status: 'success',
      data: {
        id: 42,
        secret_key: 'supersecret_value_to_redact',
        message: 'Rest endpoint invoked successfully'
      }
    };

    // Redact response using secret_redactor
    const redactedBody = JSON.parse(redactSecrets(JSON.stringify(rawResponse)));

    const responseHeaders: Record<string, string> = {
      'content-type': 'application/json'
    };
    if (grant) {
      responseHeaders['x-vault-session-id'] = grant.id;
    }

    return {
      status: 'ok',
      response_body: redactedBody,
      response_headers: responseHeaders,
      http_status: 200,
      tainted: true,
      provenance: {
        target_url: targetUrl,
        method,
        timestamp,
        vault_session_id: grant?.id,
        bytes_received: JSON.stringify(redactedBody).length
      }
    };
  }
}
