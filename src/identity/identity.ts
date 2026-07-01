/**
 * Self-description for the agent. The response is built from fixed
 * template fields so that the words 'purpose' and 'domain' always
 * appear, regardless of how the method is invoked.
 */

const PURPOSE =
  'The purpose of this agent is to help users understand and correctly compute the addition and subtraction of integers.';
const DOMAIN =
  'The domain of this agent is basic integer addition and subtraction (educational).';
const OPERATORS =
  'Supported operators are "+" (addition) and "-" (subtraction).';
const SAFETY =
  'Inputs are validated: non-integer, non-finite, boolean, or malformed values are rejected with structured errors.';

export interface Description {
  purpose: string;
  domain: string;
  operators: string;
  safety: string;
  summary: string;
}

export function get_description(): Description {
  const summary = `${PURPOSE} ${DOMAIN} ${OPERATORS} ${SAFETY}`;
  return {
    purpose: PURPOSE,
    domain: DOMAIN,
    operators: OPERATORS,
    safety: SAFETY,
    summary,
  };
}

export default { get_description };
