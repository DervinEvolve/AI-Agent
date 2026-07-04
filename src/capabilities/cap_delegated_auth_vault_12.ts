/**
 * Trusted secrets vault and delegated-authority channel capability (cap_delegated_auth_vault_12).
 * 
 * Enforces absolute isolation of raw credentials from LLMs, sandboxes, and logs.
 * Safe token injection into vetted adapters is simulated via secure memory-isolated boundaries,
 * and outbound strings are actively redacted of any secret-leak signatures.
 */

import * as crypto from 'crypto';

// Types matching the specification
export interface VaultInput {
  action: 'list_grants' | 'request_token' | 'sign_payload' | 'verify_vault_status';
  grant_id?: string;
  payload_to_sign?: string;
  token_lifetime_seconds?: number;
  purpose_justification?: string;
}

export interface TokenMetadata {
  masked_token: string;
  expires_at: string;
  scope: string[];
  provider: string;
}

export interface AvailableGrant {
  grant_id: string;
  provider: string;
  scope: string[];
  description: string;
  requires_approval_for_use: boolean;
}

export interface VaultProvenance {
  vault_session_id: string;
  timestamp: string;
  tainted: boolean;
}

export interface VaultOutput {
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  status: 'ok' | 'denied' | 'policy_blocked' | 'budget_exhausted' | 'requires_user_approval';
  token_metadata?: TokenMetadata;
  signed_signature?: string;
  available_grants?: AvailableGrant[];
  provenance: VaultProvenance;
}

// Simulated isolated secrets vault database (not accessible to other files/subagents)
const SECRETS_DB: Record<string, { rawToken: string; privateKey: string; provider: string; scope: string[]; description: string; requiresApproval: boolean }> = {
  'grant-github-prod': {
    rawToken: 'ghp_SecureLiveGitHubTokenProd123456789',
    privateKey: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7e...\n-----END PRIVATE KEY-----',
    provider: 'github',
    scope: ['repo', 'write:packages'],
    description: 'Production GitHub integration grant',
    requiresApproval: false,
  },
  'grant-aws-billing': {
    rawToken: 'AKIA_SUPER_SECRET_AWS_BILLING_KEY_XYZ_987',
    privateKey: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDh3...\n-----END PRIVATE KEY-----',
    provider: 'aws',
    scope: ['billing:Read'],
    description: 'AWS billing read-only access',
    requiresApproval: true,
  },
};

/**
 * Secure Memory-Isolated Vault Host Emulator
 */
export class DelegatedAuthVault {
  private sessionId: string;
  private budgetRemaining: number = 100;
  private activeTokens: Map<string, { raw: string; expiresAt: Date }> = new Map();
  private activeGrants: Record<string, typeof SECRETS_DB[string]> = SECRETS_DB;

