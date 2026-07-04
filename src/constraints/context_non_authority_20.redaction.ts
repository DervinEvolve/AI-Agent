// Redaction / secret-hygiene gate for con_context_non_authority_20.
//
// Every exported bundle must pass the shared secret_redactor. A bundle that
// contains actual vault-held secret bytes triggers policy_blocked and hard
// (idempotent, atomic) session termination.

import * as redactorModule from '../capabilities/secret_redactor';
import type { Decision } from './context_non_authority_20';

/** Resolve the redaction function from the shared secret_redactor module regardless of its export name. */
function resolveRedactor(): (input: string) => string {
  const mod = redactorModule as Record<string, unknown>;
  const candidate =
    mod.redactSecrets ??
    mod.redact ??
    mod.default ??
    mod.applyRedaction ??
    mod.scrub;
  if (typeof candidate === 'function') {
    return candidate as (input: string) => string;
  }
  // Fail closed: if we cannot find a redactor, do not silently pass content.
  throw new Error('secret_redactor: no usable redaction function found');
}

export interface RedactionResult {
  decision: Decision;
  redacted: string;
  terminated: boolean;
}

/**
 * Run the shared redactor over bundle content. If, after redaction, any provided
 * live secret bytes still appear verbatim, the bundle is policy_blocked and the
 * session is hard-terminated.
 *
 * @param content raw bundle content to export
 * @param liveSecretBytes exact secret strings the vault currently holds
 * @param terminate idempotent/atomic session-kill hook (called at most once)
 */
export function redactBundle(
  content: string,
  liveSecretBytes: readonly string[] = [],
  terminate?: () => void,
): RedactionResult {
  const redactor = resolveRedactor();
  const redacted = redactor(content);

  const leaked = liveSecretBytes.filter((s) => s.length > 0 && redacted.includes(s));
  if (leaked.length > 0) {
    let terminated = false;
    if (terminate) {
      // idempotent by construction: called exactly once per detected leak.
      terminate();
      terminated = true;
    }
    return {
      decision: {
        allowed: false,
        code: 'policy_blocked',
        reason: `bundle contained ${leaked.length} live secret byte-sequence(s); hard session termination`,
      },
      redacted,
      terminated,
    };
  }

  return {
    decision: { allowed: true, code: 'ok', reason: 'redacted' },
    redacted,
    terminated: false,
  };
}
