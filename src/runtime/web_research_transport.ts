import * as dns from 'node:dns';
import * as https from 'node:https';
import * as net from 'node:net';
import * as zlib from 'node:zlib';

export interface WebTransportRequestOptions {
  url: string;
  timeoutMs: number;
  maxPageBytes: number;
  userAgent?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  acceptContentTypes?: string[];
}

export interface WebTransportResponse {
  ok: boolean;
  statusCode?: number;
  code?: string;
  error?: string;
  redirect_url?: string;
  contentType?: string;
  charset?: string;
  bodyText?: string;
  bodyBytes?: Buffer;
  termination_confirmed: boolean;
  wireBytes: number;
  decompressedBytes: number;
}

export type CustomLookupFn = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void
) => void;

export interface WebTransportSeam {
  lookup?: CustomLookupFn;
  ca?: string | Buffer | Array<string | Buffer>;
  allowLoopbackForTest?: boolean;
}

const DEFAULT_ACCEPT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

function buildNonGlobalBlockList(): net.BlockList {
  const bl = new net.BlockList();
  // IPv4 non-global-unicast ranges
  bl.addSubnet('0.0.0.0', 8, 'ipv4');
  bl.addSubnet('10.0.0.0', 8, 'ipv4');
  bl.addSubnet('100.64.0.0', 10, 'ipv4');
  bl.addSubnet('127.0.0.0', 8, 'ipv4');
  bl.addSubnet('169.254.0.0', 16, 'ipv4');
  bl.addSubnet('172.16.0.0', 12, 'ipv4');
  bl.addSubnet('192.0.0.0', 24, 'ipv4');
  bl.addSubnet('192.0.2.0', 24, 'ipv4');
  bl.addSubnet('192.168.0.0', 16, 'ipv4');
  bl.addSubnet('198.18.0.0', 15, 'ipv4');
  bl.addSubnet('198.51.100.0', 24, 'ipv4');
  bl.addSubnet('203.0.113.0', 24, 'ipv4');
  bl.addSubnet('224.0.0.0', 4, 'ipv4');
  bl.addSubnet('240.0.0.0', 4, 'ipv4');

  // IPv6 non-global-unicast ranges
  bl.addAddress('::', 'ipv6');
  bl.addAddress('::1', 'ipv6');
  bl.addSubnet('::ffff:0:0', 96, 'ipv6');
  bl.addSubnet('64:ff9b::', 96, 'ipv6');
  bl.addSubnet('100::', 64, 'ipv6');
  bl.addSubnet('2001::', 32, 'ipv6');
  bl.addSubnet('2001:db8::', 32, 'ipv6');
  bl.addSubnet('fc00::', 7, 'ipv6');
  bl.addSubnet('fe80::', 10, 'ipv6');
  bl.addSubnet('ff00::', 8, 'ipv6');
  return bl;
}

const NON_GLOBAL_BLOCKLIST = buildNonGlobalBlockList();

function unwrapEmbeddedIpv4(ipv6: string): string | null {
  const lower = ipv6.toLowerCase();
  const v4MappedDotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4MappedDotted) return v4MappedDotted[1];

  const v4MappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4MappedHex) {
    const hi = parseInt(v4MappedHex[1], 16);
    const lo = parseInt(v4MappedHex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  const nat64Dotted = lower.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/);
  if (nat64Dotted) return nat64Dotted[1];

  const nat64Hex = lower.match(/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (nat64Hex) {
    const hi = parseInt(nat64Hex[1], 16);
    const lo = parseInt(nat64Hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  return null;
}

export function isPublicIpAddress(rawIp: string): boolean {
  const zoneIdx = rawIp.indexOf('%');
  const ip = zoneIdx >= 0 ? rawIp.slice(0, zoneIdx) : rawIp;
  const family = net.isIP(ip);
  if (family === 4) {
    return !NON_GLOBAL_BLOCKLIST.check(ip, 'ipv4');
  }
  if (family === 6) {
    if (NON_GLOBAL_BLOCKLIST.check(ip, 'ipv6')) {
      return false;
    }
    const embedded = unwrapEmbeddedIpv4(ip);
    if (embedded && net.isIP(embedded) === 4) {
      return !NON_GLOBAL_BLOCKLIST.check(embedded, 'ipv4');
    }
    return true;
  }
  return false;
}

export function canonicalizeHttpsUrl(rawUrl: string): { ok: true; url: URL; canonical: string } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: `Disallowed URL scheme: ${parsed.protocol}` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'URLs with embedded credentials are not allowed' };
  }
  if (!parsed.hostname) {
    return { ok: false, error: 'URL missing hostname' };
  }
  return { ok: true, url: parsed, canonical: parsed.toString() };
}

