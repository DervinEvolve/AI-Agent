import net from 'node:net';

export type SandboxEgressProfile = 'none' | 'allowlist';

export interface SandboxEgressHostRule {
  readonly host: string;
  readonly allowedPorts?: readonly number[];
  readonly allowedMethods?: readonly string[];
  readonly pathPrefixes?: readonly string[];
  readonly allowQuery?: boolean;
  readonly maxUrlBytes?: number;
  readonly allowConnect?: boolean;
}

export interface SandboxEgressAuthorizerRequest {
  readonly callId: string;
  readonly childCallId?: string;
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly method: string;
  readonly pinnedIp: string;
}

export type SandboxEgressAuthorizer = (
  req: SandboxEgressAuthorizerRequest,
) => boolean | Promise<boolean>;

export interface SandboxEgressPolicy {
  readonly profile: SandboxEgressProfile;
  readonly allowlist?: readonly SandboxEgressHostRule[];
  readonly requireAuthorizer?: boolean;
  readonly egressAuthorizer?: SandboxEgressAuthorizer;
  readonly allowChildEgress?: boolean;
  readonly maxRecords?: number;
}

export interface FrozenSandboxEgressPolicy {
  readonly profile: SandboxEgressProfile;
  readonly allowlist: readonly SandboxEgressHostRule[];
  readonly requireAuthorizer: boolean;
  readonly egressAuthorizer?: SandboxEgressAuthorizer;
  readonly allowChildEgress: boolean;
  readonly maxRecords: number;
  readonly frozen: true;
}

export interface SandboxEgressRequest {
  readonly callId: string;
  readonly childCallId?: string;
  readonly url: string;
  readonly method: string;
  readonly hasBody?: boolean;
  readonly bodyBytes?: number;
}

export interface SandboxEgressDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly host: string;
  readonly port: number;
  readonly method: string;
  readonly pinnedIp?: string;
}

export type DnsResolver = (hostname: string) => Promise<readonly string[]>;

export interface SandboxEgressConnectOptions {
  readonly ip: string;
  readonly port: number;
  readonly servername: string;
  readonly method: string;
  readonly url: string;
}

export interface SandboxEgressConnector {
  connect(options: SandboxEgressConnectOptions): Promise<{ statusCode: number; body?: string }>;
}

export interface SandboxEgressRecord {
  readonly call_id: string;
  readonly child_call_id?: string;
  readonly host: string;
  readonly port: number;
  readonly method: string;
  readonly decision: 'allow' | 'deny';
  readonly reason: string;
  readonly timestampMs: number;
}

export interface SandboxEgressLedgerSnapshot {
  readonly records: readonly SandboxEgressRecord[];
  readonly elidedCount: number;
  readonly nonCitable: true;
}

export interface IpClassification {
  readonly valid: boolean;
  readonly family: 4 | 6 | 0;
  readonly isPrivateOrReserved: boolean;
  readonly reason: string;
  readonly unwrappedIpv4?: string;
}

const DEFAULT_ALLOWED_PORTS: readonly number[] = Object.freeze([443]);
const DEFAULT_ALLOWED_METHODS: readonly string[] = Object.freeze(['GET', 'HEAD']);
const DEFAULT_MAX_URL_BYTES = 2048;
const DEFAULT_MAX_RECORDS = 256;

function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const num = Number(part);
    if (num < 0 || num > 255) return null;
    acc = ((acc << 8) | num) >>> 0;
  }
  return acc;
}

