export interface Constraint {
  id: string;
  name: string;
  status: 'active' | 'inactive';
  added_epoch: number;
  description: string;
}

export const CONSTRAINTS: Constraint[] = [
  {
    id: "con_secrets_leak_prevention_12",
    name: "Absolute credential isolation and leak prevention",
    status: "active",
    added_epoch: 12,
    description: "The agent must NEVER expose raw secrets, API keys, private keys, passwords, or OAuth tokens to any LLM prompt, python sandbox, browser DOM, document parser, sub-agent, log, or long-term memory. All credential usage must occur via the vault_auth capability, which injects tokens directly into authorized, policy-vetted adapters at network dispatch time. Any output, log, or observation containing an apparent credential or private key signature must be automatically redacted by the host controller's secret_redactor before processing, and any attempt by the agent or a sub-agent to exfiltrate or print vault metadata must result in an immediate policy_blocked status and hard session termination."
  }
];

/**
 * Secret Redactor regex patterns to match typical secret structures:
 * - API Keys / Tokens (e.g., sk-proj-..., ghp_..., sb_..., secret_...)
 * - Private Key Headers (e.g., -----BEGIN PRIVATE KEY-----)
 * - Exfiltration of vault metadata patterns (e.g., trying to read/print vault environment variables or files like /vault/metadata, process.env.VAULT_)
 */
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /secret_[a-zA-Z0-9]{16,}/g,
  /-----BEGIN[ A-Z0-9_-]+PRIVATE KEY-----([\s\S]*?)-----END[ A-Z0-9_-]+PRIVATE KEY-----/gi,
  /password\s*=\s*['"\s]*[a-zA-Z0-9_@#$!%^&*()-+=\[\]{}|;:',.<>?/~`]{8,}/gi,
  /bearer\s+[a-zA-Z0-9_\-\.]{15,}/gi
];

const VAULT_METADATA_EXFILTRATION_PATTERNS = [
  /\/vault\/metadata/i,
  /process\.env\.VAULT_/i,
  /ENV\[['"]VAULT_/i,
  /cat\s+[^\n]*vault/i,
  /metadata\s+exfiltration/i
];

export interface RedactionResult {
  safeContent: string;
  redactedCount: number;
  wasBlocked: boolean;
  reason?: string;
}

/**
 * Redacts sensitive credentials from the input text.
 * If an attempt to access vault metadata is detected, it triggers a policy block.
 */
export function redactAndCheckSecrets(content: string): RedactionResult {
  let safeContent = content;
  let redactedCount = 0;
  let wasBlocked = false;
  let reason: string | undefined;

  // Check for vault metadata exfiltration attempts
  for (const pattern of VAULT_METADATA_EXFILTRATION_PATTERNS) {
    if (pattern.test(content)) {
      wasBlocked = true;
      reason = "Exfiltration or printing of vault metadata detected. Session terminated under policy_blocked status.";
      return {
        safeContent: "[POLICY BLOCKED: SESSION TERMINATED]",
        redactedCount: 0,
        wasBlocked: true,
        reason
      };
    }
  }

  // Perform secret redaction
  for (const pattern of SECRET_PATTERNS) {
    safeContent = safeContent.replace(pattern, (match) => {
      redactedCount++;
      return "[REDACTED_SECRET]";
    });
  }

  return {
    safeContent,
    redactedCount,
    wasBlocked,
    reason
  };
}

/**
 * Vault Auth capability simulation / adapter layer
 * Strictly routes authorization and prevents raw credentials from leaking into prompts.
 */
export class VaultAuth {
  private static mockVault: Record<string, string> = {
    "OPENAI_API_KEY": "sk-proj-supersecretkey1234567890",
    "GITHUB_TOKEN": "ghp_myawesomegithubtokenforintegration1234",
    "DATABASE_PASSWORD": "password=MySuperSecurePassword123!"
  };

  /**
   * Executes a network dispatch action by securely injecting the authorized token at the dispatch boundary.
   * The raw token never returns to the agent prompt context.
   */
  public static async secureDispatch<T>(
    keyName: string,
    adapterFn: (token: string) => Promise<T>
  ): Promise<T> {
    const token = this.mockVault[keyName];
    if (!token) {
      throw new Error(`Credential key '${keyName}' not found or unauthorized in vault.`);
    }
    // Execute the adapter directly with the token, keeping it out of LLM/prompt contexts
    return await adapterFn(token);
  }
}
