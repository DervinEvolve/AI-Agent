import type {
  BrowserPolicy,
  DnsResolver,
  NavigationPolicyDecision,
} from './types';

const METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  'fd00:ec2::254',
]);

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}

function isDeniedIpv4(octets: number[]): string | null {
  const [a, b] = octets;
  if (a === 0) return 'unspecified_ipv4';
  if (a === 10) return 'private_ipv4';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat_ipv4';
  if (a === 127) return 'loopback_ipv4';
  if (a === 169 && b === 254) return 'link_local_or_metadata_ipv4';
  if (a === 172 && b >= 16 && b <= 31) return 'private_ipv4';
  if (a === 192 && b === 168) return 'private_ipv4';
  if (a >= 224 && a <= 239) return 'multicast_ipv4';
  if (a >= 240) return 'reserved_ipv4';
  return null;
}

function normalizeIpv4MappedIpv6(ip: string): number[] | null {
  const lower = ip.toLowerCase();
  if (!lower.startsWith('::ffff:')) return null;
  const rest = lower.slice('::ffff:'.length);
  const dotted = parseIpv4(rest);
  if (dotted) return dotted;
  const hexParts = rest.split(':');
  if (hexParts.length !== 2) return null;
  const hi = Number.parseInt(hexParts[0], 16);
  const lo = Number.parseInt(hexParts[1], 16);
  if (Number.isNaN(hi) || Number.isNaN(lo) || hi < 0 || hi > 0xffff || lo < 0 || lo > 0xffff) {
    return null;
  }
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
}

function isDeniedIpv6(rawIp: string): string | null {
  const ip = rawIp.toLowerCase();
  if (ip === '::' || ip === '0:0:0:0:0:0:0:0') return 'unspecified_ipv6';
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return 'loopback_ipv6';
  if (ip === 'fd00:ec2::254') return 'metadata_ipv6';
  if (ip.startsWith('fe80:') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) {
    return 'link_local_ipv6';
  }
  if (ip.startsWith('fc') || ip.startsWith('fd')) return 'private_ipv6';
  if (ip.startsWith('ff')) return 'multicast_ipv6';
  return null;
}

export function classifyIpAddress(rawAddress: string): string | null {
  const trimmed = rawAddress.trim().replace(/^\[|\]$/g, '');
  const mapped = normalizeIpv4MappedIpv6(trimmed);
  if (mapped) {
    return isDeniedIpv4(mapped);
  }
  const ipv4 = parseIpv4(trimmed);
  if (ipv4) {
    return isDeniedIpv4(ipv4);
  }
  if (trimmed.includes(':')) {
    return isDeniedIpv6(trimmed);
  }
  return 'invalid_ip_address';
}

export async function evaluateNavigationPolicy(
  rawUrl: string,
  policy: BrowserPolicy,
  dnsResolver: DnsResolver,
  redirectCount = 0,
): Promise<NavigationPolicyDecision> {
  const maxRedirects = policy.maxRedirects ?? 2;
  if (redirectCount > maxRedirects) {
    return { allowed: false, reason: 'excess_redirects' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'invalid_url' };
  }

  if (parsed.protocol !== 'https:') {
    return { allowed: false, reason: 'forbidden_scheme' };
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return { allowed: false, reason: 'url_credentials_forbidden' };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || METADATA_HOSTS.has(hostname)) {
    return { allowed: false, reason: 'forbidden_host' };
  }

  const port = parsed.port === '' ? 443 : Number(parsed.port);
  const allowedPorts = policy.allowedPorts ?? [443];
  if (!Number.isInteger(port) || !allowedPorts.includes(port)) {
    return { allowed: false, reason: 'forbidden_port' };
  }

  const normalizedAllowlist = policy.allowedHosts.map((h) => h.toLowerCase());
  if (!normalizedAllowlist.includes(hostname)) {
    return { allowed: false, reason: 'host_not_allowlisted' };
  }

  const canonicalUrl = parsed.toString();

  if (policy.navigationAuthorizer) {
    const timeoutMs = policy.navigationAuthorizerTimeoutMs ?? 5000;
    try {
      const approved = await Promise.race<boolean>([
        Promise.resolve(policy.navigationAuthorizer(canonicalUrl)),
        new Promise<boolean>((_, reject) =>
          setTimeout(() => reject(new Error('authorizer_timeout')), timeoutMs),
        ),
      ]);
      if (!approved) {
        return { allowed: false, reason: 'navigation_authorizer_denied' };
      }
    } catch {
      return { allowed: false, reason: 'navigation_authorizer_error' };
    }
  }

  let addresses: readonly string[];
  try {
    addresses = await dnsResolver(hostname);
  } catch {
    return { allowed: false, reason: 'dns_resolution_failed' };
  }

  if (!addresses || addresses.length === 0) {
    return { allowed: false, reason: 'empty_dns_answer' };
  }

  for (const addr of addresses) {
    const denial = classifyIpAddress(addr);
    if (denial !== null) {
      return { allowed: false, reason: `denied_address:${denial}` };
    }
  }

  return {
    allowed: true,
    canonicalUrl,
    hostname,
    port,
    pinnedAddress: addresses[0],
  };
}
