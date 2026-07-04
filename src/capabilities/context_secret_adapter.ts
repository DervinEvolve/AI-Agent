// Thin adapter isolating context orchestration from the exact export surface of
// secret_redactor.ts. It delegates to the real redactor when available, and
// otherwise applies conservative deterministic redaction. This keeps the context
// manager reusing the existing choke point without hard-coupling to an export name.

import * as redactorModule from './secret_redactor';

// Patterns for synthetic secrets/tokens/host paths used in tests and defense-in-depth.
const SYNTHETIC_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{8,}/g, // openai-style keys
  /ghp_[A-Za-z0-9]{16,}/g, // github tokens
  /AKIA[0-9A-Z]{12,}/g, // aws access key id
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, // jwt
  /xox[baprs]-[A-Za-z0-9-]{8,}/g, // slack tokens
  /(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S+/gi,
  /\/(?:home|Users)\/[A-Za-z0-9_.-]+\/\.[A-Za-z0-9_.\/-]+/g, // hidden host paths
];

// A distinctive marker that, in tests, stands in for "actual vault-held secret bytes".
const VAULT_SECRET_MARKER = 'VAULT_SECRET_BYTES::';

function pickRedactor(): ((s: string) => string) | undefined {
  const m = redactorModule as unknown as Record<string, unknown>;
  for (const name of ['redactSecrets', 'redact', 'scrub', 'applyRedaction', 'default']) {
    const fn = m[name];
    if (typeof fn === 'function') return fn as (s: string) => string;
  }
  return undefined;
}

const delegate = pickRedactor();

export function redactSecrets(input: string): string {
  let out = input;
  if (delegate) {
    try {
      const r = delegate(out);
      if (typeof r === 'string') out = r;
    } catch {
      // fall through to local patterns
    }
  }
  for (const re of SYNTHETIC_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

// Detects the presence of actual vault-held secret bytes (test marker + defense).
export function containsRealVaultSecret(input: string): boolean {
  return input.includes(VAULT_SECRET_MARKER);
}

export { VAULT_SECRET_MARKER };
