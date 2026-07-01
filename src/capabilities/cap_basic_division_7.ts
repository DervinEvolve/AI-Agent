// cap_basic_division_7.ts
// Division capability: handles division queries for two finite safe integers,
// returning Euclidean quotient and remainder with educational explanation.

import type { Capability, CapabilityContext } from '../types.js';

const DIVISION_TRIGGER_PATTERNS = [
  /(?:what is|compute|calculate|evaluate|find|solve)?\s*(?:the\s+)?(?:integer\s+)?division\s+(?:of\s+)?(-?\d+)\s*(?:\/|÷|divided\s+by|over)\s*(-?\d+)/i,
  /(?:what is|compute|calculate|evaluate|find|solve)?\s*(?:the\s+)?quotient\s+(?:of\s+)?(-?\d+)\s+and\s+(-?\d+)/i,
  /divide\s+(-?\d+)\s+by\s+(-?\d+)/i,
  /(-?\d+)\s*(?:\/|÷|divided\s+by|over)\s*(-?\d+)/i,
];

interface DivisionResult {
  quotient: number;
  remainder: number;
}

/**
 * Safely computes Euclidean division for two integers within safe integer range.
 * Returns quotient and non-negative remainder.
 * Throws on division by zero, non-integer inputs, or out-of-range values.
 */
function safe_compute(a: number, b: number): DivisionResult {
  // Validate inputs are finite integers
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error('Both operands must be finite numbers.');
  }
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    throw new Error('Both operands must be integers.');
  }

  // Validate safe integer range
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
    throw new Error(
      `Operands must be between ${Number.MIN_SAFE_INTEGER} and ${Number.MAX_SAFE_INTEGER}.`
    );
  }

  // Division by zero check
  if (b === 0) {
    throw new Error('Division by zero is undefined. The divisor cannot be zero.');
  }

  // Compute Euclidean division
  const rawQuotient = Math.trunc(a / b);
  let remainder = a - rawQuotient * b;

  // Adjust for Euclidean remainder (non-negative)
  if (remainder < 0) {
    remainder += Math.abs(b);
    return {
      quotient: rawQuotient + (b > 0 ? -1 : 1),
      remainder,
    };
  }

  return { quotient: rawQuotient, remainder };
}

/**
 * Generates an educational explanation for the division result.
 */
function explainDivision(
  dividend: number,
  divisor: number,
  result: DivisionResult
): string {
  const { quotient, remainder } = result;

  let explanation = `## Division Result\n\n`;
  explanation += `**${dividend} ÷ ${divisor}**\n\n`;
  explanation += `- **Quotient:** ${quotient}\n`;
  explanation += `- **Remainder:** ${remainder}\n\n`;

  explanation += `### How it works\n\n`;
  explanation += `We are performing **Euclidean division**, which guarantees that the remainder is always non-negative and strictly less than the absolute value of the divisor.\n\n`;

  if (remainder === 0) {
    explanation += `Since ${dividend} is evenly divisible by ${divisor}, the remainder is 0.\n`;
    explanation += `This means ${dividend} = ${divisor} × ${quotient}.\n`;
  } else {
    explanation += `We find the quotient by determining how many whole times ${divisor} fits into ${dividend}.\n`;
    explanation += `The remainder is what's left over after subtracting ${divisor} × ${quotient} from ${dividend}.\n\n`;
    explanation += `**Verification:** ${divisor} × ${quotient} + ${remainder} = ${divisor * quotient + remainder} ✓\n`;
  }

  explanation += `\n**Key property:** 0 ≤ remainder < |divisor| → 0 ≤ ${remainder} < ${Math.abs(divisor)} ✓`;

  return explanation;
}

/**
 * Extracts two integers from a user query using division patterns.
 * Returns [dividend, divisor] or null if no match.
 */
function extractOperands(query: string): [number, number] | null {
  for (const pattern of DIVISION_TRIGGER_PATTERNS) {
    const match = query.match(pattern);
    if (match) {
      const a = parseInt(match[1], 10);
      const b = parseInt(match[2], 10);

      // Ensure both captures are valid integers
      if (!isNaN(a) && !isNaN(b)) {
        return [a, b];
      }
    }
  }
  return null;
}

/**
 * Validates that the query is for exactly two integers (no chaining).
 */
function hasChainedOperations(query: string): boolean {
  // Look for multiple operators or more than two numbers in arithmetic expressions
  const operatorCount = (query.match(/[\/÷]|divided\s+by|over/g) || []).length;
  const numberMatches = query.match(/-?\d+/g) || [];

  // If there are more than 2 numbers or multiple division operators, it's chained
  if (numberMatches.length > 2 || operatorCount > 1) {
    return true;
  }

  // Check for other arithmetic operators that would indicate chaining
  if (/[+\-*×]/.test(query.replace(/\/|÷|divided\s+by|over/g, ''))) {
    return true;
  }

  return false;
}

/**
 * Determines if the query is asking for division (trigger match).
 */
function isDivisionQuery(query: string): boolean {
  return DIVISION_TRIGGER_PATTERNS.some((pattern) => pattern.test(query));
}

export const cap_basic_division_7: Capability = {
  id: 'cap_basic_division_7',
  name: 'Basic Integer Division',
  description:
    'Handles division queries for two finite safe integers, returning Euclidean quotient and remainder with educational explanation.',

  async execute(context: CapabilityContext): Promise<string> {
    const query = context.userMessage.trim();

    // Reject empty queries
    if (!query) {
      return 'Please provide a division query with two integers.';
    }

    // Check if this is a division query
    if (!isDivisionQuery(query)) {
      return 'This does not appear to be a division query. Please provide a division expression like "10 / 3" or "divide 10 by 3".';
    }

    // Reject chained operations or expressions with multiple operators
    if (hasChainedOperations(query)) {
      return 'I can only handle division of exactly two integers. Chained operations or expressions with multiple arithmetic operators are not supported.';
    }

    // Extract operands
    const operands = extractOperands(query);
    if (!operands) {
      return 'Could not extract two integers from your query. Please provide a clear division expression like "10 / 3" or "divide 10 by 3".';
    }

    const [dividend, divisor] = operands;

    // Validate safe integer range
    if (!Number.isSafeInteger(dividend) || !Number.isSafeInteger(divisor)) {
      return `Operands must be safe integers between ${Number.MIN_SAFE_INTEGER} and ${Number.MAX_SAFE_INTEGER}.`;
    }

    try {
      const result = safe_compute(dividend, divisor);
      return explainDivision(dividend, divisor, result);
    } catch (error) {
      if (error instanceof Error) {
        return `**Error:** ${error.message}`;
      }
      return 'An unexpected error occurred while computing the division.';
    }
  },
};

export default cap_basic_division_7;
