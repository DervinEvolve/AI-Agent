import { describe, it, expect } from 'vitest';
import { redactBundle } from './context_non_authority_20.redaction';
import * as redactorModule from '../capabilities/secret_redactor';

describe('con_context_non_authority_20 - redaction contract', () => {
  it('secret_redactor module exposes a usable redaction function', () => {
    const mod = redactorModule as Record<string, unknown>;
    const candidate =
      mod.redactSecrets ?? mod.redact ?? mod.default ?? mod.applyRedaction ?? mod.scrub;
    expect(typeof candidate).toBe('function');
  });

  it('a clean bundle passes redaction', () => {
    const res = redactBundle('nothing secret here');
    expect(res.decision.allowed).toBe(true);
    expect(res.terminated).toBe(false);
  });

  it('a bundle with live secret bytes is policy_blocked and hard-terminates once', () => {
    let kills = 0;
    const terminate = () => {
      kills += 1;
    };
    const secret = 'sk-live-ABCDEF1234567890VAULTBYTES';
    const res = redactBundle(`payload=${secret} end`, [secret], terminate);
    expect(res.decision.allowed).toBe(false);
    expect(res.decision.code).toBe('policy_blocked');
    expect(res.terminated).toBe(true);
    // idempotent/atomic: terminate hook fires exactly once per leak
    expect(kills).toBe(1);
  });

  it('termination is safe with no terminate hook provided', () => {
    const secret = 'vault-token-XYZ-9999';
    const res = redactBundle(secret, [secret]);
    expect(res.decision.code).toBe('policy_blocked');
    expect(res.terminated).toBe(false);
  });
});
