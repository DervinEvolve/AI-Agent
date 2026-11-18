import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import {
  LiveModelAdapter,
  HostConfig,
  BoundedRequest,
  ProviderResponse,
  TransportError,
} from '../cap_live_model_adapter_21';

interface FixtureResponse {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

function sendFixture(res: http.ServerResponse, fixture: FixtureResponse): void {
  res.writeHead(fixture.status, fixture.headers ?? { 'content-type': 'application/json' });
  res.end(fixture.body);
}

async function withServer(
  response: FixtureResponse,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      sendFixture(res, response);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function makeConfig(baseUrl: string): HostConfig {
  return {
    base_url: baseUrl,
    model: 'test-model',
    api_key_env: 'TEST_LIVE_MODEL_API_KEY',
    timeout_ms: 5000,
    max_response_bytes: 4 * 1024 * 1024,
    finalization_reserve_ms: 100,
  };
}

function makeRequest(): BoundedRequest {
  return {
    messages: [
      { role: 'user', content: 'What is the weather in Paris?' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string' },
            },
            required: ['location'],
          },
        },
      },
    ],
    deadline_ms: Date.now() + 10000,
    max_attempts: 1,
  };
}

describe('LiveModelAdapter additional tests', () => {
  const originalEnv = process.env.TEST_LIVE_MODEL_API_KEY;

  beforeAll(() => {
    process.env.TEST_LIVE_MODEL_API_KEY = 'dummy-key';
  });

  afterAll(() => {
    if (originalEnv === undefined) {
      delete process.env.TEST_LIVE_MODEL_API_KEY;
    } else {
      process.env.TEST_LIVE_MODEL_API_KEY = originalEnv;
    }
  });

  it('should parse a valid tool call response and return the tool call', async () => {
    const toolCallResponse = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: 1677652288,
      model: 'test-model',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_abc123',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"location":"Paris"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    };

    await withServer(
      { status: 200, body: JSON.stringify(toolCallResponse) },
      async (baseUrl) => {
        const adapter = new LiveModelAdapter(makeConfig(baseUrl));
        const result = await adapter.complete(makeRequest());

        expect(result).not.toHaveProperty('error');
        const providerResponse = result as ProviderResponse;
        expect(providerResponse.finish).toBe('tool_calls');
        expect(providerResponse.tool_calls).toHaveLength(1);
        expect(providerResponse.tool_calls![0].function.name).toBe('get_weather');
        expect(providerResponse.tool_calls![0].function.arguments).toBe('{"location":"Paris"}');
        expect(providerResponse.usage).toEqual({
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        });
      }
    );
  });

  it('should return a transport error on HTTP 500', async () => {
    const errorResponse = {
      error: {
        message: 'Internal server error',
        type: 'server_error',
      },
    };

    await withServer(
      { status: 500, body: JSON.stringify(errorResponse) },
      async (baseUrl) => {
        const adapter = new LiveModelAdapter(makeConfig(baseUrl));
        const result = await adapter.complete(makeRequest());

        expect(result).toHaveProperty('error', 'transport_error');
        const transportError = result as TransportError;
        expect(transportError.status_code).toBe(500);
        expect(transportError.retryable).toBe(false);
        expect(transportError.phase).toBe('pre-content');
      }
    );
  });
});
