import { describe, it, expect } from 'vitest';
import {
  redactString,
  redactOutboundString,
  containsSecret,
  redactObject,
} from '../secret_redactor';

// A raw PEM private key block whose header matches the built-in pattern.
const PEM =
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEfakeKEYbytesline1\nline2\n-----END RSA PRIVATE KEY-----';
// A JWT-shaped token (ey-prefixed, 3 dot-separated base64url segments).
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';

describe('redactObject deep-walks strings in nested structures', () => {
  it('redacts a secret nested inside object values and arrays without dropping structure', () => {
    const input = {
      user: 'alice',
      creds: {
        pem: PEM,
        notes: 'this is ordinary prose with no secret',
      },
      tokens: ['plain-text', JWT],
      count: 3,
    };

    const out: any = redactObject(input);

    // Structure is preserved.
    expect(typeof out).toBe('object');
    expect(out).not.toBeNull();
    expect(Array.isArray(out.tokens)).toBe(true);
    expect(out.tokens).toHaveLength(2);

    // Non-string / non-secret data is untouched.
    expect(out.user).toBe('alice');
    expect(out.count).toBe(3);
    expect(out.tokens[0]).toBe('plain-text');
    expect(out.creds.notes).toBe('this is ordinary prose with no secret');

    // The raw PEM key material must not survive anywhere in the redacted output.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('MIIEfakeKEYbytesline1');
    // The raw JWT signature segment must not survive.
    expect(serialized).not.toContain('dozjgNryP4J3jVmNHl0w5N');
  });

  it('leaves an object with no secrets structurally equivalent', () => {
    const clean = { a: 'hello', b: ['world', 'no secrets here'], c: 42 };
    const out: any = redactObject(clean);
    expect(out.a).toBe('hello');
    expect(out.b[0]).toBe('world');
    expect(out.b[1]).toBe('no secrets here');
    expect(out.c).toBe(42);
  });
});

describe('redactString reports hit spans consistent with the redacted text', () => {
  it('returns a redacted string and at least one hit for a PEM key', () => {
    const result = redactString(PEM);
    expect(typeof result.redacted).toBe('string');
    expect(Array.isArray(result.hits)).toBe(true);
    expect(result.hits.length).toBeGreaterThan(0);

    // Every reported hit has a coherent, non-negative span.
    for (const hit of result.hits) {
      expect(typeof hit.pattern_id).toBe('string');
      expect(hit.pattern_id.length).toBeGreaterThan(0);
      expect(hit.start).toBeGreaterThanOrEqual(0);
      expect(hit.end).toBeGreaterThan(hit.start);
      // Spans index into the original input.
      expect(hit.end).toBeLessThanOrEqual(PEM.length);
    }

    // The raw key material is gone from the redacted output.
    expect(result.redacted).not.toContain('MIIEfakeKEYbytesline1');
  });

  it('containsSecret agrees with redactString finding hits', () => {
    const secretHits = redactString(JWT).hits;
    expect(containsSecret(JWT)).toBe(secretHits.length > 0);

    const proseHits = redactString('just a plain sentence with nothing sensitive').hits;
    expect(containsSecret('just a plain sentence with nothing sensitive')).toBe(
      proseHits.length > 0,
    );
  });
});

describe('redactor is linear-time (ReDoS regression) and length-capped', () => {
  it('scans a 100k-char adversarial input well within a strict time bound', () => {
    // A long, repetitive input designed to trigger catastrophic backtracking
    // in a naive backtracking-regex implementation.
    const adversarial = 'A'.repeat(50_000) + '.'.repeat(50_000);
    const start = Date.now();
    const out = redactOutboundString(adversarial);
    const elapsed = Date.now() - start;
    expect(typeof out).toBe('string');
    // A linear-time engine handles 100k chars far under this bound; a
    // backtracking blowup would exceed it by orders of magnitude.
    expect(elapsed).toBeLessThan(2000);
  });

  it('handles oversized input without stalling and still returns a string', () => {
    const oversized = 'x'.repeat(500_000);
    const start = Date.now();
    const out = redactOutboundString(oversized);
    const elapsed = Date.now() - start;
    expect(typeof out).toBe('string');
    expect(elapsed).toBeLessThan(2000);
  });
});