export function extractTextFromHtml(html: string): string {
  let out = '';
  let i = 0;
  const len = html.length;
  let skipTag: string | null = null;

  const decodeEntity = (entity: string): string => {
    switch (entity) {
      case '&amp;': return '&';
      case '&lt;': return '<';
      case '&gt;': return '>';
      case '&quot;': return '"';
      case '&#39;':
      case '&apos;': return "'";
      case '&nbsp;': return ' ';
      default: return entity;
    }
  };

  while (i < len) {
    if (skipTag) {
      if (html[i] === '<' && html[i + 1] === '/') {
        const closeEnd = html.indexOf('>', i + 2);
        if (closeEnd !== -1) {
          const tagName = html.slice(i + 2, closeEnd).trim().toLowerCase();
          if (tagName === skipTag) {
            skipTag = null;
            i = closeEnd + 1;
            continue;
          }
        }
      }
      i++;
      continue;
    }

    if (html[i] === '<') {
      if (html.startsWith('<!--', i)) {
        const commentEnd = html.indexOf('-->', i + 4);
        i = commentEnd === -1 ? len : commentEnd + 3;
        continue;
      }
      const tagEnd = html.indexOf('>', i + 1);
      if (tagEnd === -1) {
        break;
      }
      const rawTag = html.slice(i + 1, tagEnd).trim();
      const tagNameMatch = rawTag.match(/^([a-zA-Z0-9:-]+)/);
      if (tagNameMatch) {
        const tagName = tagNameMatch[1].toLowerCase();
        const selfClosing = rawTag.endsWith('/');
        if (!selfClosing && (tagName === 'script' || tagName === 'style' || tagName === 'noscript' || tagName === 'template')) {
          skipTag = tagName;
        } else if (tagName === 'br' || tagName === 'p' || tagName === 'div' || tagName === 'li' || tagName === 'tr' || /^h[1-6]$/.test(tagName)) {
          out += ' ';
        }
      }
      i = tagEnd + 1;
      continue;
    }

    if (html[i] === '&') {
      const semi = html.indexOf(';', i + 1);
      if (semi !== -1 && semi - i <= 10) {
        out += decodeEntity(html.slice(i, semi + 1));
        i = semi + 1;
        continue;
      }
    }

    out += html[i];
    i++;
  }

  return out.replace(/\s+/g, ' ').trim();
}

function parseContentType(header: string | undefined): { mime: string; charset: BufferEncoding } {
  if (!header) return { mime: 'text/plain', charset: 'utf-8' };
  const parts = header.split(';').map((p) => p.trim());
  const mime = (parts[0] || 'text/plain').toLowerCase();
  let charset: BufferEncoding = 'utf-8';
  for (const part of parts.slice(1)) {
    const m = part.match(/^charset\s*=\s*"?([^"]+)"?$/i);
    if (m) {
      const cs = m[1].trim().toLowerCase();
      if (cs === 'utf-8' || cs === 'utf8') charset = 'utf-8';
      else if (cs === 'latin1' || cs === 'iso-8859-1') charset = 'latin1';
      else if (cs === 'ascii' || cs === 'us-ascii') charset = 'ascii';
    }
  }
  return { mime, charset };
}

export class SafeWebTransport {
  private readonly seam: WebTransportSeam;

  constructor(seam: WebTransportSeam = {}) {
    this.seam = seam;
  }

  private isAllowedIp(ip: string): boolean {
    if (this.seam.allowLoopbackForTest && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) {
      return true;
    }
    return isPublicIpAddress(ip);
  }

