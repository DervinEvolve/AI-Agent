# Live-model integration: blocked pending source inspection

This change implements only a real Node HTTP(S) transport boundary. It does **not** activate cap_live_model_adapter_21, provide a replacement runtime loop, or claim completion of its acceptance gates.

Repository contents and a command runner were not available in this editing session. The listed runtime filenames are not enough to verify exports or decoder shapes. Consequently no imports of presumed runtime symbols, CLI mounting, capability availability changes, or invented final-answer protocol are included. Live runtime mounting remains blocked until source inspection establishes authorization, effective tools, usage accounting, decoder rejection representation and lifecycle integration.

## Exact new exports

From `src/runtime/live_model_transport.ts`:

- `LiveModelTransport(config: LiveTransportConfig)`; `send(payload: unknown): Promise<string>`; `close(): void`.
- `LiveTransportError(code: LiveTransportCode, status?: number)` with public `code` and optional allowlisted `status`.
- `LiveTransportConfig` and `LiveTransportClock` are exported interfaces; `LiveTransportCode` is an exported union.
- Clock signatures: `now(): number`, `schedule(callback: () => void, delayMs: number): unknown`, `cancel(handle: unknown): void`. Scheduling must be asynchronous, like setTimeout. The host supplies an absolute deadline in that clock's domain.
- Disclosure signature: `authorizeDisclosure(bytes: Uint8Array): boolean`. It receives a copy of the final serialized request. Local denied-byte checks are additive; shared runtime denied-byte integration is unavailable, and requiring it fails construction.

The transport uses no pooling, redirects or automatic retries. It counts and discards bounded error bodies; successful credential echoes fail closed without modifying executable arguments. This is literal/JSON-decoded echo protection, not a guarantee against arbitrary encoded exfiltration. The transport does not supply messages, tool schemas, usage parsing or decoder validation. Complete malformed response text is returned unchanged for future adapter mapping.

## Remaining integration gates

Inspect the actual merged runtime and record signatures before implementing ModelAdapter, native tool-call mapping, usage preservation, protocol instructions, default recall-only CLI and sanitized runtime reporting. The CLI must fail missing credentials before sockets and return zero only on runtime completion. Runtime cancellation must close this transport in finally. Verify the three-rejection outcome, citations, unknown usage under caps, tool observations, unresolved non-idempotent outcomes and availability reporting through the real runtime.

Added tests cover credential/configuration rejection, pre-socket controls, one-attempt status handling and separate success/error echo rejection on keyless literal-loopback fixtures. They do not substitute for runtime integration, sentinel-header coverage or deadline/slow-drip teardown acceptance tests. No local suite, CI, merge or live-provider run was performed or observed in this session.