function inIpv4Cidr(ipNum: number, baseIp: string, prefixLen: number): boolean {
  const baseNum = ipv4ToUint32(baseIp);
  if (baseNum === null) return false;
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

function expandIpv6Groups(ip: string): number[] | null {
  const zoneIdx = ip.indexOf('%');
  const clean = zoneIdx >= 0 ? ip.slice(0, zoneIdx) : ip;
  const halves = clean.split('::');
  if (halves.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const parts = side.split(':');
    const out: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.includes('.')) {
        if (i !== parts.length - 1) return null;
        const v4 = ipv4ToUint32(part);
        if (v4 === null) return null;
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
        out.push(parseInt(part, 16));
      }
    }
    return out;
  };

  const left = parseSide(halves[0]);
  if (!left) return null;
  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }
  const right = parseSide(halves[1]);
  if (!right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function classifyIpv4(ip: string): IpClassification {
  const num = ipv4ToUint32(ip);
  if (num === null) {
    return { valid: false, family: 0, isPrivateOrReserved: true, reason: 'invalid_ipv4' };
  }
  if (inIpv4Cidr(num, '127.0.0.0', 8)) {
    return { valid: true, family: 4, isPrivateOrReserved: true, reason: 'loopback' };
  }
  if (
    inIpv4Cidr(num, '10.0.0.0', 8) ||
    inIpv4Cidr(num, '172.16.0.0', 12) ||
    inIpv4Cidr(num, '192.168.0.0', 16)
  ) {
    return { valid: true, family: 4, isPrivateOrReserved: true, reason: 'rfc1918' };
  }
  if (inIpv4Cidr(num, '169.254.0.0', 16)) {
    return { valid: true, family: 4, isPrivateOrReserved: true, reason: 'link_local_or_metadata' };
  }
  if (inIpv4Cidr(num, '100.64.0.0', 10)) {
    return { valid: true, family: 4, isPrivateOrReserved: true, reason: 'cgnat' };
  }
  if (inIpv4Cidr(num, '0.0.0.0', 8)) {
    return { valid: true, family: 4, isPrivateOrReserved: true, reason: 'unspecified' };
  }
  if (inIpv4Cidr(num, '224.0.0.0', 4)) {
    return { valid: true, family: 4, isPrivateOrReserved: true, reason: 'multicast' };
  }
  if (
    inIpv4Cidr(num, '192.0.0.0', 24) ||
    inIpv4Cidr(num, '198.18.0.0', 15) ||
    inIpv4Cidr(num, '240.0.0.0', 4)
  ) {
    return { valid: true, family: 4, isPrivateOrReserved: true, reason: 'reserved' };
  }
  return { valid: true, family: 4, isPrivateOrReserved: false, reason: 'public' };
}

export function classifyIpAddress(rawIp: string): IpClassification {
  const trimmed = rawIp.trim().replace(/^\[|\]$/g, '');
  const family = net.isIP(trimmed);
  if (family === 4) {
    return classifyIpv4(trimmed);
  }
  if (family === 6) {
    const groups = expandIpv6Groups(trimmed);
    if (!groups) {
      return { valid: false, family: 0, isPrivateOrReserved: true, reason: 'invalid_ipv6' };
    }
    // Unwrap ::ffff:0:0/96 IPv4-mapped IPv6
    if (
      groups[0] === 0 &&
      groups[1] === 0 &&
      groups[2] === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      groups[5] === 0xffff
    ) {
      const v4Str = `${(groups[6] >> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >> 8) & 0xff}.${groups[7] & 0xff}`;
      const v4Class = classifyIpv4(v4Str);
      return {
        valid: v4Class.valid,
        family: 6,
        isPrivateOrReserved: v4Class.isPrivateOrReserved,
        reason: v4Class.isPrivateOrReserved ? `ipv4_mapped_${v4Class.reason}` : 'public',
        unwrappedIpv4: v4Str,
      };
    }
    // ::/128 unspecified
    if (groups.every((g) => g === 0)) {
      return { valid: true, family: 6, isPrivateOrReserved: true, reason: 'unspecified' };
    }
    // ::1/128 loopback
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
      return { valid: true, family: 6, isPrivateOrReserved: true, reason: 'loopback' };
    }
    // fc00::/7 ULA (includes fd00::/8 and fd00:ec2::254 metadata)
    if ((groups[0] & 0xfe00) === 0xfc00) {
      return { valid: true, family: 6, isPrivateOrReserved: true, reason: 'ipv6_ula' };
    }
    // fe80::/10 link-local
    if ((groups[0] & 0xffc0) === 0xfe80) {
      return { valid: true, family: 6, isPrivateOrReserved: true, reason: 'ipv6_link_local' };
    }
    // ff00::/8 multicast
    if ((groups[0] & 0xff00) === 0xff00) {
      return { valid: true, family: 6, isPrivateOrReserved: true, reason: 'multicast' };
    }
    return { valid: true, family: 6, isPrivateOrReserved: false, reason: 'public' };
  }
  return { valid: false, family: 0, isPrivateOrReserved: true, reason: 'invalid_ip' };
}

