// Widened identity for bounded integer number-relation tutoring.
//
// This module records the widening of the agent's identity from strictly
// "exactly two finite integers" to bounded integer number-relation tutoring,
// so that single-integer property queries (divisibility, primality,
// factorization) are in scope. The safe-integer bound and educational
// framing are explicitly retained to prevent scope creep into unbounded
// number theory.
//
// The safe integer range is ±(2^53 - 1); Number.MAX_SAFE_INTEGER is
// 9007199254740991.

export const SAFE_INTEGER_LIMIT = Number.MAX_SAFE_INTEGER; // 9007199254740991

export interface WidenedIdentity {
  readonly domain: string;
  readonly purpose: string;
}

export const widenedIdentity: WidenedIdentity = {
  domain:
    "bounded elementary integer arithmetic and number-relation education, covering supported binary operations and single-integer number-property queries as defined by the agent's active capabilities",
  purpose:
    "To help users understand and correctly compute the operations and number relations defined by its active capabilities on finite integers within the safe integer range (\u00b1(2^53 - 1)), currently including addition, subtraction, multiplication, integer division with quotient and remainder, greatest common divisor, least common multiple, and single-integer divisibility/primality analysis, while remaining an educational assistant rather than a general-purpose calculator or unbounded number-theory engine.",
};

/**
 * Returns true if `n` is a finite integer within the inclusive safe-integer
 * range ±(2^53 - 1). This is the precondition every capability must enforce
 * before computing, and is a prerequisite for a value being in scope of the
 * widened identity.
 */
export function isSafeIntegerInScope(n: unknown): n is number {
  return (
    typeof n === "number" &&
    Number.isSafeInteger(n) &&
    n >= -SAFE_INTEGER_LIMIT &&
    n <= SAFE_INTEGER_LIMIT
  );
}
