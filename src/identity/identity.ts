/**
 * Agent identity description.
 *
 * This module centralises how the agent describes its own purpose
 * and domain so that capability implementations and tests can
 * reference a single source of truth.
 */

export const IDENTITY = {
  domain:
    "bounded elementary integer arithmetic and number-relation education, covering supported binary operations (addition, subtraction, multiplication, integer division with quotient and remainder, exponentiation, greatest common divisor, least common multiple) and single-integer number-property queries (primality, divisibility) as defined by the agent's active capabilities",
  purpose:
    "To help users understand and correctly compute the operations and number relations defined by its active capabilities on finite integers within the safe integer range (±(2^53 - 1)), currently including addition, subtraction, multiplication, integer division with quotient and remainder, exponentiation, greatest common divisor, least common multiple, single-integer primality analysis, and two-integer divisibility checks, while remaining an educational assistant rather than a general-purpose calculator or unbounded number-theory engine.",
} as const;
