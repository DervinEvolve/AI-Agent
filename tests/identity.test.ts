import { Identity } from '../src/identity';
import { LLM } from '../src/llm';

describe('Identity', () => {
  let mockLLM: jest.Mocked<LLM>;
  let identity: Identity;

  beforeEach(() => {
    mockLLM = {
      generate: jest.fn(),
    } as any;
    identity = new Identity(mockLLM);
  });

  it('describes self with purpose and domain when asked', async () => {
    const trigger = 'What is your purpose and domain?';
    const result = await identity.describeSelf(trigger);
    expect(result).toContain('purpose');
    expect(result).toContain('domain');
    expect(mockLLM.generate).not.toHaveBeenCalled();
  });

  it('delegates other triggers to LLM', async () => {
    const trigger = 'Who are you?';
    const expectedResponse = 'I am an AI assistant.';
    mockLLM.generate.mockResolvedValueOnce(expectedResponse);
    const result = await identity.describeSelf(trigger);
    expect(result).toBe(expectedResponse);
    expect(mockLLM.generate).toHaveBeenCalledWith('Describe yourself as an AI agent.', 150);
  });
});