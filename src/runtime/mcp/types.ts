/**
 * cap_mcp_runtime_mount_70 - shared types, reason codes and inclusive caps.
 *
 * This file is the single source for reason codes and caps; tests read them
 * from here. It has no dependency on the MCP SDK or on any other runtime
 * module, so it can be imported by the transport mount when that lands.
 */

export const MCP_REASON = {
  // configuration / startup
  config_invalid: 'mcp_config_invalid',
  authorizer_missing: 'mcp_authorizer_missing',
  allowlist_empty: 'mcp_allowlist_empty',
  name_invalid: 'mcp_name_invalid',
  too_many_servers: 'mcp_too_many_servers',
  stub_collision: 'mcp_stub_collision',
  co_mount_rejected: 'mcp_co_mount_rejected',
  origin_invalid: 'mcp_origin_invalid',
  address_denied: 'mcp_address_denied',
  server_unreachable: 'mcp_server_unreachable',
  protocol_revision_mismatch: 'mcp_protocol_revision_mismatch',
  interface_digest_mismatch: 'mcp_interface_digest_mismatch',
  schema_too_large: 'mcp_schema_too_large',
  // dispatch
  authorization_denied: 'authorization_denied',
  not_sent: 'mcp_not_sent',
  interface_drift: 'mcp_interface_drift',
  server_write_blocked: 'mcp_server_write_blocked',
  reconciled_applied: 'mcp_reconciled_applied',
  // response classification
  redirect_refused: 'mcp_redirect_refused',
  result_too_large: 'mcp_result_too_large',
  response_truncated: 'mcp_response_truncated',
  response_unparseable: 'mcp_response_unparseable',
  response_id_mismatch: 'mcp_response_id_mismatch',
  http_status: 'mcp_http_status',
  tool_error: 'mcp_tool_error',
  jsonrpc_error: 'mcp_jsonrpc_error',
  timeout: 'mcp_timeout',
  aborted: 'mcp_aborted',
  support_shape_unavailable: 'support_shape_unavailable',
} as const;

export type McpReasonCode = (typeof MCP_REASON)[keyof typeof MCP_REASON];

/** All caps are inclusive: a value equal to the cap is accepted. */
export const MCP_CAPS = {
  maxServers: 4,
  maxListPages: 8,
  maxToolsPerServer: 64,
  maxSchemaBytes: 16 * 1024,
  maxDescriptionBytes: 1024,
  defaultCallTimeoutMs: 30_000,
  hardMaxCallTimeoutMs: 120_000,
  defaultMaxResultBytes: 256 * 1024,
  hardMaxResultBytes: 1024 * 1024,
  maxQuoteCodePoints: 2000,
} as const;

export const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Co-mounts that an enabled MCP mount refuses at startup. */
export const MCP_REJECTED_CO_MOUNTS = [
  'durable_run',
  'interactive_session',
  'composition',
  'workspace_trial',
  'alternatives',
  'async_workers',
  'tool_programs',
  'tool_discovery',
  'gui_control',
  'background_jobs',
] as const;

export type McpRejectedCoMount = (typeof MCP_REJECTED_CO_MOUNTS)[number];

export type McpEffect = 'read' | 'write';

/** Host-owned policy for one allowlisted tool. Server annotations never set these. */
export interface McpToolPolicy {
  effect: McpEffect;
  /** Only meaningful for effect=read. effect=write with idempotent=true is a configuration error. */
  idempotent?: boolean;
  /** Host description; when present it replaces the server description entirely. */
  description?: string;
  /** Lowercase hex sha256; mismatch fails startup, or excludes the tool when optional. */
  expected_interface_digest?: string;
  optional?: boolean;
}

export interface McpServerPolicy {
  id: string;
  /** Host-pinned origin, e.g. https://mcp.example.com . */
  origin: string;
  /** When set, connect only to these addresses and never consult DNS. */
  pinnedAddresses?: string[];
  /** Host-supplied static credentials. Never rendered to the model, events or errors. */
  headers: Record<string, string>;
  allowlist: Record<string, McpToolPolicy>;
  timeouts?: { call_timeout_ms?: number };
}

export interface McpAuthorizationRequest {
  server_id: string;
  tool: string;
  interface_digest: string;
  effect: McpEffect;
  /** Exact RFC 8785 canonical argument bytes that would be sent. */
  canonical_arguments: Uint8Array;
}

export type McpArgumentAuthorizer = (
  request: McpAuthorizationRequest,
) => Promise<{ allow: boolean }> | { allow: boolean };

export type McpReconcileVerdict = 'applied' | 'not_applied' | 'unknown';

export interface McpReconciler {
  reconcile(request: {
    server_id: string;
    tool: string;
    call_id: string;
    args_digest: string;
  }): Promise<McpReconcileVerdict>;
}

export interface McpElidedCounts {
  image: number;
  audio: number;
  resource_link: number;
  embedded_resource: number;
}

export interface McpCallOutput {
  ok: boolean;
  server_id: string;
  tool: string;
  interface_digest: string;
  is_error: boolean;
  text_blocks: string[];
  structured_content?: Record<string, unknown>;
  elided: McpElidedCounts;
}

export interface McpMountConfig {
  /** Opt-in. Disabled configuration mounts nothing. */
  enabled: boolean;
  servers: McpServerPolicy[];
  /** Exact @modelcontextprotocol/sdk version (no range) the host pinned. */
  sdk_version: string;
  /** The single protocol revision that must be negotiated. */
  protocol_revision: string;
  authorizer?: McpArgumentAuthorizer;
  reconciler?: McpReconciler;
  caps?: { maxResultBytes?: number };
  /** Explicit test seam: admits exactly http://127.0.0.1[:port]. Never set in production. */
  allowLoopbackTestSeam?: boolean;
}

export function disabledMcpMountConfig(): McpMountConfig {
  return { enabled: false, servers: [], sdk_version: '', protocol_revision: '' };
}

export function mcpStubName(serverId: string, tool: string): string {
  return `mcp_${serverId}_${tool}`;
}
