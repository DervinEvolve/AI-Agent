import { describe, expect, it } from 'vitest';
import { RedactionReason, redactBytes } from '../types';

const enc = (value: string): Uint8Array => new TextEncoder().encode(value);
const dec = (value: Uint8Array): string => new TextDecoder().decode(value);

describe('redactBytes additional edge cases', () => {
  it('uses a custom sentinel when provided', () => {
    const result = redactBytes(enc('abc secret def'), [enc('secret')], { sentinel: '***' });
    expect(dec(result.output)).toBe('abc *** def');
    expect(result.replaced).toBe(1);
    expect(result.reason).toBe(RedactionReason.REDACTED);
    expect(result.truncated).toBe(false);
  });

  it('replaces multiple distinct secrets', () => {
    const result = redactBytes(enc('secret1 and secret2'), [enc('secret1'), enc('secret2')]);
    expect(dec(result.output)).toBe('[REDACTED] and [REDACTED]');
    expect(result.replaced).toBe(2);
    expect(result.reason).toBe(RedactionReason.REDACTED);
  });

  it('handles a secret at the very beginning', () => {
    const result = redactBytes(enc('secret at start'), [enc('secret')]);
    expect(dec(result.output)).toBe('[REDACTED] at start');
    expect(result.replaced).toBe(1);
  });

  it('replaces consecutive occurrences without overlap', () => {
    const result = redactBytes(enc('secretsecret'), [enc('secret')]);
    expect(dec(result.output)).toBe('[REDACTED][REDACTED]');
    expect(result.replaced).toBe(2);
  });

  it('does not overlap a secret with itself', () => {
    const result = redactBytes(enc('aaaaaa'), [enc('aaaa')]);
    expect(dec(result.output)).toBe('[REDACTED]aa');
    expect(result.replaced).toBe(1);
  });

  it('returns NONE for empty input', () => {
    const result = redactBytes(new Uint8Array(0), [enc('secret')]);
    expect(result.output.length).toBe(0);
    expect(result.replaced).toBe(0);
    expect(result.reason).toBe(RedactionReason.NONE);
    expect(result.truncated).toBe(false);
  });

  it('returns NONE when no secrets are registered', () => {
    const input = enc('no secrets here');
    const result = redactBytes(input, []);
    expect(result.output).toEqual(input);
    expect(result.replaced).toBe(0);
    expect(result.reason).toBe(RedactionReason.NONE);
    expect(result.truncated).toBe(false);
  });

  it('allows output exactly at maxOutputBytes without truncation', () => {
    const input = enc('abc secret def');
    // After redaction: 'abc [REDACTED] def' length = 18
    const result = redactBytes(input, [enc('secret')], { maxOutputBytes: 18 });
    expect(dec(result.output)).toBe('abc [REDACTED] def');
    expect(result.truncated).toBe(false);
    expect(result.reason).toBe(RedactionReason.REDACTED);
  });

  it('withholds output when maxOutputBytes is one byte too small', () => {
    const input = enc('abc secret def');
    const result = redactBytes(input, [enc('secret')], { maxOutputBytes: 17 });
    expect(result.reason).toBe(RedactionReason.REDACTION_ERROR);
    expect(result.output.length).toBe(0);
    expect(result.replaced).toBe(0);
    expect(result.error).toBeDefined();
  });

  it('chooses leftmost-longest even when a shorter secret would match earlier', () => {
    const result = redactBytes(enc('ababc'), [enc('ab'), enc('abc')]);
    expect(dec(result.output)).toBe('[REDACTED][REDACTED]');
    expect(result.replaced).toBe(2);
  });
});
