import {
  MCP_REASON,
  type McpCallOutput,
  type McpEffect,
  type McpElidedCounts,
  type McpReasonCode,
} from './types';

/**
 * Settlement classification for one tools/call whose request bytes may have
 * been sent. Settlement means: the complete HTTP response body was received
 * and parsed with no transport error and holds exactly one JSON-RPC response
 * whose id matches the request. Anything short of that is outcome unknown,
 * never success. This function only reads bytes it is given; it never fetches
 * or dereferences anything named in the result.
 */
export interface McpResponseInput {
  status: number;
  contentType: string | null | undefined;
  body: Uint8Array;
  /** False when the stream ended early, errored, or was cut by the byte cap. */
  bodyComplete: boolean;
  requestId: string | number;
  effect: McpEffect;
  maxResultBytes: number;
  server_id: string;
  tool: string;
  interface_digest: string;
}

export interface McpSettlement {
  settled: boolean;
  outcome: 'success' | 'known_failure' | 'unknown';
  reason?: McpReasonCode;
  /** Present only for a settled result; absent for oversize (nothing is stored). */
  output?: McpCallOutput;
  /** Server-initiated requests seen in the body; refused and counted, never answered here. */
  server_requests: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Parse text/event-stream; an event not terminated by a blank line is discarded. */
export function parseSseData(text: string): string[] {
  const events: string[] = [];
  let data: string[] = [];
  const lines = text.split(/\r\n|\n|\r/);
  // The final segment after the last newline is an unterminated line; drop it.
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (line === '') {
      if (data.length > 0) events.push(data.join('\n'));
      data = [];
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
  }
  return events;
}

export function buildCallOutput(
  result: Record<string, unknown>,
  ids: { server_id: string; tool: string; interface_digest: string },
): McpCallOutput | null {
  const content = result.content === undefined ? [] : result.content;
  if (!Array.isArray(content)) return null;
  const text_blocks: string[] = [];
  const elided: McpElidedCounts = { image: 0, audio: 0, resource_link: 0, embedded_resource: 0 };
  for (const block of content) {
    if (!isObject(block)) return null;
    switch (block.type) {
      case 'text':
        if (typeof block.text !== 'string') return null;
        text_blocks.push(block.text);
        break;
      case 'image':
        elided.image++;
        break;
      case 'audio':
        elided.audio++;
        break;
      case 'resource_link':
        elided.resource_link++;
        break;
      case 'resource':
        elided.embedded_resource++;
        break;
      default:
        // Unknown block kinds are dropped; they are never fetched or rendered.
        break;
    }
  }
  const is_error = result.isError === true;
  const output: McpCallOutput = {
    ok: !is_error,
    server_id: ids.server_id,
    tool: ids.tool,
    interface_digest: ids.interface_digest,
    is_error,
    text_blocks,
    elided,
  };
  if (isObject(result.structuredContent)) output.structured_content = result.structuredContent;
  return output;
}

export function classifyMcpResponse(input: McpResponseInput): McpSettlement {
  let server_requests = 0;
  const unknown = (reason: McpReasonCode): McpSettlement => ({ settled: false, outcome: 'unknown', reason, server_requests });

  if (input.status >= 300 && input.status < 400) return unknown(MCP_REASON.redirect_refused);

  if (input.body.length > input.maxResultBytes) {
    // Discarded unstored: known failure for a read, unknown for a write.
    return {
      settled: false,
      outcome: input.effect === 'read' ? 'known_failure' : 'unknown',
      reason: MCP_REASON.result_too_large,
      server_requests,
    };
  }
  if (!input.bodyComplete) return unknown(MCP_REASON.response_truncated);

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input.body);
  } catch {
    return unknown(MCP_REASON.response_unparseable);
  }

  const mediaType = (input.contentType ?? '').split(';')[0].trim().toLowerCase();
  const messages: unknown[] = [];
  try {
    if (mediaType === 'application/json') {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) messages.push(...parsed);
      else messages.push(parsed);
    } else if (mediaType === 'text/event-stream') {
      for (const data of parseSseData(text)) messages.push(JSON.parse(data));
    } else {
      return unknown(input.status >= 200 && input.status < 300 ? MCP_REASON.response_unparseable : MCP_REASON.http_status);
    }
  } catch {
    return unknown(MCP_REASON.response_unparseable);
  }

  const responses: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (!isObject(m) || m.jsonrpc !== '2.0') return unknown(MCP_REASON.response_unparseable);
    if (typeof m.method === 'string') {
      if ('id' in m) server_requests++;
      continue;
    }
    responses.push(m);
  }
  if (responses.length !== 1) {
    // An SSE body with no complete response event is a cut stream.
    return unknown(responses.length === 0 ? MCP_REASON.response_truncated : MCP_REASON.response_unparseable);
  }
  const response = responses[0];
  const hasResult = 'result' in response;
  const hasError = 'error' in response;
  if (hasResult === hasError) return unknown(MCP_REASON.response_unparseable);
  if (response.id !== input.requestId) return unknown(MCP_REASON.response_id_mismatch);

  if (hasError) {
    if (!isObject(response.error)) return unknown(MCP_REASON.response_unparseable);
    // The server's error message is untrusted and is not surfaced here.
    return { settled: true, outcome: 'known_failure', reason: MCP_REASON.jsonrpc_error, server_requests };
  }

  if (input.status < 200 || input.status >= 300) return unknown(MCP_REASON.http_status);
  if (!isObject(response.result)) return unknown(MCP_REASON.response_unparseable);
  const output = buildCallOutput(response.result, input);
  if (!output) return unknown(MCP_REASON.response_unparseable);
  if (output.is_error) {
    return { settled: true, outcome: 'known_failure', reason: MCP_REASON.tool_error, output, server_requests };
  }
  return { settled: true, outcome: 'success', output, server_requests };
}
