import { describe, it, expect } from "vitest";
import {
  constraint,
  validateDialogueNonAuthority,
  DialogueState,
} from "./dialogue_non_authority_21";

describe("Dialogue non-authority constraint", () => {
  it("has required constraint fields", () => {
    expect(constraint).toHaveProperty("id", "con_dialogue_non_authority_21");
    expect(constraint).toHaveProperty("name");
    expect(constraint).toHaveProperty("status", "active");
    expect(constraint).toHaveProperty("added_epoch", 21);
    expect(constraint).toHaveProperty("description");
    expect(constraint).toHaveProperty("implementation");
    expect(constraint.implementation.tests).toBeInstanceOf(Array);
  });

  describe("validateDialogueNonAuthority", () => {
    const baseState: DialogueState = {
      taintLevel: 1,
    };

    it("returns empty violations for a compliant state", () => {
      const violations = validateDialogueNonAuthority(baseState);
      expect(violations).toEqual([]);
    });

    it("rejects raw secrets", () => {
      const state = { ...baseState, rawSecrets: ["my-password"] };
      const violations = validateDialogueNonAuthority(state);
      expect(violations).toContainEqual(
        expect.stringContaining("raw secrets")
      );
    });

    it("rejects approval tokens", () => {
      const state = { ...baseState, approvalTokens: ["abc123"] };
      const violations = validateDialogueNonAuthority(state);
      expect(violations).toContainEqual(
        expect.stringContaining("approval tokens")
      );
    });

    it("rejects live auth state", () => {
      const state = { ...baseState, liveAuthState: { token: "x" } };
      const violations = validateDialogueNonAuthority(state);
      expect(violations).toContainEqual(
        expect.stringContaining("live auth state")
      );
    });

    it("rejects cleared taint", () => {
      const state = { ...baseState, clearedTaint: true };
      const violations = validateDialogueNonAuthority(state);
      expect(violations).toContainEqual(
        expect.stringContaining("taint has been cleared")
      );
    });

    it("rejects decreasing taint level", () => {
      const state = { ...baseState, taintLevel: 0, previousTaintLevel: 1 };
      const violations = validateDialogueNonAuthority(state);
      expect(violations).toContainEqual(
        expect.stringContaining("Taint level decreased")
      );
    });

    it("rejects commitments marked as HITL-approved", () => {
      const state = {
        ...baseState,
        commitments: [
          { action: "send_email", hitlApproved: true },
        ],
      };
      const violations = validateDialogueNonAuthority(state);
      expect(violations).toContainEqual(
        expect.stringContaining("incorrectly marked as HITL-approved")
      );
    });

    it("rejects commitments containing approval tokens", () => {
      const state = {
        ...baseState,
        commitments: [
          { action: "send_email", hitlApproved: false, approvalToken: "tok" },
        ],
      };
      const violations = validateDialogueNonAuthority(state);
      expect(violations).toContainEqual(
        expect.stringContaining("contains an approval token")
      );
    });

    it("rejects utterances with raw secrets", () => {
      const state = {
        ...baseState,
        utterances: [{ text: "api_key=sk-1234567890abcdef", redacted: false }],
      };
      const violations = validateDialogueNonAuthority(state);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]).toContain("potential raw secret");
    });

    it("does not flag redacted utterances", () => {
      const state = {
        ...baseState,
        utterances: [
          { text: "api_key=sk-1234567890abcdef", redacted: true },
        ],
      };
      const violations = validateDialogueNonAuthority(state);
      expect(violations).toEqual([]);
    });

    it("rejects exported snapshot with forbidden keys", () => {
      const state = {
        ...baseState,
        exportedSnapshot: { rawSecrets: ["secret"], result: "ok" },
      };
      const violations = validateDialogueNonAuthority(state);
      expect(violations).toContainEqual(
        expect.stringContaining("forbidden key: rawSecrets")
      );
    });

    it("rejects direct use as tool arguments", () => {
      const state = {
        ...baseState,
        usedAsToolArguments: true,
      };
      const violations = validateDialogueNonAuthority(state);
      expect(violations).toContainEqual(
        expect.stringContaining("used directly as tool arguments")
      );
    });

    // Additional test: agent-recorded promises do not bypass HITL
    it("agent-recorded promises do not automatically bypass HITL", () => {
      // Even if the agent records a promise, the commitment should not be approved
      const state = {
        ...baseState,
        commitments: [
          {
            action: "I will send the report",
            hitlApproved: false,
            approvalToken: undefined,
          },
        ],
      };
      const violations = validateDialogueNonAuthority(state);
      // Should pass if no hitlApproved or approvalToken
      expect(violations).toEqual([]);
      // But if someone mistakenly marks it as approved, it should fail
      const badState = {
        ...baseState,
        commitments: [
          {
            action: "I will send the report",
            hitlApproved: true,
          },
        ],
      };
      const badViolations = validateDialogueNonAuthority(badState);
      expect(badViolations).toContainEqual(
        expect.stringContaining("incorrectly marked as HITL-approved")
      );
    });
  });
});
