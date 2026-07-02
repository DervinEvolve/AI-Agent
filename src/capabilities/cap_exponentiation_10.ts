import { constraints } from '../constraints/constraints.js';

/**
 * Capability: Bounded Integer Exponentiation (a^b)
 *
 * Computes a^b for two finite integers a (base) and b (exponent),
 * both within the safe integer range ±(2^53 - 1).
 *
 * Constraints:
 *  - b must be a non-negative integer.
 *  - 0^0 is rejected as undefined.
 *  - Negative exponents are rejected (out of scope).
 *  - Multiplication is performed iteratively with pre-multiplication
 *    overflow checks at each step to keep intermediate and final
 *    results within Number.MAX_SAFE_INTEGER.
 *  - All outputs normalize -0 to 0.
 *
 * Special cases:
 *  - 0^positive = 0
 *  - 1^b = 1
 *  - (-1)^b = 1 (b even), -1 (b odd)
 *  - Negative base to even exponent → positive; to odd exponent → negative
 */

export interface ExponentiationResult {
  result: number;
  explanation: string;
}

export interface ExponentiationError {
  error: string;
  explanation: string;
}

export type ExponentiationOutput = ExponentiationResult | ExponentiationError;

/**
 * Perform bounded integer exponentiation a^b.
 */
export function computeExponentiation(a: number, b: number): ExponentiationOutput {
  // --- Input validation ---
  const validationError = validateInputs(a, b);
  if (validationError) return validationError;

  // --- Special cases ---
  const special = handleSpecialCases(a, b);
  if (special !== undefined) return special;

  // --- General iterative exponentiation ---
  return iterativeExponentiation(a, b);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateInputs(a: number, b: number): ExponentiationError | null {
  // Check that inputs are finite integers within safe range
  const intCheckA = constraints.isValidInteger(a);
  if (!intCheckA.valid) {
    return {
      error: 'INVALID_BASE',
      explanation: `Base ${a} is not a valid integer within the safe integer range (±(2^53 - 1)).`,
    };
  }

  const intCheckB = constraints.isValidInteger(b);
  if (!intCheckB.valid) {
    return {
      error: 'INVALID_EXPONENT',
      explanation: `Exponent ${b} is not a valid integer within the safe integer range (±(2^53 - 1)).`,
    };
  }

  // Exponent must be non-negative
  if (b < 0) {
    return {
      error: 'NEGATIVE_EXPONENT',
      explanation: `Exponent ${b} is negative. This educational assistant only supports non-negative integer exponents.`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Special cases
// ---------------------------------------------------------------------------

function handleSpecialCases(a: number, b: number): ExponentiationOutput | undefined {
  // 0^0 is undefined
  if (a === 0 && b === 0) {
    return {
      error: 'ZERO_TO_ZERO',
      explanation:
        '0^0 is mathematically undefined. Different contexts assign it different meanings, so this educational assistant does not compute it.',
    };
  }

  // 0^positive = 0
  if (a === 0 && b > 0) {
    return { result: 0, explanation: `0^${b} = 0 (zero raised to any positive exponent is zero).` };
  }

  // 1^b = 1
  if (a === 1) {
    return { result: 1, explanation: `1^${b} = 1 (one raised to any exponent is one).` };
  }

  // (-1)^b = 1 if b even, -1 if b odd
  if (a === -1) {
    const result = b % 2 === 0 ? 1 : -1;
    const parity = b % 2 === 0 ? 'even' : 'odd';
    return {
      result,
      explanation: `(-1)^${b} = ${result} because the exponent ${b} is ${parity}.`,
    };
  }

  // b = 0 → a^0 = 1 (a ≠ 0 already handled)
  if (b === 0) {
    return { result: 1, explanation: `${a}^0 = 1 (any non-zero number raised to zero is one).` };
  }

  return undefined; // no special case applies
}

// ---------------------------------------------------------------------------
// Iterative exponentiation with overflow guards
// ---------------------------------------------------------------------------

function iterativeExponentiation(a: number, b: number): ExponentiationOutput {
  let result = 1;
  const absBase = Math.abs(a);
  const baseNegative = a < 0;

  for (let step = 0; step < b; step++) {
    // Pre-multiplication overflow check:
    // |result * a| > MAX_SAFE_INTEGER  ↔  |result| > MAX_SAFE_INTEGER / |a|
    // Since we multiply by a each step, check against absBase.
    if (Math.abs(result) > Number.MAX_SAFE_INTEGER / absBase) {
      return {
        error: 'OVERFLOW',
        explanation: `Computing ${a}^${b} would produce a result outside the safe integer range (±(2^53 - 1)). This educational assistant cannot compute it.`,
      };
    }

    result = result * a;
  }

  // Normalize -0 to 0
  if (Object.is(result, -0)) {
    result = 0;
  }

  const signInfo =
    baseNegative && b % 2 === 1
      ? 'negative base raised to an odd exponent yields a negative result.'
      : baseNegative
        ? 'negative base raised to an even exponent yields a positive result.'
        : '';

  return {
    result,
    explanation: `${a}^${b} = ${result}.` + (signInfo ? ` (${signInfo})` : ''),
  };
}
