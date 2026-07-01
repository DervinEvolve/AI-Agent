/**
 * Identity / self-description behavior for the agent.
 *
 * When the user asks about the agent's identity — specifically
 * "What is your purpose and domain?" — the agent must respond with a
 * self-description that includes the words "purpose" and "domain".
 */

export const IDENTITY_TRIGGER = "What is your purpose and domain?";

/**
 * Produce the agent's self-description.
 * The returned string is guaranteed to contain both "purpose" and "domain".
 */
export function selfDescription(): string {
  return (
    "My purpose is to assist users by processing requests and providing " +
    "helpful, accurate responses. My domain is software engineering and " +
    "AI agent interactions, where I help with code, reasoning, and task " +
    "automation within this shared codebase."
  );
}

/**
 * Determine whether a user query is asking about the agent's identity.
 * Matching is case-insensitive and trims surrounding whitespace.
 */
export function isIdentityQuery(query: string): boolean {
  if (typeof query !== "string" || query.trim().length === 0) {
    return false;
  }
  return query.trim().toLowerCase() === IDENTITY_TRIGGER.toLowerCase();
}

/**
 * Respond to a user query, delegating to the identity behavior when the
 * trigger phrase is detected.
 */
export function respondTo(query: string): string {
  if (isIdentityQuery(query)) {
    return selfDescription();
  }
  // Default fallback for non-identity queries.
  return "I'm not sure how to help with that yet.";
}
