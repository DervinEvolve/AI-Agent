import {
  IDENTITY_TRIGGER,
  selfDescription,
  isIdentityQuery,
  respondTo,
} from "../src/identity";

describe("Agent self-description behavior", () => {
  describe("selfDescription", () => {
    it("includes the word 'purpose'", () => {
      expect(selfDescription().toLowerCase()).toContain("purpose");
    });

    it("includes the word 'domain'", () => {
      expect(selfDescription().toLowerCase()).toContain("domain");
    });

    it("returns a non-empty string", () => {
      const desc = selfDescription();
      expect(typeof desc).toBe("string");
      expect(desc.trim().length).toBeGreaterThan(0);
    });
  });

  describe("isIdentityQuery", () => {
    it("recognizes the exact trigger phrase", () => {
      expect(isIdentityQuery(IDENTITY_TRIGGER)).toBe(true);
    });

    it("is case-insensitive", () => {
      expect(isIdentityQuery("what is YOUR Purpose and DOMAIN?")).toBe(true);
    });

    it("trims surrounding whitespace", () => {
      expect(isIdentityQuery("  What is your purpose and domain?  ")).toBe(true);
    });

    it("rejects empty or non-string input", () => {
      expect(isIdentityQuery("")).toBe(false);
      expect(isIdentityQuery("   ")).toBe(false);
    });

    it("rejects unrelated queries", () => {
      expect(isIdentityQuery("What is the weather today?")).toBe(false);
    });
  });

  describe("respondTo", () => {
    it("returns a self-description containing 'purpose' and 'domain' for the identity trigger", () => {
      const response = respondTo(IDENTITY_TRIGGER);
      expect(response.toLowerCase()).toContain("purpose");
      expect(response.toLowerCase()).toContain("domain");
    });

    it("returns a self-description for a case-variant of the trigger", () => {
      const response = respondTo("what is your purpose and domain?");
      expect(response.toLowerCase()).toContain("purpose");
      expect(response.toLowerCase()).toContain("domain");
    });

    it("does not treat unrelated queries as identity questions", () => {
      const response = respondTo("Tell me a joke.");
      expect(response.toLowerCase()).not.toContain("domain");
    });
  });
});
