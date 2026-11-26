# cap_mcp_runtime_mount_70 - status: PARTIAL, transport mount BLOCKED

This capability is **not mounted**. What is on the branch is the dependency-free
policy core under `src/runtime/mcp/`, with unit tests. No MCP server is
contacted by any code in this change, and no acceptance test that needs a
real `AgentRuntime` plus an in-process SDK server is claimed.

## Why the mount itself is blocked

The spec requires the official `@modelcontextprotocol/sdk` `Client` and
`StreamableHTTPClientTransport`, pinned to an exact version in `package.json`,
and says to report the capability blocked rather than hand-roll a protocol
client. The contribution that produced this change was not permitted to edit
package manifests, so the SDK could not be added or pinned. No protocol client
was hand-rolled.

Also not done, and not verified:

- The "inspect main first" step. `ToolRegistry`, approval gate, hooks,
  `EvidenceValidator`, `Finalizer` and `AgentRuntime` signatures were not read,
  so nothing here is wired into them and none of them were modified.
- Whether the web-research mount exports a hardened fetch / address check is
  unknown. The address checks in `address_policy.ts` are implemented in this
  change; they are **not** a reuse of that mount.
- No baseline `npm ci` / vitest run was captured by the author before pushing.

## What is shipped (pure functions, unit-tested)

| File | Contents |
| --- | --- |
| `types.ts` | `McpMountConfig`, `McpServerPolicy`, `McpToolPolicy`, `McpArgumentAuthorizer`, `McpReconciler`, `McpCallOutput`, `MCP_REASON` codes, inclusive `MCP_CAPS`, rejected co-mount list, stub naming |
| `canonical_json.ts` | RFC 8785 canonical JSON, `interfaceDigest`, canonical argument bytes, `argsDigest` |
| `address_policy.ts` | Address classes (private, loopback, link-local, CGNAT, IPv4-mapped, multicast, unique-local, metadata, ...), `resolveAndPin` (resolve once, freeze; `pinnedAddresses` skip DNS; metadata always denied; `http://127.0.0.1` only via the explicit seam) |
| `config.ts` | Static startup validation: authorizer required, name pattern, caps, exact SDK version string, write+idempotent error, stub collisions, co-mount rejection; errors carry codes and field names only |
| `rendering.ts` | Untrusted label + 1024-byte cut for server descriptions, host description replacement, removal of `description`/`title`/`examples` schema keywords, schema byte cap |
| `settlement.ts` | Classifies a received HTTP response (JSON or `text/event-stream`) into success / known failure / unknown per the settlement rule; counts non-text blocks and server-initiated requests |

## Remaining delta for a follow-up (needs the SDK pin)

1. Pin `@modelcontextprotocol/sdk` exactly in `package.json`; confirm it runs
   under this repo's Node and TypeScript; check whether the transport opens a
   standalone GET stream and how reconnection is disabled in that version.
2. `McpService`: connect, assert the negotiated protocol revision, bounded
   `tools/list`, freeze stubs, `list_changed` drift flag.
3. Injected fetch choke point: `request_sent` marker keyed on the `tools/call`
   body, `redirect: 'manual'`, connection pinned to `PinnedDestination`
   addresses, static headers, byte-counting cap feeding `classifyMcpResponse`.
4. Registry stubs through the existing `ToolRegistry.call` order, the
   authorizer step, the unknown-write block ledger and reconciler handling.
5. Evidence shape 12, child-run exclusion, and the end-to-end acceptance tests.
