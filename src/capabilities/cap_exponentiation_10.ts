import type { Capability, CapabilityResult } from '../capability-types.js';

// ---------------------------------------------------------------------------
// Safe multiplication helper
// ---------------------------------------------------------------------------

/**
 * Multiplies two safe integers and returns the product if it fits within
 * the safe integer range (±(2^53 - 1)).  Returns null if overflow would
 * occur or if either operand is not a safe integer.
 */
function safeMultiply(a: number, b: number): number | null {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return null;

  // Normalise -0 to 0 so that -0 does not slip through sign-sensitive checks.
  if (Object.is(a, -0)) a = 0;
  if (Object.is(b, -0)) b = 0;

  // The product is safely computable if |a| ≤ MAX_SAFE_INTEGER / |b|
  // (with b = 0 handled separately).
  if (a === 0 || b === 0) return 0;

  if (Math.abs(a) > Number.MAX_SAFE_INTEGER / Math.abs(b)) return null;

  const result = a * b;
  // Post-check: multiplication of two safe integers can still produce
  // a value outside the safe range because of rounding in the division
  // guard above (the guard is exact for integers, but we keep this for
  // defence in depth).
  if (!Number.isSafeInteger(result)) return null;
  return result;
}

// ---------------------------------------------------------------------------
// Exponentiation
// ---------------------------------------------------------------------------

/**
 * Computes `base ** exponent` for safe-integer `base` and non‑negative
 * safe-integer `exponent`.  Returns `null` when the result would overflow
 * the safe-integer range or when the inputs are invalid.
 */
function safeIntegerPower(base: number, exponent: number): number | null {
  // --- Input validation ---
  if (!Number.isSafeInteger(base) || !Number.isSafeInteger(exponent)) {
    return null;
  }
  if (exponent < 0) return null; // negative exponent disallowed

  // --- Special cases ---
  // 0^0 is explicitly rejected by the caller; if we receive it here we
  // treat it as invalid.
  if (base === 0 && exponent === 0) return null;

  if (base === 0) return 0; // 0^positive = 0
  if (base === 1) return 1; // 1^any = 1
  if (base === -1) return exponent % 2 === 0 ? 1 : -1;

  // --- Iterative multiplication with overflow guard ---
  let result = 1;
  for (let i = 0; i < exponent; i++) {
    const next = safeMultiply(result, base);
    if (next === null) return null; // overflow
    result = next;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Intent matching
// ---------------------------------------------------------------------------

const EXPONENTIATION_PATTERNS: RegExp[] = [
  // a ^ b
  /^\s*(-?\d+)\s*\^\s*(-?\d+)\s*$/,
  // a ** b
  /^\s*(-?\d+)\s*\*\*\s*(-?\d+)\s*$/,
  // a to the power of b  (also catches "a to the bth power" etc.)
  /^\s*(-?\d+)\s+to\s+the\s+(?:power\s+of\s+)?(-?\d+)(?:st|nd|rd|th)?\s*(?:power)?\s*$/i,
  // a raised to the bth power
  /^\s*(-?\d+)\s+raised\s+to\s+the\s+(-?\d+)(?:st|nd|rd|th)?\s*(?:power)?\s*$/i,
  // power of a and b
  /^\s*power\s+of\s+(-?\d+)\s+and\s+(-?\d+)\s*$/i,
  // exponent of a to b
  /^\s*exponent\s+of\s+(-?\d+)\s+to\s+(-?\d+)\s*$/i,
  // a to the b  (e.g. "5 to the 3")
  /^\s*(-?\d+)\s+to\s+the\s+(-?\d+)(?:st|nd|rd|th)?\s*$/i,
];

/**
 * Tries to extract `[base, exponent]` from a user input string using the
 * patterns above.  Returns `null` when no pattern matches.
 */
function parseExponentiationInput(
  input: string,
): [base: number, exponent: number] | null {
  const trimmed = input.trim();
  for (const pattern of EXPONENTIATION_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      const base = Number(match[1]);
      const exponent = Number(match[2]);
      if (Number.isNaN(base) || Number.isNaN(exponent)) continue; // shouldn't happen with \d+, but be safe
      return [base, exponent];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Capability implementation
// ---------------------------------------------------------------------------

const behExponentiationHandler10: Capability = {
  id: 'beh_exponentiation_handler_10',
  handler(input: string): CapabilityResult {
    // 1. Try to parse the input as an exponentiation request.
    const parsed = parseExponentiationInput(input);
    if (!parsed) {
      return {
        handled: false,
        message:
          'I did not understand that as an exponentiation request. ' +
          'Try a form like "5^3" or "5 to the power of 3".',
      };
    }

    const [base, exponent] = parsed;

    // 2. Validate operands are finite safe integers.
    if (!Number.isSafeInteger(base) || !Number.isSafeInteger(exponent)) {
      return {
        handled: false,
        message:
          'Both the base and the exponent must be safe integers ' +
          `(between ${Number.MIN_SAFE_INTEGER} and ${Number.MAX_SAFE_INTEGER}).`,
      };
    }

    // 3. Reject negative exponents with an educational note.
    if (exponent < 0) {
      return {
        handled: false,
        message:
          'This agent supports only integer exponentiation with non‑negative exponents. ' +
          'Negative exponents would produce fractions, which are outside the integer domain I work with.',
      };
    }

    // 4. Reject 0^0 explicitly.
    if (base === 0 && exponent === 0) {
      return {
        handled: false,
        message:
          '0^0 is mathematically undefined (it is an indeterminate form). ' +
          'I cannot compute it.',
      };
    }

    // 5. Compute the power.
    const result = safeIntegerPower(base, exponent);
    if (result === null) {
      return {
        handled: false,
        message:
          `The result of ${base}^${exponent} is too large to represent exactly ` +
          `(beyond the safe integer range ±(${Number.MAX_SAFE_INTEGER})). ` +
          'Try a smaller exponent.',
      };
    }

    // 6. Build the educational expansion string.
    const baseStr = base < 0 ? `(${base})` : `${base}`;
    const factors = Array.from<number>({ length: exponent }).fill(base);
    const expansion =
      exponent === 0
        ? `${baseStr}^0 = 1`
        : `${baseStr}^${exponent} = ${factors.map((f) => (f < 0 ? `(${f})` : `${f}`)).join(' × ')} = ${result}`;

    return {
      handled: true,
      message: expansion,
    };
  },
};

export default behExponentiationHandler10;
