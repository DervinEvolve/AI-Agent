import { describeCapability } from "../identity/identity";

/**
 * Capability: basic multiplication of exactly two finite integers.
 *
 * This module implements the multiplication operation for the agent's
 * currently supported basic arithmetic capabilities. It accepts exactly two
 * finite integers and returns their product together with a short
 * educational explanation of the operation.
 */

export interface MultiplicationResult {
  /** The product of the two inputs. */
  result: number;
  /** A human-readable explanation of the computation. */
  explanation: string;
}

/**
 * Multiply exactly two finite integers.
 *
 * @param a - The first finite integer operand.
 * @param b - The second finite integer operand.
 * @returns An object containing the numeric product and an explanation.
 * @throws {Error} If either argument is not a finite integer.
 */
export function multiply(a: number, b: number): MultiplicationResult {
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    throw new Error(
      "multiplication requires exactly two finite integer operands",
    );
  }
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error(
      "multiplication requires exactly two finite integer operands",
    );
  }

  const product = a * b;
  const explanation =
    `Multiplying ${a} by ${b} means adding ${a} to itself ${b} time(s). ` +
    `The product is ${product}.`;

  return { result: product, explanation };
}

/**
 * Self-description fragment for the multiplication capability.
 *
 * The purpose of this capability is to compute the product of two integers.
 * The domain is basic two-integer arithmetic education.
 */
export const capabilityDescription =
  "Capability: basic multiplication. Purpose: compute the product of exactly " +
  "two finite integers. Domain: basic two-integer arithmetic education.";

describeCapability(capabilityDescription);
