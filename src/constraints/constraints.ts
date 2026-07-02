import { strict as assert } from 'node:assert';

/**
 * Structured error model aligned with agent-capability-standard v1.0.0.
 * V1xx = validation errors, S3xx = schema errors.
 */
export type CapabilityErrorCode =
  | 'V101' // invalid input type
  | 'V102' // non-finite numeric value
  | 'V103' // non-integer numeric value
  | 'V104' // empty / missing operand
  | 'V105' // unsupported operator
  | 'S301' // missing required field
  | 'S302' // schema shape mismatch
  | 'S303' // output schema violation
  | 'S304'; // internal invariant violation

export interface CapabilityError {
  code: CapabilityErrorCode;
  name: string;
  message: string;
  location: string;
  suggestion: string;
}

export const ERROR_NAMES: Record<CapabilityErrorCode, string> = {
  V101: 'InvalidInputType',
  V102: 'NonFiniteValue',
  V103: 'NonIntegerValue',
  V104: 'MissingOperand',
  V105: 'UnsupportedOperator',
  S301: 'MissingRequiredField',
  S302: 'SchemaShapeMismatch',
  S303: 'OutputSchemaViolation',
  S304: 'InternalInvariantViolation',
};

export function makeError(
  code: CapabilityErrorCode,
  message: string,
  location: string,
  suggestion: string,
): CapabilityError {
  return { code, name: ERROR_NAMES[code], message, location, suggestion };
}

/**
 * Type guard that rejects booleans BEFORE any numeric coercion, then
 * requires a finite integer. Returns a CapabilityError on failure.
 */
export function validateInteger(
  value: unknown,
  location: string,
): CapabilityError | null {
  // Booleans must be rejected first: typeof true === 'boolean' but
  // Number(true) === 1 would silently coerce.
  if (typeof value === 'boolean') {
    return makeError(
      'V101',
      `Expected an integer but received a boolean (${value}) at ${location}.`,
      location,
      'Provide a real integer value, not a boolean.',
    );
  }
  if (typeof value !== 'number') {
    return makeError(
      'V101',
      `Expected an integer but received ${typeof value} at ${location}.`,
      location,
      'Provide a numeric integer value.',
    );
  }
  if (!Number.isFinite(value)) {
    return makeError(
      'V102',
      `Value at ${location} is not finite (NaN or Infinity).`,
      location,
      'Provide a finite integer value.',
    );
  }
  if (!Number.isInteger(value)) {
    return makeError(
      'V103',
      `Value at ${location} is not an integer (${value}).`,
      location,
      'Provide an integer value (no fractional part).',
    );
  }
  return null;
}

export interface ComputeResult {
  ok: boolean;
  value?: number;
  errors?: CapabilityError[];
}

/**
 * Shared safe-compute entry point used by capability handlers.
 * Validates an operator string and an array of operands, then dispatches
 * to the provided arithmetic function.
 */
export function safeCompute(
  operator: unknown,
  operands: unknown[],
  allowed: string[],
  fn: (ops: number[]) => number,
): ComputeResult {
  const errors: CapabilityError[] = [];

  if (typeof operator !== 'string' || operator.length === 0) {
    errors.push(
      makeError(
        'V105',
        'Operator is missing or not a non-empty string.',
        'operator',
        `Provide one of: ${allowed.join(', ')}.`,
      ),
    );
    return { ok: false, errors };
  }

  if (!allowed.includes(operator)) {
    errors.push(
      makeError(
        'V105',
        `Operator '${operator}' is not supported.`,
        'operator',
        `Use one of: ${allowed.join(', ')}.`,
      ),
    );
    return { ok: false, errors };
  }

  if (!Array.isArray(operands) || operands.length === 0) {
    errors.push(
      makeError(
        'V104',
        'Operands array is empty or missing.',
        'operands',
        'Provide at least one integer operand.',
      ),
    );
    return { ok: false, errors };
  }

  const clean: number[] = [];
  for (let i = 0; i < operands.length; i++) {
    const loc = `operands[${i}]`;
    const err = validateInteger(operands[i], loc);
    if (err) {
      errors.push(err);
    } else {
      clean.push(operands[i] as number);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const value = fn(clean);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    errors.push(
      makeError(
        'S303',
        `Computed result ${value} violates the integer output schema.`,
        'result',
        'Ensure inputs are within safe integer range.',
      ),
    );
    return { ok: false, errors };
  }

  return { ok: true, value };
}

/**
 * Error class used by division-era capabilities for invalid numeric input.
 * (Restored alongside the original API after an epoch-7 rewrite removed
 * safeCompute/makeError while production capabilities still imported them.)
 */
export class SafeIntegerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeIntegerError';
  }
}
