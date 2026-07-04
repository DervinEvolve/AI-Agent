import { describe, it, expect } from "vitest";
import { constraints, validateAPIClientRequest } from "./constraints";

describe("Browser and API client irreversible action constraint", () => {
  it("should define the correct constraint structure and ID", () => {
    expect(constraints).toHaveLength(1);
    expect(constraints[0].id).toBe("con_browser_irreversible_actions_8");
    expect(constraints[0].description).toContain("The agent must not use browser automation or structured API clients");
    expect(constraints[0].description).toContain("state-changing HTTP method (POST, PUT, DELETE, PATCH)");
    expect(constraints[0].description).toContain("GraphQL mutation");
  });

  it("should allow safe GET requests without interactive context or confirmation", () => {
    const req = { method: "GET", url: "https://api.example.com/v1/users" };
    const context = { isInteractive: false, hasUserConfirmation: false };
    const res = validateAPIClientRequest(req, context);
    expect(res.allowed).toBe(true);
  });

  it("should fail closed with policy_blocked for state-changing HTTP methods in non-interactive contexts", () => {
    const methods = ["POST", "PUT", "DELETE", "PATCH"];
    for (const method of methods) {
      const req = { method, url: "https://api.example.com/v1/resource" };
      const context = { isInteractive: false, hasUserConfirmation: false };
      const res = validateAPIClientRequest(req, context);
      expect(res.allowed).toBe(false);
      expect(res.reason).toBe("policy_blocked");
    }
  });

  it("should block state-changing requests in interactive context when user confirmation is missing", () => {
    const req = { method: "POST", url: "https://api.example.com/v1/resource" };
    const context = { isInteractive: true, hasUserConfirmation: false };
    const res = validateAPIClientRequest(req, context);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("requires_explicit_user_confirmation");
  });

  it("should detect GraphQL mutations in POST requests and block them appropriately", () => {
    const req = {
      method: "POST",
      url: "https://api.example.com/graphql",
      body: { query: "mutation CreateUser { createUser(name: \"Alice\") { id } }" }
    };
    const context = { isInteractive: false, hasUserConfirmation: false };
    const res = validateAPIClientRequest(req, context);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("policy_blocked");
  });

  it("should allow state-changing methods when fully confirmed and matching interactive context", () => {
    const req = { method: "PUT", url: "https://api.example.com/v1/resource/123" };
    const context = {
      isInteractive: true,
      hasUserConfirmation: true,
      confirmedTarget: "/v1/resource/123"
    };
    const res = validateAPIClientRequest(req, context);
    expect(res.allowed).toBe(true);
  });

  it("should block if there is a target mismatch in user confirmation", () => {
    const req = { method: "DELETE", url: "https://api.example.com/v1/resource/456" };
    const context = {
      isInteractive: true,
      hasUserConfirmation: true,
      confirmedTarget: "/v1/resource/123" // Mismatched target path
    };
    const res = validateAPIClientRequest(req, context);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("confirmation_target_mismatch");
  });
});