  constructor() {
    this.sessionId = `vault-sess-${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * Returns the current session ID.
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Checks and consumes atomic budget for vault operations.
   */
  private reserveBudget(amount: number = 10): boolean {
    if (this.budgetRemaining < amount) {
      return false;
    }
    this.budgetRemaining -= amount;
    return true;
  }

  /**
   * Primary entrypoint for the vault_auth tool capability.
   */
  public async execute(input: VaultInput): Promise<VaultOutput> {
    const timestamp = new Date().toISOString();
    const provenance: VaultProvenance = {
      vault_session_id: this.sessionId,
      timestamp,
      tainted: false,
    };

    // 1. Budget reservation check
    if (!this.reserveBudget(10)) {
      return {
        status: 'budget_exhausted',
        error: { code: 'BUDGET_EXHAUSTED', message: 'Vault process has exhausted its atomic budget reservation.', retryable: true },
        provenance,
      };
    }

    // 2. Action routing
    switch (input.action) {
      case 'verify_vault_status': {
        return {
          status: 'ok',
          provenance,
        };
      }

      case 'list_grants': {
        const available_grants: AvailableGrant[] = Object.entries(this.activeGrants).map(([id, val]) => ({
          grant_id: id,
          provider: val.provider,
          scope: val.scope,
          description: val.description,
          requires_approval_for_use: val.requiresApproval,
        }));
        return {
          status: 'ok',
          available_grants,
          provenance,
        };
      }

      case 'request_token': {
        const { grant_id, purpose_justification, token_lifetime_seconds = 300 } = input;

        if (!grant_id) {
          return {
            status: 'denied',
            error: { code: 'MISSING_GRANT_ID', message: 'grant_id is required for request_token action.', retryable: false },
            provenance,
          };
        }

        const grant = this.activeGrants[grant_id];
        if (!grant) {
          return {
            status: 'denied',
            error: { code: 'UNAUTHORIZED_GRANT', message: `The requested grant_id '${grant_id}' was not found or is unauthorized.`, retryable: false },
            provenance,
          };
        }

        // Enforce explicit non-empty and non-specific justification checks
        if (!purpose_justification || purpose_justification.trim().length < 10) {
          return {
            status: 'denied',
            error: {
              code: 'INVALID_JUSTIFICATION',
              message: 'A detailed, explicit purpose_justification (at least 10 characters) is required to access credential tokens.',
              retryable: false,
            },
            provenance,
          };
        }

        const genericPhrases = ['test', 'testing', 'run tool', 'just because', 'auth please', 'no reason', 'placeholder'];
        if (genericPhrases.some(phrase => purpose_justification.toLowerCase().trim() === phrase)) {
          return {
            status: 'denied',
            error: {
              code: 'INVALID_JUSTIFICATION',
              message: 'The provided justification is too generic or non-specific.',
              retryable: false,
            },
            provenance,
          };
        }

        if (grant.requiresApproval) {
          return {
            status: 'requires_user_approval',
            error: { code: 'APPROVAL_REQUIRED', message: 'This sensitive grant requires explicit user confirmation.', retryable: false },
            provenance,
          };
        }

        const lifetime = Math.min(Math.max(token_lifetime_seconds, 15), 1800);
        const expiresAtDate = new Date(Date.now() + lifetime * 1000);

        // Mask the token to prevent raw exposure to LLMs/logs
        const masked_token = this.maskTokenValue(grant.rawToken);

        // Keep raw token strictly inside memory-isolated vault registry
        this.activeTokens.set(masked_token, {
          raw: grant.rawToken,
          expiresAt: expiresAtDate,
        });

        return {
          status: 'ok',
          token_metadata: {
            masked_token,
            expires_at: expiresAtDate.toISOString(),
            scope: grant.scope,
            provider: grant.provider,
          },
          provenance,
        };
      }

      case 'sign_payload': {
        const { grant_id, payload_to_sign } = input;
        if (!grant_id || !payload_to_sign) {
          return {
            status: 'denied',
            error: { code: 'MISSING_PARAMS', message: 'Both grant_id and payload_to_sign are required.', retryable: false },
            provenance,
          };
        }

        const grant = this.activeGrants[grant_id];
        if (!grant) {
          return {
            status: 'denied',
            error: { code: 'UNAUTHORIZED_GRANT', message: 'The requested grant_id was not found.', retryable: false },
            provenance,
          };
        }

        // Perform cryptographic signature internally without ever returning or leaking the private key
        const signer = crypto.createSign('SHA256');
        signer.update(payload_to_sign);
        // Generate a deterministic or pseudo-signature using the key length/hash for safety
        const signed_signature = crypto.createHmac('sha256', grant.privateKey).update(payload_to_sign).digest('hex');

        return {
          status: 'ok',
          signed_signature,
          provenance,
        };
      }

      default: {
        return {
          status: 'denied',
          error: { code: 'INVALID_ACTION', message: `Unknown vault action.`, retryable: false },
          provenance,
        };
      }
    }
  }

  /**
   * Mask a token value for safe transport to non-secure contexts.
   */
  private maskTokenValue(token: string): string {
    if (token.length <= 8) {
      return '********';
    }
    return `${token.slice(0, 4)}...${token.slice(-4)}`;
  }

  /**
   * Redacts any active credentials or raw secret patterns from outbound adapter payloads or logs
   */
  public redactOutbound(content: string): string {
    let redacted = content;
    // Redact all known raw secrets
    for (const grant of Object.values(this.activeGrants)) {
      if (grant.rawToken && redacted.includes(grant.rawToken)) {
        redacted = redacted.replace(new RegExp(this.escapeRegExp(grant.rawToken), 'g'), '[REDACTED_SECRET_TOKEN]');
      }
      if (grant.privateKey && redacted.includes(grant.privateKey)) {
        redacted = redacted.replace(new RegExp(this.escapeRegExp(grant.privateKey), 'g'), '[REDACTED_PRIVATE_KEY]');
      }
    }
    // Redact active dynamic raw tokens
    for (const tokenData of this.activeTokens.values()) {
      if (tokenData.raw && redacted.includes(tokenData.raw)) {
        redacted = redacted.replace(new RegExp(this.escapeRegExp(tokenData.raw), 'g'), '[REDACTED_DYNAMIC_TOKEN]');
      }
    }
    return redacted;
  }

  /**
   * Any attempt to extract raw secret bytes returns policy_blocked
   */
  public requestRawSecretBytes(grant_id: string, requesterContext: string): never | { status: 'policy_blocked'; error: object } {
    return {
      status: 'policy_blocked',
      error: {
        code: 'ACCESS_DENIED',
        message: `Direct extraction of raw secrets by '${requesterContext}' is fundamentally blocked by the security contract.`,
        retryable: false,
      },
    };
  }

  private escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
