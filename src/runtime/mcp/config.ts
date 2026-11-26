import {
  MCP_CAPS,
  MCP_NAME_PATTERN,
  MCP_REASON,
  MCP_REJECTED_CO_MOUNTS,
  mcpStubName,
  type McpMountConfig,
  type McpReasonCode,
} from './types';

export interface McpConfigError {
  code: McpReasonCode;
  /** Index, not id: an invalid id is never echoed back. */
  server_index?: number;
  /** Which field was wrong. Never contains header names' values or credentials. */
  field?: string;
}

export type McpConfigValidation =
  | { ok: true; mounted: boolean; callTimeoutMs: number[]; maxResultBytes: number }
  | { ok: false; errors: McpConfigError[] };

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE_BAD = /[\r\n\0]/;
const DIGEST = /^[0-9a-f]{64}$/;

/**
 * Static (pre-network) validation of a host McpMountConfig. Everything here
 * must pass before any connection or inference; there is no partial mount.
 */
export function validateMcpMountConfig(
  config: McpMountConfig,
  activeCoMounts: readonly string[] = [],
): McpConfigValidation {
  if (!config || config.enabled !== true) {
    return { ok: true, mounted: false, callTimeoutMs: [], maxResultBytes: MCP_CAPS.defaultMaxResultBytes };
  }
  const errors: McpConfigError[] = [];
  const err = (code: McpReasonCode, field?: string, server_index?: number) => {
    const e: McpConfigError = { code };
    if (field !== undefined) e.field = field;
    if (server_index !== undefined) e.server_index = server_index;
    errors.push(e);
  };

  if (typeof config.authorizer !== 'function') err(MCP_REASON.authorizer_missing, 'authorizer');
  if (config.reconciler !== undefined && typeof config.reconciler?.reconcile !== 'function') {
    err(MCP_REASON.config_invalid, 'reconciler');
  }
  if (typeof config.sdk_version !== 'string' || !EXACT_VERSION.test(config.sdk_version)) {
    err(MCP_REASON.config_invalid, 'sdk_version');
  }
  if (typeof config.protocol_revision !== 'string' || config.protocol_revision.length === 0) {
    err(MCP_REASON.config_invalid, 'protocol_revision');
  }

  const rejected = new Set<string>(MCP_REJECTED_CO_MOUNTS);
  for (const m of activeCoMounts) {
    if (rejected.has(m)) err(MCP_REASON.co_mount_rejected, m);
  }

  let maxResultBytes: number = MCP_CAPS.defaultMaxResultBytes;
  const capOverride = config.caps?.maxResultBytes;
  if (capOverride !== undefined) {
    if (!Number.isInteger(capOverride) || capOverride < 1 || capOverride > MCP_CAPS.hardMaxResultBytes) {
      err(MCP_REASON.config_invalid, 'caps.maxResultBytes');
    } else {
      maxResultBytes = capOverride;
    }
  }

  const servers = Array.isArray(config.servers) ? config.servers : [];
  if (servers.length === 0) err(MCP_REASON.config_invalid, 'servers');
  if (servers.length > MCP_CAPS.maxServers) err(MCP_REASON.too_many_servers, 'servers');

  const seenIds = new Set<string>();
  const seenStubs = new Set<string>();
  const callTimeoutMs: number[] = [];

  servers.forEach((server, i) => {
    const idOk = typeof server?.id === 'string' && MCP_NAME_PATTERN.test(server.id);
    if (!idOk) err(MCP_REASON.name_invalid, 'id', i);
    else if (seenIds.has(server.id)) err(MCP_REASON.config_invalid, 'id', i);
    else seenIds.add(server.id);

    if (typeof server?.origin !== 'string' || server.origin.length === 0) err(MCP_REASON.origin_invalid, 'origin', i);

    const headers = server?.headers;
    if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
      err(MCP_REASON.config_invalid, 'headers', i);
    } else {
      for (const [name, value] of Object.entries(headers)) {
        if (!HEADER_NAME.test(name) || typeof value !== 'string' || HEADER_VALUE_BAD.test(value)) {
          err(MCP_REASON.config_invalid, 'headers', i);
          break;
        }
      }
    }

    const t = server?.timeouts?.call_timeout_ms;
    if (t === undefined) {
      callTimeoutMs.push(MCP_CAPS.defaultCallTimeoutMs);
    } else if (!Number.isInteger(t) || t < 1 || t > MCP_CAPS.hardMaxCallTimeoutMs) {
      err(MCP_REASON.config_invalid, 'timeouts.call_timeout_ms', i);
      callTimeoutMs.push(MCP_CAPS.defaultCallTimeoutMs);
    } else {
      callTimeoutMs.push(t);
    }

    const allow = server?.allowlist;
    if (allow === null || typeof allow !== 'object' || Array.isArray(allow)) {
      err(MCP_REASON.allowlist_empty, 'allowlist', i);
      return;
    }
    const names = Object.keys(allow);
    if (names.length === 0) err(MCP_REASON.allowlist_empty, 'allowlist', i);
    if (names.length > MCP_CAPS.maxToolsPerServer) err(MCP_REASON.config_invalid, 'allowlist', i);
    for (const name of names) {
      if (!MCP_NAME_PATTERN.test(name)) {
        err(MCP_REASON.name_invalid, 'allowlist', i);
        continue;
      }
      const p = allow[name];
      if (!p || (p.effect !== 'read' && p.effect !== 'write')) {
        err(MCP_REASON.config_invalid, 'allowlist.effect', i);
        continue;
      }
      if (p.effect === 'write' && p.idempotent === true) err(MCP_REASON.config_invalid, 'allowlist.idempotent', i);
      if (p.idempotent !== undefined && typeof p.idempotent !== 'boolean') err(MCP_REASON.config_invalid, 'allowlist.idempotent', i);
      if (p.description !== undefined && typeof p.description !== 'string') err(MCP_REASON.config_invalid, 'allowlist.description', i);
      if (p.expected_interface_digest !== undefined && !DIGEST.test(String(p.expected_interface_digest))) {
        err(MCP_REASON.config_invalid, 'allowlist.expected_interface_digest', i);
      }
      if (idOk) {
        const stub = mcpStubName(server.id, name);
        if (seenStubs.has(stub)) err(MCP_REASON.stub_collision, 'allowlist', i);
        seenStubs.add(stub);
      }
    }
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, mounted: true, callTimeoutMs, maxResultBytes };
}
