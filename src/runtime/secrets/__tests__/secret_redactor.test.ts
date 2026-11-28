import { describe, expect, it } from 'vitest';
import {
  RedactionReason,
  redactBytes,
  SecretCaps,
  SecretRedactor,
} from '../types';

const enc = (value: string): Uint8Array => new TextEncoder().encode(value);
const dec = (value: Uint8Array): string => new TextDecoder().decode(value);

describe('SecretRedactor / redactBytes', () => {
  it('replaces the leftmost-longest secret and preserves surrounding bytes', () => {
    const result = redactBytes(enc('xxabcdefxxabc'), [enc('abc'), enc('abcdef')]);
    expect(dec(result.output)).toBe('xx[REDACTED]xx[REDACTED]');
    expect(result.replaced).toBe(2);
    expect(result.reason).toBe(RedactionReason.REDACTED);
    expect(result.truncated).toBe(false);
  });

  it('does not split an overlapping longer secret into shorter pieces', () => {
    const result = redactBytes(enc('abcdef'), [enc('abc'), enc('abcdef')]);
    expect(dec(result.output)).toBe('[REDACTED]');
    expect(result.replaced).toBe(1);
  });

  it('handles a secret at the end of the input', () => {
    const result = redactBytes(enc('hello secret'), [enc('secret')]);
    expect(dec(result.output)).toBe('hello [REDACTED]');
    expect(result.replaced).toBe(1);
  });

  it('preserves malformed UTF-8 bytes while redacting exact secret bytes', () => {
    const input = new Uint8Array([0xff, 0xfe, ...enc('secret'), 0x80]);
    const result = redactBytes(input, [enc('secret')]);
    expect(result.output[0]).toBe(0xff);
    expect(result.output[1]).toBe(0xfe);
    expect(dec(result.output.slice(2, 12))).toBe('[REDACTED]');
    expect(result.output[result.output.length - 1]).toBe(0x80);
  });

  it('withholds output and returns redaction_error when the size bound is exceeded', () => {
    const result = redactBytes(enc('a'.repeat(100)), [enc('a')], { maxOutputBytes: 10 });
    expect(result.reason).toBe(RedactionReason.REDACTION_ERROR);
    expect(result.output.length).toBe(0);
    expect(result.replaced).toBe(0);
    expect(result.error).toBeDefined();
  });

  it('returns redaction_error for invalid secret input instead of throwing', () => {
    const result = redactBytes(enc('x'), [123 as unknown as Uint8Array]);
    expect(result.reason).toBe(RedactionReason.REDACTION_ERROR);
    expect(result.output.length).toBe(0);
    expect(result.error).toBeDefined();
  });

  it('returns NONE and a copy when no secrets are registered', () => {
    const input = enc('plain text');
    const result = redactBytes(input, []);
    expect(result.output).toEqual(input);
    expect(result.replaced).toBe(0);
    expect(result.reason).toBe(RedactionReason.NONE);
  });

  it('accepts string input and a custom sentinel', () => {
    const result = redactBytes('abc secret', ['secret'], { sentinel: '***' });
    expect(dec(result.output)).toBe('abc ***');
    expect(result.reason).toBe(RedactionReason.REDACTED);
  });

  it('exposes the documented caps', () => {
    expect(SecretCaps.MIN_SECRET_BYTES).toBe(16);
    expect(SecretCaps.MAX_SECRET_BYTES).toBe(4096);
    expect(SecretCaps.DEFAULT_MAX_BINDINGS).toBe(16);
    expect(SecretCaps.HARD_MAX_BINDINGS).toBe(64);
    expect(SecretCaps.DEFAULT_SENTINEL).toBe('[REDACTED]');
  });

  it('can be used as a class instance', () => {
    const redactor = new SecretRedactor([enc('secret')]);
    const result = redactor.redact(enc('a secret here'));
    expect(dec(result.output)).toBe('a [REDACTED] here');
  });
});
