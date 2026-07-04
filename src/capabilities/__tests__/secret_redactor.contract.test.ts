import { describe, it, expect } from 'vitest';
import * as redactor from '../secret_redactor';
import {
  redactString,
  redactOutboundString,
  containsSecret,
  redactObject,
  MAX_SCAN_LENGTH,
  BUILTIN_PATTERN_IDS,
} from '../secret_redactor';

// ---- CONTRACT: named exports exist and are functions, asserted FIRST so a
// wiring regression (the epoch-12 'X is not a function' class) fails fast ----
describe('secret_redactor public API contract', () => {
  it('exports redactString as a function', () => {
    expect(typeof redactor.redactString).toBe('function');
  });
  it('exports redactOutboundString as a function', () => {
    expect(typeof redactor.redactOutboundString).toBe('function');
  });
  it('exports containsSecret as a function', () => {
    expect(typeof redactor.containsSecret).toBe('function');
  });
  it('exports redactObject as a function', () => {
    expect(typeof redactor.redactObject).toBe('function');
  });
});

describe('secret_redactor behavior', () => {
  it('redactOutboundString replaces a raw OAuth bearer token and returns a string', () => {
    const raw = 'Authorization: Bearer ya29.A0ARrdaM9fakeTOKENvalue1234567890abcXYZ';
    const out = redactOutboundString(raw);
    expect(typeof out).toBe('string');
    expect(out).toContain('[REDACTED:oauth_bearer]');
    expect(out).not.toContain('ya29.A0ARrdaM9fakeTOKENvalue1234567890abcXYZ');
  });

  it('redactOutboundString replaces a raw PEM private key block', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEfakeKEYbytesline1\nline2\n-----END RSA PRIVATE KEY-----';
    const out = redactOutboundString(pem);
    expect(out).toContain('[REDACTED:pem_private_key]');
    expect(out).not.toContain('MIIEfakeKEYbytesline1');
  });

  it('containsSecret returns true for a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
    expect(containsSecret(jwt)).toBe(true);
  });

  it('containsSecret returns false for ordinary prose', () => {
    expect(
      containsSecret('The quick brown fox jumps over the lazy dog every morning.'),
    ).toBe(false);
  });

  it('redactObject deep-redacts secrets nested in arrays and object values', () => {
    const obj = {
      note: 'harmless',
      creds: {
        aws: 'AKIAIOSFODNN7EXAMPLE',
        list: ['plain text', 'AIzaSyА-notreal', 'ghp_0123456789abcdefghijABCDEF'],
      },
    };
    const out = redactObject(obj) as typeof obj;
    expect(out.note).toBe('harmless');
    expect(out.creds.aws).toContain('[REDACTED:aws_access_key]');
    expect(out.creds.list[0]).toBe('plain text');
    expect(out.creds.list[2]).toContain('[REDACTED:github_token]');
    // original object is not mutated
    expect(obj.creds.aws).toBe('AKIAIOSFODNN7EXAMPLE');
  });

  it('is linear-time (RE2-class): a 100k-char adversarial input returns within budget', () => {
    // adversarial: repeated near-matches that would blow up a backtracking regex
    const adversarial = 'ey' + 'a'.repeat(100_000);
    const start = Date.now();
    const out = redactString(adversarial);
    const elapsed = Date.now() - start;
    expect(typeof out.redacted).toBe('string');
    // generous ceiling for shared CI runners; a true ReDoS would take many seconds
    expect(elapsed).toBeLessThan(1000);
  });

  it('length-caps input before scan; oversized input is handled without stall', () => {
    const oversized = 'x'.repeat(MAX_SCAN_LENGTH + 5000);
    const start = Date.now();
    const out = redactString(oversized);
    const elapsed = Date.now() - start;
    // output preserves total length (scanned + preserved tail)
    expect(out.redacted.length).toBe(oversized.length);
    expect(elapsed).toBeLessThan(1000);
  });

  it('exposes a frozen list of builtin pattern ids', () => {
    expect(Array.isArray(BUILTIN_PATTERN_IDS)).toBe(true);
    expect(BUILTIN_PATTERN_IDS).toContain('jwt');
    expect(BUILTIN_PATTERN_IDS).toContain('pem_private_key');
    expect(Object.isFrozen(BUILTIN_PATTERN_IDS)).toBe(true);
  });

  it('redaction is never fatal on non-string input', () => {
    // @ts-expect-error deliberately passing wrong type
    expect(redactString(null)).toEqual({ redacted: '', hits: [] });
    // @ts-expect-error deliberately passing wrong type
    expect(containsSecret(42)).toBe(false);
  });
});
