/**
 * Shared identity/self-description behavior for the AI agent.
 *
 * The self-description is intentionally deterministic so that repeated queries
 * and query variations receive a consistent answer containing both "purpose"
 * and "domain".
 */

export const SELF_DESCRIPTION =
  "My purpose is to help users with software engineering tasks, and my domain is Node/TypeScript AI agent development.";

export interface Identity {
  name: string;
  purpose: string;
  domain: string;
  selfDescription: string;
}

export const IDENTITY: Identity = {
  name: "AI Agent",
  purpose: "help users with software engineering tasks",
  domain: "Node/TypeScript AI agent development",
  selfDescription: SELF_DESCRIPTION,
};

export function isPurposeAndDomainQuery(query?: string): boolean {
  if