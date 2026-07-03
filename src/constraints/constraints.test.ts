import { describe, expect, it } from "vitest";
import { constraints } from "./constraints";

describe("constraints registry", () => {
  it("defines constraints with unique convention-compliant ids", () => {
    expect(constraints.constraints.length).toBeGreaterThan(0);

    const ids = constraints.constraints.map((constraint) => constraint.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const id of ids) {
      expect(id).toMatch(/^con_[a-z0-9_]+_\d+$/);
    }
  });

  it("includes browser confirmation boundaries for irreversible and access-control actions", () => {
    const browserConstraint = constraints.constraints.find(
      (constraint) => constraint.id === "con_browser_irreversible_actions_8",
    );

    expect(browserConstraint).toBeDefined();
    expect(browserConstraint?.description).toContain("explicit user confirmation immediately before the action");
    expect(browserConstraint?.description).toContain("entering credentials");
    expect(browserConstraint?.description).toContain("CAPTCHA circumvention");
    expect(browserConstraint?.description).toContain("final submission requires a clear user approval");
    expect(browserConstraint?.description).toContain("identifies the site, action, and material consequences");
    expect(browserConstraint?.description).toContain("must never bypass paywalls, access controls");
  });
});
