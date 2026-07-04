import { redactSecrets, detectSecrets } from '../capabilities/secret_redactor';

export interface ClaimData {
  id: string;
  content: any;
  tainted?: boolean;
  evidence?: any;
}

export interface UsageContext {
  purpose: 'authorization' | 'hitl_gate' | 'tool_argument' | 'memory_write' | 'skill_verification' | 'milestone_completion';
  toolName?: string;
}

export interface ValidationError {
  rule: string;
  message: string;
}

/**
 * Validates that a claim is not used for prohibited purposes.
 */
export function validateClaim(claim: ClaimData, context: UsageContext): ValidationError[] {
  const errors: ValidationError[] = [];

  if (context.purpose === 'authorization') {
    errors.push({ rule: 'no-authorization', message: 'Claim cannot be used for authorization.' });
  }
  if (context.purpose === 'hitl_gate') {
    errors.push({ rule: 'no-hitl-gate', message: 'Claim cannot satisfy HITL gate or serve as approval token.' });
  }
  if (context.purpose === 'tool_argument') {
    errors.push({ rule: 'no-tool-argument', message: 'Claim cannot directly set tool arguments without independent validation.' });
  }
  if (context.purpose === 'memory_write') {
    errors.push({ rule: 'no-direct-memory-write', message: 'Claim cannot directly write long-term memory.' });
  }
  if (context.purpose === 'skill_verification' || context.purpose === 'milestone_completion') {
    if (claim.tainted) {
      errors.push({ rule: 'no-taint-clearing', message: `Tainted claim cannot be used for ${context.purpose}.` });
    }
  }

  return errors;
}

/**
 * Checks whether a claim can be stored. If it contains raw secrets,
 * it attempts to redact them. If redaction makes the claim ambiguous,
 * storage is rejected.
 */
export function validateClaimForStorage(claim: ClaimData): {
  valid: boolean;
  errors: ValidationError[];
  redacted?: ClaimData;
} {
  const errors: ValidationError[] = [];
  const contentStr = JSON.stringify(claim.content);
  if (detectSecrets(contentStr)) {
    const redactedStr = redactSecrets(contentStr);
    if (isAmbiguous(contentStr, redactedStr)) {
      errors.push({
        rule: 'secret-redaction-ambiguity',
        message: 'Claim contains raw secret; redaction makes it ambiguous, storage rejected.',
      });
      return { valid: false, errors };
    }
    // Return a version with redacted content
    const redactedClaim: ClaimData = { ...claim, content: JSON.parse(redactedStr) };
    return { valid: true, errors, redacted: redactedClaim };
  }
  return { valid: true, errors };
}

/**
 * Sanitizes a claim for export by removing internal-only metadata
 * and redacting any raw secrets.
 */
export function sanitizeClaimForExport(claim: ClaimData): ClaimData {
  const sanitized = { ...claim };
  // Strip internal metadata fields
  delete (sanitized as any).internalMetadata;
  delete (sanitized as any).authState;
  // Redact secrets
  const contentStr = JSON.stringify(sanitized.content);
  if (detectSecrets(contentStr)) {
    sanitized.content = JSON.parse(redactSecrets(contentStr));
  }
  return sanitized;
}

function isAmbiguous(original: string, redacted: string): boolean {
  try {
    const originalObj = JSON.parse(original);
    const redactedObj = JSON.parse(redacted);
    const originalHasMeaningful = hasMeaningfulLeaf(originalObj);
    const redactedAllPlaceholder = allLeavesArePlaceholder(redactedObj);
    return originalHasMeaningful && redactedAllPlaceholder;
  } catch {
    // Simple string comparison fallback
    const redactedTrimmed = redacted.trim();
    if (redactedTrimmed === '' || redactedTrimmed === '[REDACTED]') {
      return original.trim().length > 0;
    }
    return false;
  }
}

function hasMeaningfulLeaf(obj: any): boolean {
  if (typeof obj !== 'object' || obj === null) {
    return typeof obj === 'string' && obj.length > 0;
  }
  for (const value of Object.values(obj)) {
    if (typeof value === 'object' && value !== null) {
      if (hasMeaningfulLeaf(value)) return true;
    } else if (typeof value === 'string' && value.length > 0 && value !== '[REDACTED]') {
      return true;
    } else if (typeof value !== 'string' && value !== undefined) {
      return true;
    }
  }
  return false;
}

function allLeavesArePlaceholder(obj: any): boolean {
  if (typeof obj !== 'object' || obj === null) {
    return typeof obj === 'string' && (obj === '' || obj === '[REDACTED]');
  }
  for (const value of Object.values(obj)) {
    if (!allLeavesArePlaceholder(value)) return false;
  }
  return true;
}

export const constraint = {
  id: 'con_claim_ledger_non_authority_19',
  name: 'Claim ledger non-authority and taint preservation',
  status: 'active' as const,
  addedEpoch: 19,
  description: `The claim ledger must never be used to authorize side effects, clear taint, satisfy HITL confirmation requirements, directly set tool arguments, directly write long-term memory, or substitute for validated evidence. Claims are advisory synthesis only and must be independently validated before any action. Tainted claims remain tainted and cannot be used as sole evidence for success criteria, milestone completion, or skill verification. The ledger must not store raw secrets, OAuth tokens, private keys, browser cookies, approval tokens, or live auth state.`,
  validateClaim,
  validateClaimForStorage,
  sanitizeClaimForExport,
};
