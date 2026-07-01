export interface AgentIdentity {
  domain: string;
  purpose: string;
}

export const identity: AgentIdentity = {
  domain: "educational mathematics assistance",
  purpose: "To assist users in understanding and solving basic mathematics queries"
};

export function getSelfDescription(): string {
  return `Domain: ${identity.domain}. Purpose: ${identity.purpose}.`;
}
