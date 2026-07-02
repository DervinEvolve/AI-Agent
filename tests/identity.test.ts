import { describe, expect, it } from "vitest";
import { identity } from "../src/identity";

describe("identity", () => {
  it("describes the supported two-integer arithmetic and number-relation scope", () => {
    expect(identity.identity).toEqual({
      domain:
        "basic two-integer arithmetic and elementary number-relation education, with supported operations defined by the agent's active capabilities",
      purpose:
        "To help users understand and correctly compute currently supported operations on exactly two finite integers, including addition, subtraction, multiplication, integer division with quotient and remainder, greatest common divisor, and least common multiple.",
    });
  });
});
