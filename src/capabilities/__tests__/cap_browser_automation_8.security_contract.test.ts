import { describe, it, expect } from "vitest";
import { constraints, validateAPIClientRequest } from "../../constraints/constraints";

describe("cap_browser_automation_8 Security Contract integration", () => {
  it("should enforce that the irreversible action constraint protects both browser automation and API clients", () => {
    const constraint = constraints.find(c => c.id === "con_browser_irreversible_actions_8");
    expect(constraint).toBeDefined();
    expect(constraint?.description).toContain("structured API clients");
    expect(constraint?.description).toContain("GraphQL mutation");
  });

  it("should block any state-changing API requests when not confirmed", () => {
    const req = {
      method: "PATCH",
      url: "https://api.example.com/settings",
      body: { theme: "dark" }
    };
    const context = {
      isInteractive: true,
      hasUserConfirmation: false
    };
    const result = validateAPIClientRequest(req, context);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("requires_explicit_user_confirmation");
  });
});
