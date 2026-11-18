import { describe, it, expect } from 'vitest';
import {
  CompactionPolicy,
  CompactionState,
  DEFAULT_COMPACTION_POLICY,
  OrdinaryRequest,
  renderCompaction,
} from '../cap_context_compaction_12';

describe('renderCompaction summary inclusion', () => {
  it('includes the previous working summary in a bounded ordinary request', () => {
    const request = {
      messages: [{ role: 'user', content: 'latest user turn' }],
      tools: [],
      max_tokens: 1000,
    } as unknown as OrdinaryRequest;

    const state: CompactionState = {
      summary: 'prior-working-summary',
      generation: 1,
      replacedThroughGroupOrdinal: 5,
    };

    const policy: CompactionPolicy = {
      ...DEFAULT_COMPACTION_POLICY,
      maxRequestTokens: 10000,
      tokenCounter: (text: string) => text.length,
    };

    const rendered: any = renderCompaction(request, state, policy);
    const bounded = rendered.request ?? rendered;

    expect(bounded).toBeDefined();
    expect(bounded.messages).toBeInstanceOf(Array);
    expect(bounded.messages.some((m: any) => m.content.includes('prior-working-summary'))).toBe(true);
  });

  it('returns the original request without summary when no compaction state is present', () => {
    const request = {
      messages: [{ role: 'user', content: 'turn' }],
      tools: [],
      max_tokens: 1000,
    } as unknown as OrdinaryRequest;

    const policy: CompactionPolicy = {
      ...DEFAULT_COMPACTION_POLICY,
      maxRequestTokens: 10000,
      tokenCounter: (text: string) => text.length,
    };

    const rendered: any = renderCompaction(request, undefined, policy);
    const bounded = rendered.request ?? rendered;

    expect(bounded.messages).toEqual(request.messages);
  });
});