  async fetch(options: WebTransportRequestOptions): Promise<WebTransportResponse> {
    const canon = canonicalizeHttpsUrl(options.url);
    if (!canon.ok) {
      return {
        ok: false,
        code: 'invalid_url',
        error: canon.error,
        termination_confirmed: false,
        wireBytes: 0,
        decompressedBytes: 0,
      };
    }

    const url = canon.url;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(hostname) !== 0 && !this.isAllowedIp(hostname)) {
      return {
        ok: false,
        code: 'ssrf_blocked',
        error: `Blocked non-public IP literal: ${hostname}`,
        termination_confirmed: false,
        wireBytes: 0,
        decompressedBytes: 0,
      };
    }

    const acceptTypes = options.acceptContentTypes ?? DEFAULT_ACCEPT_TYPES;
    const maxPageBytes = options.maxPageBytes;
    const timeoutMs = Math.max(1, options.timeoutMs);

    return new Promise<WebTransportResponse>((resolve) => {
      let settled = false;
      let wireBytes = 0;
      let decompressedBytes = 0;
      let terminationConfirmed = false;
      let req: ReturnType<typeof https.request> | null = null;
      let activeStream: NodeJS.ReadableStream | null = null;

      const finish = (resp: WebTransportResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (options.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
        resolve(resp);
      };

      const abortAll = (code: string, error: string) => {
        if (activeStream && 'destroy' in activeStream && typeof (activeStream as { destroy: () => void }).destroy === 'function') {
          (activeStream as { destroy: () => void }).destroy();
        }
        if (req) {
          req.destroy();
        }
        finish({
          ok: false,
          code,
          error,
          termination_confirmed: false,
          wireBytes,
          decompressedBytes,
        });
      };

      const onAbort = () => abortAll('aborted', 'Request aborted by caller');
      if (options.signal) {
        if (options.signal.aborted) {
          abortAll('aborted', 'Request aborted before start');
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      const timer = setTimeout(() => {
        abortAll('timeout', `Request exceeded ${timeoutMs}ms budget`);
      }, timeoutMs);

      const customLookup: CustomLookupFn = (host, opts, cb) => {
        const baseLookup = this.seam.lookup ?? ((h, o, c) => dns.lookup(h, o, c));
        baseLookup(host, { ...opts, all: true }, (err, addresses) => {
          if (err) {
            cb(err, []);
            return;
          }
          if (!addresses || addresses.length === 0) {
            cb(new Error('DNS lookup returned no addresses') as NodeJS.ErrnoException, []);
            return;
          }
          for (const addr of addresses) {
            if (!this.isAllowedIp(addr.address)) {
              cb(new Error(`Blocked non-public DNS address: ${addr.address}`) as NodeJS.ErrnoException, []);
              return;
            }
          }
          cb(null, addresses);
        });
      };

      const headers: Record<string, string> = {
        'Accept-Encoding': 'gzip, identity',
        'User-Agent': options.userAgent ?? 'AI-Agent-WebResearch/1.0',
        ...(options.headers ?? {}),
      };

      req = https.request(
        url,
        {
          method: 'GET',
          agent: false,
          rejectUnauthorized: true,
          ca: this.seam.ca,
          lookup: customLookup as unknown as typeof dns.lookup,
          headers,
        },
        (res) => {
          const statusCode = res.statusCode ?? 0;

          if (statusCode >= 300 && statusCode < 400) {
            const loc = res.headers.location;
            res.resume();
            res.on('end', () => {
              terminationConfirmed = Boolean(res.complete);
              if (!loc) {
                finish({
                  ok: false,
                  statusCode,
                  code: 'redirect',
                  error: 'Redirect without Location header',
                  termination_confirmed: terminationConfirmed,
                  wireBytes,
                  decompressedBytes,
                });
                return;
              }
              let resolvedLoc: string;
              try {
                resolvedLoc = new URL(loc, url).toString();
              } catch {
                finish({
                  ok: false,
                  statusCode,
                  code: 'redirect',
                  error: 'Invalid redirect Location',
                  termination_confirmed: terminationConfirmed,
                  wireBytes,
                  decompressedBytes,
                });
                return;
              }
              const locCanon = canonicalizeHttpsUrl(resolvedLoc);
              finish({
                ok: false,
                statusCode,
                code: 'redirect',
                redirect_url: locCanon.ok ? locCanon.canonical : undefined,
                error: locCanon.ok ? undefined : locCanon.error,
                termination_confirmed: terminationConfirmed,
                wireBytes,
                decompressedBytes,
              });
            });
            return;
          }

          const { mime, charset } = parseContentType(res.headers['content-type']);
          if (statusCode >= 200 && statusCode < 300 && !acceptTypes.includes(mime)) {
            res.destroy();
            finish({
              ok: false,
              statusCode,
              code: 'unsupported_content_type',
              error: `Unsupported Content-Type: ${mime}`,
              termination_confirmed: false,
              wireBytes,
              decompressedBytes,
            });
            return;
          }

          const encoding = (res.headers['content-encoding'] ?? 'identity').toLowerCase();
          const chunks: Buffer[] = [];

          res.on('data', (chunk: Buffer) => {
            wireBytes += chunk.length;
            if (wireBytes > maxPageBytes) {
              abortAll('max_bytes_exceeded', `Wire bytes exceeded ${maxPageBytes}`);
            }
          });

          if (encoding === 'gzip') {
            const gunzip = zlib.createGunzip({ maxOutputLength: maxPageBytes });
            activeStream = gunzip;
            res.pipe(gunzip);
            gunzip.on('data', (chunk: Buffer) => {
              decompressedBytes += chunk.length;
              if (decompressedBytes > maxPageBytes) {
                abortAll('max_bytes_exceeded', `Decompressed bytes exceeded ${maxPageBytes}`);
                return;
              }
              chunks.push(chunk);
            });
            gunzip.on('error', (err) => {
              abortAll('decompression_error', err.message);
            });
            gunzip.on('end', () => {
              terminationConfirmed = Boolean(res.complete);
              const bodyBytes = Buffer.concat(chunks);
              const rawText = bodyBytes.toString(charset);
              const bodyText = mime === 'text/html' || mime === 'application/xhtml+xml' ? extractTextFromHtml(rawText) : rawText;
              finish({
                ok: statusCode >= 200 && statusCode < 300,
                statusCode,
                contentType: mime,
                charset,
                bodyBytes,
                bodyText,
                termination_confirmed: terminationConfirmed,
                wireBytes,
                decompressedBytes,
              });
            });
          } else {
            activeStream = res;
            res.on('data', (chunk: Buffer) => {
              decompressedBytes += chunk.length;
              if (decompressedBytes > maxPageBytes) {
                abortAll('max_bytes_exceeded', `Body bytes exceeded ${maxPageBytes}`);
                return;
              }
              chunks.push(chunk);
            });
            res.on('end', () => {
              terminationConfirmed = Boolean(res.complete);
              const bodyBytes = Buffer.concat(chunks);
              const rawText = bodyBytes.toString(charset);
              const bodyText = mime === 'text/html' || mime === 'application/xhtml+xml' ? extractTextFromHtml(rawText) : rawText;
              finish({
                ok: statusCode >= 200 && statusCode < 300,
                statusCode,
                contentType: mime,
                charset,
                bodyBytes,
                bodyText,
                termination_confirmed: terminationConfirmed,
                wireBytes,
                decompressedBytes,
              });
            });
          }

          res.on('error', (err) => {
            abortAll('response_error', err.message);
          });
        }
      );

      req.on('socket', (socket) => {
        socket.on('connect', () => {
          const remote = socket.remoteAddress;
          if (!remote || !this.isAllowedIp(remote)) {
            abortAll('ssrf_blocked', `Blocked non-public socket remoteAddress: ${remote ?? 'unknown'}`);
          }
        });
      });

      req.on('error', (err) => {
        const code = err.message.includes('Blocked non-public') ? 'ssrf_blocked' : 'network_error';
        abortAll(code, err.message);
      });

      req.end();
    });
  }
}

export function createProductionWebTransport(): SafeWebTransport {
  return new SafeWebTransport({});
}

export function createTestWebTransport(seam: WebTransportSeam): SafeWebTransport {
  return new SafeWebTransport(seam);
}
