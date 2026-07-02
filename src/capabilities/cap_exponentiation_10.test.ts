import { describe, expect, it } from 'vitest';
import behExponentiationHandler10 from './cap_exponentiation_10.js';

// ---------------------------------------------------------------------------
// Happy-path tests
// ---------------------------------------------------------------------------

describe('beh_exponentiation_handler_10 – happy path', () => {
  it('handles caret notation (a^b)', () => {
    const result = behExponentiationHandler10.handler('5^3');
    expect(result.handled).toBe(true);
    expect(result.message).toContain('5^3 = 5 × 5 × 5 = 125');
  });

  it('handles ** notation (a**b)', () => {
    const result = behExponentiationHandler10.handler('2 ** 4');
    expect(result.handled).toBe(true);
    expect(result.message).toContain('16');
  });

  it('handles "to the power of" phrasing', () => {
    const result = behExponentiationHandler10.handler('5 to the power of 3');
    expect(result.handled).toBe(true);
    expect(result.message).toContain('125');
  });

  it('handles "raised to the" phrasing with ordinal', () => {
    const result = behExponentiationHandler10.handler('5 raised to the 3rd power');
    expect(result.handled).toBe(true);
    expect(result.message).toContain('125');
  });

  it('handles "raised to the" phrasing without "power" suffix', () => {
    const result = behExponentiationHandler10.handler('2 raised to the 3rd');
    expect(result.handled).toBe(true);
    expect(result.message).toContain('8');
  });

  it('handles "power of a and b" phrasing', () => {
    const result = behExponentiationHandler10.handler('power of 5 and 3');
    expect(result.handled).toBe(true);
    expect(result.message).toContain('125');
  });

  it('handles "exponent of a to b" phrasing', () => {
    const result = behExponentiationHandler10.handler('exponent of 5 to 3');
    expect(result.handled).toBe(true);
    expect(result.message).toContain('125');
  });

  it('handles "a to the b" phrasing', () => {
    const result = behExponentiationHandler10.handler('5 to the 3rd');
    expect(result.handled).toBe(true);
    expect(result.message).toContain('125');
  });

  it('handles exponent 0 (returns 1 for non‑zero base)', () => {
    const result = behExponentiationHandler10.handler('7^0');
    expect(result.handled).toBe(true);
    expect(result.message).toContain('1');
  });

  it('handles base 0 with positive exponent', () => {
    const result = behExponentiationHandler10.handler('0^5');
    expect(result.handled).toBe(true);
    expect(result.message).toContain('0');
  });

  it('handles base 1', () => {
    const result = behExponentiationHandler10.handler('1^100');
    expect(result.handled).toBe(true);
    expect(result.message).toContain('1');
  });

  it('handles base -1 with even exponent', () => {
    const result = behExponentiationHandler10.handler('-1^2');
    expect(result.handled).toBe(true);
    expect(result.message).toContain('1');
  });

  it('handles base -1 with odd exponent', () => {
    const result = behExponentiationHandler10.handler('-1^3');
    expect(result.handled).toBe(true);
    expect(result.message).toContain('-1');
  });

  it('handles a negative base with an even exponent', () => {
    const result = behExponentiationHandler10.handler('-2^2');
    expect(result.handled).toBe(true);
    expect(result.message).toContain('4');
  });

  it('handles a negative base with an odd exponent', () => {
    const result = behExponentiationHandler10.handler('-2^3');
    expect(result.handled).toBe(true);
    expect(result.message).toContain('-8');
  });

  it('normalises -0 base to 0 for multiplication safety', () => {
    // JavaScript -0 can appear through user input edge cases.
    const result = behExponentiationHandler10.handler('-0^3');
    expect(result.handled).toBe(true);
    expect(result.message).toContain('0');
  });
});

// ---------------------------------------------------------------------------
// Rejection / edge-case tests
// ---------------------------------------------------------------------------

describe('beh_exponentiation_handler_10 – rejections', () => {
  it('rejects negative exponent', () => {
    const result = behExponentiationHandler10.handler('2^-3');
    expect(result.handled).toBe(false);
    expect(result.message).toContain('non‑negative exponents');
  });

  it('rejects 0^0', () => {
    const result = behExponentiationHandler10.handler('0^0');
    expect(result.handled).toBe(false);
    expect(result.message).toContain('undefined');
  });

  it('rejects overflow (too large)', () => {
    // 2^54 > Number.MAX_SAFE_INTEGER
    const result = behExponentiationHandler10.handler('2^54');
    expect(result.handled).toBe(false);
    expect(result.message).toContain('too large');
  });

  it('rejects non‑safe‑integer base', () => {
    const result = behExponentiationHandler10.handler('9007199254740992^1'); // MAX_SAFE_INTEGER + 1
    expect(result.handled).toBe(false);
    expect(result.message).toContain('safe integers');
  });

  it('rejects non‑safe‑integer exponent', () => {
    const result = behExponentiationHandler10.handler('2^9007199254740992');
    expect(result.handled).toBe(false);
    expect(result.message).toContain('safe integers');
  });

  it('rejects non‑integer base (float)', () => {
    const result = behExponentiationHandler10.handler('2.5^3');
    expect(result.handled).toBe(false);
    // The pattern doesn't match floats, so the message talks about not understanding.
    expect(result.message).toContain('did not understand');
  });

  it('rejects non‑integer exponent (float)', () => {
    const result = behExponentiationHandler10.handler('2^3.5');
    expect(result.handled).toBe(false);
    expect(result.message).toContain('did not understand');
  });

  it('rejects completely malformed input', () => {
    const result = behExponentiationHandler10.handler('what is the meaning of life?');
    expect(result.handled).toBe(false);
    expect(result.message).toContain('did not understand');
  });

  it('rejects extra operands (chained operations)', () => {
    // The patterns only capture exactly two integers.
    const result = behExponentiationHandler10.handler('2^3+1');
    expect(result.handled).toBe(false);
  });

  it('rejects negative-base overflow check', () => {
    // (-2)^54 would overflow the safe integer range (|result| > 2^53-1)
    const result = beh