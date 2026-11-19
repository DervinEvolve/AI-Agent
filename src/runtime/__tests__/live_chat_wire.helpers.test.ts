import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  MAX_ERROR_BODY_CHARS,
  redactKey,
  readApiKeyFromEnv,
  checkEndpoint,
  extractChatCompletion,
} from '../live_chat_wire';

// Pure-helper tests: no sockets, no API key, no imports from the rest of src/.
// Only symbols added in this PR are imported.

const SENTINEL_KEY = 'sk-sentinel-HELPERS-DO-NOT-LEAK-91bd2e';

describe('live_chat_wire constants', () => {
  it('pins the default response cap at 4 MiB and the error body bound at 512 chars', () => {
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBe(4194304);
    expect(MAX_ERROR_BODY_CHARS).toBe(512);
  });
});

describe('readApiKeyFromEnv', () => {
  it('returns the key from the named variable', () => {
    expect(readApiKeyFromEnv({ LIVE_KEY: SENTINEL_KEY }, 'LIVE_KEY')).toBe(SENTINEL_KEY);
  });

  it('fails closed for a missing, empty, or whitespace-only key', () => {
    expect(readApiKeyFromEnv({}, 'LIVE_KEY')).toBeFalsy();
    expect(readApiKeyFromEnv({ LIVE_KEY: undefined }, 'LIVE_KEY')).toBeFalsy();
    expect(readApiKeyFromEnv({ LIVE_KEY: '' }, 'LIVE_KEY')).toBeFalsy();
    expect(readApiKeyFromEnv({ LIVE_KEY: '   ' }, 'LIVE_KEY')).toBeFalsy();
    expect(readApiKeyFromEnv({ LIVE_KEY: ' \t\n ' }, 'LIVE_KEY')).toBeFalsy();
  });

  it('does not read a key from a different variable', () => {
    expect(readApiKeyFromEnv({ OTHER_KEY: SENTINEL_KEY }, 'LIVE_KEY')).toBeFalsy();
  });
});

describe('redactKey', () => {
  it('removes every occurrence of the key and keeps the surrounding text', () => {
    const text = 'request failed: ' + SENTINEL_KEY + ' and again ' + SENTINEL_KEY + ' end';
    const out = redactKey(text, SENTINEL_KEY);
    expect(typeof out).toBe('string');
    expect(out).not.toContain(SENTINEL_KEY);
    expect(out).toContain('request failed');
    expect(out).toContain('and again');
  });

  it('does not throw when no key is available', () => {
    let out: unknown;
    expect(() => {
      out = redactKey('some diagnostic text', undefined);
    }).not.toThrow();
    expect(typeof out).toBe('string');
  });
});

describe('checkEndpoint', () => {
  it('accepts a non-loopback https endpoint and returns the parsed URL', () => {
    const r = checkEndpoint('https://example.com/v1/chat/completions', false);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url.hostname).toBe('example.com');
      expect(r.url.protocol).toBe('https:');
    }
  });

  it('rejects plain http to a non-loopback host, with or without the fixture opt-in', () => {
    expect(checkEndpoint('http://example.com/v1/chat/completions', false).ok).toBe(false);
    expect(checkEndpoint('http://example.com/v1/chat/completions', true).ok).toBe(false);
  });

  it('allows http to 127.0.0.1 only under the explicit fixture opt-in', () => {
    const endpoint = 'http://127.0.0.1:8123/v1/chat/completions';
    expect(checkEndpoint(endpoint, false).ok).toBe(false);
    const allowed = checkEndpoint(endpoint, true);
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.url.hostname).toBe('127.0.0.1');
      expect(allowed.url.port).toBe('8123');
    }
  });

  it('rejects userinfo in the URL', () => {
    const r = checkEndpoint('https://user:pass@example.com/v1/chat/completions', false);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(typeof r.reason).toBe('string');
    }
  });

  it('rejects a string that is not a URL without throwing', () => {
    let ok: boolean | undefined;
    expect(() => {
      ok = checkEndpoint('not a url at all', false).ok;
    }).not.toThrow();
    expect(ok).toBe(false);
  });
});

describe('extractChatCompletion', () => {
  it('never throws on malformed or structurally invalid complete bodies', () => {
    const bodies = [
      '',
      '{not json',
      'null',
      '[]',
      '42',
      '"just a string"',
      '{}',
      '{"choices":[]}',
      '{"choices":"nope"}',
      '{"choices":[null]}',
      '{"choices":[{"finish_reason":"length","message":{"role":"assistant","content":"x"}}]}',
      '{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":"bad"}}]}',
      JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_a', type: 'function', function: { name: 'f', arguments: '{}' } },
                { id: 'call_b', type: 'function', function: { name: 'g', arguments: '{bad' } },
              ],
            },
          },
        ],
      }),
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    ];
    for (const body of bodies) {
      expect(() => extractChatCompletion(body)).not.toThrow();
    }
  });
});
