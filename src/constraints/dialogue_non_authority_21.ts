export interface DialogueState {
  // The raw utterances, possibly containing sensitive data
  utterances?: Array<{ text: string; redacted?: boolean }>;
  // Any raw secrets that should not be stored
  rawSecrets?: string[];
  // Tokens that could be used to bypass HITL
  approvalTokens?: string[];
  // Live authentication state
  liveAuthState?: Record<string, unknown>;
  // Taint level (monotonically increasing)
  taintLevel: number;
  // Previous taint level for comparison
  previousTaintLevel?: number;
  // Advisory commitments made by the agent
  commitments?: Array<{
    action: string;
    hitlApproved: boolean;
    approvalToken?: string;
  }>;
  // Whether the state has been cleared of taint
  clearedTaint?: boolean;
  // Whether the state is being used directly as tool arguments
  usedAsToolArguments?: boolean;
  // Exported snapshot for external use
  exportedSnapshot?: Record<string, unknown>;
  // Internal metadata that should not be exposed
  internalMetadata?: Record<string, unknown>;
}

export const constraint = {
  id: "con_dialogue_non_authority_21",
  name: "Dialogue state non-authority, taint preservation, and HITL integrity",
  status: "active",
  added_epoch: 21,
  description:
    "The dialogue manager must never be used to authorize side effects, clear taint, satisfy HITL confirmation, directly set tool arguments/URLs/api identifiers/grant ids/sub-agent goals, or substitute agent commitments for user approvals. The dialogue state as a whole is tainted and must be treated as delimited data within context assembly. Commitments tracked in dialogue_manager are advisory and never bypass the requirement for a fresh, action-bound HITL approval before any irreversible action. Dialogue state must preserve monotonic taint and must not store raw secrets, vault tokens, approval tokens, browser cookies, hidden prompts, or live auth state.",
  implementation: {
    tests: [
      "a commitment stored in dialogue_manager cannot be used to authorize a browser/API/vault dispatch without explicit HITL approval",
      "a dialogue state claim cannot satisfy a HITL gate or serve as an approval token",
      "dialogue state cannot clear taint or convert tainted evidence into trusted tool arguments",
      "a commitment to perform a state-changing action still requires the executing adapter to obtain a fresh HITL approval_token before dispatch",
      "utterance containing raw secrets is redacted before storage; if redaction makes it empty, placeholder inserted",
      "exported snapshot never exposes raw secrets, live auth state, or internal-only metadata",
      "controller integration verifies dialogue state is never passed directly to tool adapters as arguments without independent validation",
      "agent-recorded promises like 'I will send the report' must not trigger an automatic HITL bypass; the subsequent dispatch still goes through HITL gate",
    ],
  },
};

/**
 * Validates that a dialogue state adheres to the non-authority guardrail.
 * Returns an array of violation messages. Empty array means compliant.
 */
export function validateDialogueNonAuthority(state: DialogueState): string[] {
  const violations: string[] = [];

  // 1. No raw secrets stored
  if (state.rawSecrets && state.rawSecrets.length > 0) {
    violations.push("Dialogue state contains raw secrets.");
  }

  // 2. No approval tokens stored
  if (state.approvalTokens && state.approvalTokens.length > 0) {
    violations.push("Dialogue state contains approval tokens.");
  }

  // 3. No live auth state
  if (state.liveAuthState && Object.keys(state.liveAuthState).length > 0) {
    violations.push("Dialogue state contains live auth state.");
  }

  // 4. Taint must not be cleared (monotonic increase or equal)
  if (state.clearedTaint) {
    violations.push("Dialogue state taint has been cleared.");
  }
  if (
    state.previousTaintLevel !== undefined &&
    state.taintLevel < state.previousTaintLevel
  ) {
    violations.push("Taint level decreased, violating monotonicity.");
  }

  // 5. Commitments must not bypass HITL (they are advisory)
  if (state.commitments) {
    for (const commit of state.commitments) {
      if (commit.hitlApproved) {
        violations.push(
          `Commitment '${commit.action}' is incorrectly marked as HITL-approved. Commitments are advisory and cannot satisfy HITL.`
        );
      }
      if (commit.approvalToken) {
        violations.push(
          `Commitment '${commit.action}' contains an approval token, which is not allowed.`
        );
      }
    }
  }

  // 6. Utterances must not contain raw secrets (redaction should have occurred)
  if (state.utterances) {
    for (const utt of state.utterances) {
      if (!utt.redacted && containsSecretPattern(utt.text)) {
        violations.push(
          `Utterance contains potential raw secret: "${utt.text.substring(0, 50)}..."`
        );
      }
      // If redacted and empty, placeholder should be inserted (not enforced here, but could be)
    }
  }

  // 7. Exported snapshot must not expose secrets, auth state, or internal metadata
  if (state.exportedSnapshot) {
    const snapshotKeys = Object.keys(state.exportedSnapshot);
    const forbiddenKeys = [
      "rawSecrets",
      "approvalTokens",
      "liveAuthState",
      "internalMetadata",
      "secrets",
      "tokens",
      "auth",
    ];
    for (const key of forbiddenKeys) {
      if (snapshotKeys.includes(key)) {
        violations.push(
          `Exported snapshot contains forbidden key: ${key}`
        );
      }
    }
  }

  // 8. Dialogue state must not be used directly as tool arguments (flag)
  if (state.usedAsToolArguments) {
    violations.push(
      "Dialogue state is being used directly as tool arguments without independent validation."
    );
  }

  // 9. Agent-recorded promises should not bypass HITL (handled by commitments check above)

  return violations;
}

// Simple secret pattern detection (regex for API keys, tokens, etc.)
function containsSecretPattern(text: string): boolean {
  const patterns = [
    /(?:api[_-]?key|apikey|secret|token|password|auth)\s*[:=]\s*[^\s]{8,}/i,
    /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/,
    /sk-[a-zA-Z0-9]{20,}/,
    /xox[bprs]-[a-zA-Z0-9-]+/,
  ];
  return patterns.some((p) => p.test(text));
}
