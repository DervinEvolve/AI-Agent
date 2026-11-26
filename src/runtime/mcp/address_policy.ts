import { isIPv4, isIPv6 } from 'node:net';
import { MCP_REASON, type McpReasonCode } from './types';

/**
 * Address classification and startup pinning for MCP destinations.
 *
 * NOTE: these checks are implemented here, in this module. They are NOT a
 * reuse of cap_web_research_mount_37's hardened fetch; that module was not
 * visible when this was written.
 */
export type McpAddressClass =
  | 'public'
  | 'private'
  | 'loopback'
  | 'link_local'
  | 'cgnat'
  | 'ipv4_mapped'
  | 'multicast'
  | 'unique_local'
  | 'metadata'
  | 'unspecified'
  | 'reserved'
  | 'invalid';

const METADATA_V4 = new Set(['169.254.169.254', '169.254.170.2', '100.100.100.200']);

function parseV4(s: string): number[] | null {
  if (!isIPv4(s)) return null;
  return s.split('.').map((p) => Number(p));
}

function parseV6(input: string): number[] | null {
  if (input.includes('%') || !isIPv6(input)) return null;
  let str = input;
  const lastColon = str.lastIndexOf(':');
  const tail = str.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseV4(tail);
    if (!v4) return null;
    str =
      str.slice(0, lastColon + 1) +
      ((v4[0] << 8) | v4[1]).toString(16) +
      ':' +
      ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length > 1 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...new Array<string>(fill).fill('0'), ...rest];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes;
}

function classifyV4(b: number[]): McpAddressClass {
  if (METADATA_V4.has(b.join('.'))) return 'metadata';
  const [a, c, d] = [b[0], b[1], b[2]];
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && c >= 16 && c <= 31) return 'private';
  if (a === 192 && c === 168) return 'private';
  if (a === 169 && c === 254) return 'link_local';
  if (a === 100 && c >= 64 && c <= 127) return 'cgnat';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  if (a === 192 && c === 0 && (d === 0 || d === 2)) return 'reserved';
  if (a === 198 && (c === 18 || c === 19)) return 'reserved';
  if (a === 198 && c === 51 && d === 100) return 'reserved';
  if (a === 203 && c === 0 && d === 113) return 'reserved';
  return 'public';
}

function classifyV6(b: number[]): McpAddressClass {
  const allZero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (allZero(0, 16)) return 'unspecified';
  if (allZero(0, 15) && b[15] === 1) return 'loopback';
  if (allZero(0, 10) && b[10] === 0xff && b[11] === 0xff) {
    return classifyV4(b.slice(12)) === 'metadata' ? 'metadata' : 'ipv4_mapped';
  }
  if (allZero(0, 12)) return 'reserved'; // deprecated IPv4-compatible
  if (b[0] === 0xff) return 'multicast';
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'link_local';
  if ((b[0] & 0xfe) === 0xfc) {
    // fd00:ec2::254 is the EC2 IPv6 metadata endpoint
    if (b[0] === 0xfd && b[1] === 0 && b[2] === 0x0e && b[3] === 0xc2 && allZero(4, 14) && b[14] === 0x02 && b[15] === 0x54) {
      return 'metadata';
    }
    return 'unique_local';
  }
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(4, 12)) return 'reserved'; // NAT64
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return 'reserved'; // documentation
  return 'public';
}

function stripBrackets(s: string): string {
  return s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
}

export function classifyAddress(address: string): McpAddressClass {
  if (typeof address !== 'string') return 'invalid';
  const s = stripBrackets(address.trim());
  const v4 = parseV4(s);
  if (v4) return classifyV4(v4);
  const v6 = parseV6(s);
  if (v6) return classifyV6(v6);
  return 'invalid';
}

export interface AddressCheckOptions {
  /** The address comes from host-supplied pinnedAddresses. */
  pinned?: boolean;
  /** Explicit test seam; admits exactly 127.0.0.1. */
  loopbackTestSeam?: boolean;
}

export function isAddressAllowed(address: string, opts: AddressCheckOptions = {}): boolean {
  const cls = classifyAddress(address);
  if (cls === 'public') return true;
  if (cls === 'metadata' || cls === 'invalid') return false;
  if (opts.pinned && (cls === 'private' || cls === 'unique_local')) return true;
  if (opts.loopbackTestSeam && stripBrackets(address.trim()) === '127.0.0.1') return true;
  return false;
}

export type McpResolver = (hostname: string) => Promise<string[]>;

export interface PinnedDestination {
  readonly protocol: 'https:' | 'http:';
  readonly hostname: string;
  readonly port: number;
  readonly origin: string;
  /** Every later connection uses only these; DNS is never consulted again. */
  readonly addresses: readonly string[];
  readonly source: 'pinned' | 'literal' | 'dns';
}

export type PinResult =
  | { ok: true; destination: PinnedDestination }
  | { ok: false; reason: McpReasonCode };

/**
 * Resolve a server origin exactly once and freeze the result. Failure values
 * carry a reason code only: never the origin, an address or a resolver error
 * string.
 */
export async function resolveAndPin(
  server: { origin: string; pinnedAddresses?: string[] },
  opts: { resolver: McpResolver; loopbackTestSeam?: boolean },
): Promise<PinResult> {
  const deny = (reason: McpReasonCode): PinResult => ({ ok: false, reason });
  let url: URL;
  try {
    url = new URL(server.origin);
  } catch {
    return deny(MCP_REASON.origin_invalid);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    return deny(MCP_REASON.origin_invalid);
  }
  const hostname = stripBrackets(url.hostname);
  const seam = opts.loopbackTestSeam === true;
  if (url.protocol === 'http:') {
    if (!(seam && hostname === '127.0.0.1')) return deny(MCP_REASON.origin_invalid);
  } else if (url.protocol !== 'https:') {
    return deny(MCP_REASON.origin_invalid);
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;

  let addresses: string[];
  let source: PinnedDestination['source'];
  const pinned = server.pinnedAddresses;
  if (pinned !== undefined) {
    if (!Array.isArray(pinned) || pinned.length === 0) return deny(MCP_REASON.config_invalid);
    addresses = pinned.map((a) => stripBrackets(String(a).trim()));
    source = 'pinned';
    for (const a of addresses) {
      if (!isAddressAllowed(a, { pinned: true, loopbackTestSeam: seam })) return deny(MCP_REASON.address_denied);
    }
  } else if (classifyAddress(hostname) !== 'invalid') {
    addresses = [hostname];
    source = 'literal';
    if (!isAddressAllowed(hostname, { loopbackTestSeam: seam })) return deny(MCP_REASON.address_denied);
  } else {
    let resolved: string[];
    try {
      resolved = await opts.resolver(hostname);
    } catch {
      return deny(MCP_REASON.server_unreachable);
    }
    if (!Array.isArray(resolved) || resolved.length === 0) return deny(MCP_REASON.server_unreachable);
    addresses = resolved.map((a) => stripBrackets(String(a).trim()));
    source = 'dns';
    // Any denied answer fails the whole resolution; we do not filter and continue.
    for (const a of addresses) {
      if (!isAddressAllowed(a, {})) return deny(MCP_REASON.address_denied);
    }
  }

  return {
    ok: true,
    destination: Object.freeze({
      protocol: url.protocol as 'https:' | 'http:',
      hostname,
      port,
      origin: url.origin,
      addresses: Object.freeze([...addresses]),
      source,
    }),
  };
}
