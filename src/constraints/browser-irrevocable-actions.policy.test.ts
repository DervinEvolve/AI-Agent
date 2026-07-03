import { describe, expect, it } from "vitest";
import { constraints } from "./constraints";

describe("browser irreversible actions constraint policy coverage", () => {
  const getBrowserConstraintDescription = () => {
    const constraint = constraints.constraints.find(
      ({ id }) => id === "con_browser_irreversible_actions_8",
    );

    expect(constraint).toBeDefined();
    return constraint!.description.toLowerCase();
  };

  it("covers each irreversible, sensitive, costly, and identity-bearing browser action category", () => {
    const description = getBrowserConstraintDescription();

    const requiredActionCategories = [
      "purchases",
      "financial transfers",
      "legal/medical/government submissions",
      "account deletion",
      "public posting",
      "sending messages",
      "changing security settings",
      "uploading private files",
      "accepting contracts",
      "captcha circumvention",
      "entering credentials",
    ];

    for (const category of requiredActionCategories) {
      expect(description).toContain(category);
    }
  });

  it("distinguishes allowed preparation from final submission and access-control bypasses", () => {
    const description = getBrowserConstraintDescription();

    expect(description).toContain("may prepare forms");
    expect(description).toContain("navigate up to the confirmation boundary");
    expect(description).toContain("final submission requires");
    expect(description).toContain("identifies the site, action, and material consequences");

    for (const protectedBoundary of [
      "paywalls",
      "access controls",
      "robots-style restrictions",
      "anti-bot protections",
      "captchas",
    ]) {
      expect(description).toContain(protectedBoundary);
    }

    expect(description).toContain("authorization");
    expect(description).toContain("policy-approved");
  });
});
