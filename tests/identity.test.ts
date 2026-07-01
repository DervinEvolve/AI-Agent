import { describe, it, expect } from "vitest";
import {
  SELF_DESCRIPTION,
  IDENTITY,
  isPurposeAndDomainQuery,
} from "../src/identity";

describe("identity self-description", () => {
  it("SELF_DESCRIPTION contains the word 'purpose'", () => {
    expect(SELF_DESCRIPTION.toLowerCase()).toContain("purpose");
  });

  it("SELF_DESCRIPTION contains the word 'domain'", () => {
    expect(SELF_DESCRIPTION.toLowerCase()).toContain("domain");
  });

  it("IDENTITY.selfDescription matches SELF_DESCRIPTION", () => {
    expect(IDENTITY.selfDescription).toBe(SELF_DESCRIPTION);
  });

  it("IDENTITY has non-empty name, purpose, and domain", () => {
    expect(IDENTITY.name.length).toBeGreaterThan(0);
    expect(IDENTITY.purpose.length).toBeGreaterThan(0);
    expect(IDENTITY.domain.length).toBeGreaterThan(0);
  });
});

describe("isPurposeAndDomainQuery", () => {
  it("returns true for 'What is your purpose and domain?'", () => {
    expect(isPurposeAndDomainQuery("What is your purpose and domain?")).toBe(true);
  });

  it("returns true for 'Tell me about your purpose and domain.'", () => {
    expect(isPurposeAndDomainQuery("Tell me about your purpose and domain.")).toBe(true);
  });

  it("returns true for case-insensitive variations", () => {
    expect(isPurposeAndDomainQuery("what is your PURPOSE and DOMAIN?")).toBe(true);
  });

  it("returns false for unrelated queries", () => {
    expect(isPurposeAndDomainQuery("What is the weather today?")).toBe(false);
    expect(isPurposeAndDomainQuery("Hello")).toBe(false);
    expect(isPurposeAndDomainQuery("")).toBe(false);
    expect(isPurposeAndDomainQuery(undefined)).toBe(false);
  });
});
