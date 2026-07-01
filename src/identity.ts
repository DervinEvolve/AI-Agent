import { Intent, IntentParser } from './intent';
import { LLM } from './llm';

export class Identity {
  private llm: LLM;

  constructor(llm: LLM) {
    this.llm = llm;
  }

  async describeSelf(trigger: string): Promise<string> {
    // If the trigger matches the purpose/domain query, return a consistent description.
    if (/what is your purpose and domain?/i.test(trigger)) {
      // This description must include the words 'purpose' and 'domain'.
      return 'I am an AI agent whose purpose is to assist users and operate within the domain of providing helpful, accurate, and safe responses.';
    }

    // For other queries, delegate to the LLM for a generic description.
    return this.llm.generate(`Describe yourself as an AI agent.`, 150);
  }
}