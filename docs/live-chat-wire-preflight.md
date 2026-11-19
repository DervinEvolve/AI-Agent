# cap_live_model_adapter_21: preflight status and what this change ships

## Export preflight: NOT completed

The spec requires the PR to record the inspected commit SHA and the full
signatures of every `src/` export the adapter and its tests import, read from a
checkout of main, and to run the baseline suite first.

That was not done. The author of this change had only the top-level file
listing, not file contents. Therefore:

- No commit SHA was inspected and no signatures are recorded here.
- The baseline install and suite were not run by the author before pushing.
- The field names of `ModelAdapter`, `ActionDecoder`, `ToolResult`,
  `ToolRegistry`, `ContextManager` and the finalizer are unverified.
- Whether `src/runtime/live_model_transport.ts` already covers some of the
  behaviour below is unverified. If it does, the overlap should be resolved in
  a follow-up by someone who has read both files.
- Whether a denied-bytes registry is exported is unknown. No denied-bytes check
  was run or is claimed. The duty in con_live_model_authority_21 remains open.

To respect "tests import only listed symbols or symbols added in the same PR",
this change imports **nothing** from existing `src/` modules. It does not call
`registry.list()` or `redactSecrets()` (the e22 failures).

## What is shipped

`src/runtime/live_chat_wire.ts` (Node built-ins only), with these exports:

```ts
const DEFAULT_MAX_RESPONSE_BYTES: number; // 4 MiB
const MAX_ERROR_BODY_CHARS: number;       // 512
function redactKey(text: string, apiKey: string | undefined): string;
function readApiKeyFromEnv(env: Record<string, string | undefined>, variableName: string): string | undefined;
function checkEndpoint(endpoint: string, allowLoopbackHttp: boolean): { ok: true; url: URL } | { ok: false; reason: string };
function postChatCompletion(options: PostChatCompletionOptions): Promise<WireOutcome>; // never throws
function extractChatCompletion(bodyText: string): WireExtraction;                      // never throws
function mintRuntimeCallId(): string;
class ProviderCallIdMap { link(providerId, runtimeCallId): void; runtimeCallIdFor(providerId); providerIdFor(runtimeCallId); }
function replayAssistantMessage(assistantMessage: Record<string, unknown>): Record<string, unknown>;
function replayToolMessage(ids: ProviderCallIdMap, runtimeCallId: string, content: string): { role: 'tool'; tool_call_id: string; content: string };
```

Tested in `src/runtime/__tests__/live_chat_wire.test.ts` against a 127.0.0.1
fixture with no API key and no Docker:

- Post-send HTTP 500: `retryable=false`, exactly one request (the e21 failure).
- Missing, empty or whitespace key: fails closed, zero sockets by connection counter.
- Premature close mid-body (content-length and chunked) and slow trickle past
  the deadline: `transport_error`, not retryable. The deadline is a separate
  timer that destroys the request.
- Oversized body, any 3xx, 429 with Retry-After beyond the deadline (reported,
  not awaited), connection refused (retryable, nothing sent).
- A complete body that is malformed JSON is handed on as text and becomes a
  reject at extraction, not a transport error.
- Multi-action, invalid finish_reason, missing usage (reported as null).
- Two-turn replay: `tool_calls` and `reasoning_details` re-sent deep-equal,
  including a reasoning block that reuses the tool_call id; the tool message
  carries the provider id while the runtime call id is distinct and never sent.
- A sentinel key does not appear in any failure object, even when echoed by
  the fixture.

## What is NOT shipped (the capability stays incomplete)

- No `LiveModelAdapter` class implementing `ModelAdapter`. It needs the real
  interface, which was not read.
- No run through the real `AgentRuntime`, `ActionDecoder`, finalizer or
  `ToolRegistry`. Dispatch counts, the usage-halt versus three-reject
  co-occurrence rule, and the ContextManager pre-send gate are untested.
- No host CLI, so "non-zero CLI exit on missing key" is not demonstrated; only
  the library-level fail-closed path is.
- No `tsc --noEmit` gate over tests. Workflow files are out of scope for this
  contribution. Note that a default Vitest run does not fail on importing a
  missing named export until it is read, so that gate is still worth adding.
- `extractChatCompletion` is wire-field extraction, not a second action
  decoder. When the adapter is mounted, its output should feed the existing
  `ActionDecoder`, and any overlap should be removed in favour of the decoder.
- No live provider call was made. Fixtures establish orchestration, not
  provider compatibility.

The capability should not be described as implemented on the strength of this
change. The existing `docs/live-model-transport-status.md` was not edited
because its contents were not read.