export function freezeSandboxEgressPolicy(
  policy?: Partial<SandboxEgressPolicy>,
): FrozenSandboxEgressPolicy {
  const profile: SandboxEgressProfile = policy?.profile ?? 'none';
  if (profile !== 'none' && profile !== 'allowlist') {
    throw new Error(`Invalid sandbox egress profile: ${String(profile)}`);
  }

  const allowlist: SandboxEgressHostRule[] = (policy?.allowlist ?? []).map((rule) => {
    const host = rule.host.trim().toLowerCase();
    if (!host) {
      throw new Error('Allowlist rule host must be non-empty');
    }
    const allowedPorts = Object.freeze([...(rule.allowedPorts ?? DEFAULT_ALLOWED_PORTS)]);
    for (const port of allowedPorts) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port in allowlist rule for ${host}: ${port}`);
      }
    }
    const allowedMethods = Object.freeze(
      (rule.allowedMethods ?? DEFAULT_ALLOWED_METHODS).map((m) => m.trim().toUpperCase()),
    );
    const pathPrefixes = rule.pathPrefixes
      ? Object.freeze([...rule.pathPrefixes])
      : undefined;
    return Object.freeze({
      host,
      allowedPorts,
      allowedMethods,
      pathPrefixes,
      allowQuery: rule.allowQuery ?? false,
      maxUrlBytes: rule.maxUrlBytes ?? DEFAULT_MAX_URL_BYTES,
      allowConnect: rule.allowConnect ?? false,
    });
  });

  return Object.freeze({
    profile,
    allowlist: Object.freeze(allowlist),
    requireAuthorizer: policy?.requireAuthorizer ?? false,
    egressAuthorizer: policy?.egressAuthorizer,
    allowChildEgress: policy?.allowChildEgress ?? false,
    maxRecords: policy?.maxRecords ?? DEFAULT_MAX_RECORDS,
    frozen: true as const,
  });
}

export async function evaluateSandboxEgressRequest(
  policy: FrozenSandboxEgressPolicy,
  request: SandboxEgressRequest,
  deps: { resolveDns: DnsResolver },
): Promise<SandboxEgressDecision> {
  const method = request.method.trim().toUpperCase();
  if (policy.profile === 'none') {
    return { allowed: false, reason: 'profile_none', host: '', port: 0, method };
  }

  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    return { allowed: false, reason: 'invalid_url', host: '', port: 0, method };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === 'https:'
      ? 443
      : parsed.protocol === 'http:'
        ? 80
        : 0;

  if (!host || !port) {
    return { allowed: false, reason: 'invalid_host_or_port', host, port, method };
  }

  // Reject literal private/reserved IPs immediately
  if (net.isIP(host) !== 0) {
    const ipClass = classifyIpAddress(host);
    if (ipClass.isPrivateOrReserved) {
      return { allowed: false, reason: `denied_ip_${ipClass.reason}`, host, port, method };
    }
  }

  const rule = policy.allowlist.find((r) => r.host === host);
  if (!rule) {
    return { allowed: false, reason: 'host_not_allowlisted', host, port, method };
  }

  const maxUrlBytes = rule.maxUrlBytes ?? DEFAULT_MAX_URL_BYTES;
  if (Buffer.byteLength(request.url, 'utf8') > maxUrlBytes) {
    return { allowed: false, reason: 'url_too_long', host, port, method };
  }

  const allowedPorts = rule.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  if (!allowedPorts.includes(port)) {
    return { allowed: false, reason: 'port_not_allowed', host, port, method };
  }

  if (method === 'CONNECT') {
    if (!rule.allowConnect) {
      return { allowed: false, reason: 'connect_not_opted_in', host, port, method };
    }
  } else {
    const allowedMethods = rule.allowedMethods ?? DEFAULT_ALLOWED_METHODS;
    if (!allowedMethods.includes(method)) {
      return { allowed: false, reason: 'method_not_allowed', host, port, method };
    }
  }

  if (request.hasBody || (request.bodyBytes ?? 0) > 0) {
    return { allowed: false, reason: 'request_body_denied', host, port, method };
  }

  if (parsed.search.length > 0 && !rule.allowQuery) {
    return { allowed: false, reason: 'query_string_denied', host, port, method };
  }

  if (rule.pathPrefixes && rule.pathPrefixes.length > 0) {
    const matched = rule.pathPrefixes.some((prefix) => parsed.pathname.startsWith(prefix));
    if (!matched) {
      return { allowed: false, reason: 'path_prefix_denied', host, port, method };
    }
  }

  // DNS resolution once + validate all returned IPs
  let pinnedIp: string;
  if (net.isIP(host) !== 0) {
    pinnedIp = host;
  } else {
    const ips = await deps.resolveDns(host);
    if (!ips || ips.length === 0) {
      return { allowed: false, reason: 'dns_empty', host, port, method };
    }
    for (const ip of ips) {
      const ipClass = classifyIpAddress(ip);
      if (!ipClass.valid || ipClass.isPrivateOrReserved) {
        return {
          allowed: false,
          reason: `dns_denied_${ipClass.reason}`,
          host,
          port,
          method,
        };
      }
    }
    pinnedIp = ips[0];
  }

  if (policy.requireAuthorizer && !policy.egressAuthorizer) {
    return { allowed: false, reason: 'authorizer_missing', host, port, method };
  }

  if (policy.egressAuthorizer) {
    const ok = await policy.egressAuthorizer({
      callId: request.callId,
      childCallId: request.childCallId,
      url: request.url,
      host,
      port,
      method,
      pinnedIp,
    });
    if (!ok) {
      return { allowed: false, reason: 'authorizer_denied', host, port, method };
    }
  }

  return { allowed: true, reason: 'allowed', host, port, method, pinnedIp };
}

export class SandboxEgressRecorder {
  private readonly records: SandboxEgressRecord[] = [];
  private elidedCount = 0;
  private readonly maxRecords: number;

  constructor(maxRecords = DEFAULT_MAX_RECORDS) {
    this.maxRecords = maxRecords;
  }

  record(entry: SandboxEgressRecord): void {
    if (this.records.length >= this.maxRecords) {
      this.elidedCount += 1;
      return;
    }
    this.records.push(Object.freeze({ ...entry }));
  }

  snapshot(): SandboxEgressLedgerSnapshot {
    return Object.freeze({
      records: Object.freeze([...this.records]),
      elidedCount: this.elidedCount,
      nonCitable: true as const,
    });
  }
}

export function getSandboxDockerNetworkArgs(
  policy: FrozenSandboxEgressPolicy,
  proxyEndpoint?: string,
): string[] {
  if (policy.profile === 'none') {
    return ['--network=none'];
  }
  if (!proxyEndpoint) {
    throw new Error('Sandbox egress proxy endpoint is required under allowlist profile (fail closed)');
  }
  return ['--network=sandbox-egress-isolated', '-e', `HTTPS_PROXY=${proxyEndpoint}`];
}

export function getSandboxToolRegistrationOverrides(
  policy: FrozenSandboxEgressPolicy,
): { idempotent: false; concurrentSafe: false } | undefined {
  if (policy.profile === 'allowlist') {
    return { idempotent: false, concurrentSafe: false };
  }
  return undefined;
}

export function classifySandboxTimeoutOutcome(policy: FrozenSandboxEgressPolicy): {
  outcome: 'unknown' | 'timeout';
  autoRetry: boolean;
} {
  if (policy.profile === 'allowlist') {
    return { outcome: 'unknown', autoRetry: false };
  }
  return { outcome: 'timeout', autoRetry: false };
}

export function isChildEgressAllowed(policy: FrozenSandboxEgressPolicy): boolean {
  return policy.profile === 'allowlist' && policy.allowChildEgress === true;
}
