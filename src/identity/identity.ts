/**
 * Canonical self-description behavior for the agent.
 *
 * This is the single, consolidated source of truth for how the agent
 * describes its purpose and domain. Other modules (e.g. src/identity.ts)
 * should re-export or delegate to the constants and functions defined here
 * rather than maintaining their own copies.
 */

/** The formal domain phrase for this agent's educational focus. */
export const DOMAIN = 'educational mathematics assistance' as const;

/** A human-readable description of the agent's purpose and domain. */
export const DESCRIPTION =
  `My purpose is to help users understand and correctly compute the addition of two integers. ` +
  `My domain is ${DOMAIN}.` as const;

/**
 * The single canonical behavior that answers purpose/domain queries.
 *
 * @returns An object containing the agent's purpose, domain, and full description.
 */
export function describeSelf(): {
  purpose: string;
  domain: string;
  description: string;
} {
  return {
    purpose:
      'To help users understand and correctly compute the addition of two integers.',
    domain: DOMAIN,
    description: DESCRIPTION,
  };
}

export default describeSelf;
