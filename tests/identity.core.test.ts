import {
  IDENTITY_TRIGGER,
  selfDescription,
  isIdentityQuery,
  respondTo,
} from "../src/identity";

/**
 * Focused core-behavior tests for the identity module.
 * These tests validate the spec: when the trigger phrase is asked,
 * the response must include the words 'purpose' and 'domain'.
 */
describe("identity core behavior", () => {
  it("exposes the canonical trigger phrase", () => {
    expect(IDENTITY_TRIGGER).toBe("What is your purpose and domain?");
  });

  it("selfDescription contains 'purpose' and 'domain'", () => {
    const desc = selfDescription().toLowerCase();
    expect(desc).toContain("purpose");
    expect(desc).toContain("domain");
  });

  it("isIdentityQuery returns true for the trigger", () => {
    expect(isIdentityQuery(IDENTITY_TRIGGER)).toBe(true);
  });

  it("respondTo(trigger) returns text with 'purpose' and 'domain'", () => {
    const response = respondTo(IDENTITY_TRIGGER).toLowerCase();
    expect(response).toContain("purpose");
    expect(response).toContain("domain");
  });

  it("respondTo returns a fallback for non-identity queries", () => {
    const response = respondTo("Tell me a joke.");
    expect(response.toLowerCase()).not.toContain("purpose");
  });
});
