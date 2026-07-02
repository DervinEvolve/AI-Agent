import { describe, expect, it } from "vitest";
import defaultIdentity, { identity as reexportedIdentity } from "../src/identity/identity";

const textFor = (value: unknown) => JSON.stringify(value).toLowerCase();

describe("identity re-export", () => {
  it("exposes the updated scoped GCD/LCM capability identity through the nested identity path", () => {
    expect(defaultIdentity).toBe(reexportedIdentity);

    const identityText = textFor(reexportedIdentity.identity);

    expect(identityText).toContain("exactly two finite integers");
    expect(identityText).toContain("active capabilities");
    expect(identityText).toContain("greatest common divisor");
    expect(identityText).toContain("least common multiple");
  });
});
