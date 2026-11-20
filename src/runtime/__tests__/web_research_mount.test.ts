import { describe, it, expect, vi } from 'vitest';
import * as zlib from 'node:zlib';
import {
  WebResearchRuntime,
  WebSnapshotStore,
  validateDelegationAllowedTools,
  validateShape5Citation,
  classifyWebToolOutcome,
  type StoredWebToolResult,
} from '../web_research_mount.js';
import {
  SafeWebTransport,
  createProductionWebTransport,
  isPublicIpAddress,
  extractTextFromHtml,
} from '../web_research_transport.js';
import { BraveWebSearchAdapter } from '../brave_web_search_adapter.js';

describe('cap_web_research_mount_37', () => {
  it('rejects web tools in delegation.allowedTools', () => {
    expect(() => validateDelegationAllowedTools(['search_web'])).toThrow(/Configuration error/);
    expect(() => validateDelegationAllowedTools(['fetch_web'])).toThrow(/Configuration error/);
    expect(() => validateDelegationAllowedTools(['read_web'])).toThrow(/Configuration error/);
    expect(() => validateDelegationAllowedTools(['read_file'])).not.toThrow();
  });

  it('rejects unknown top-level keys on search_web, fetch_web, and read_web', async () => {
    const runtime = new WebResearchRuntime({
      enabled: true,
      searchAdapter: { search: vi.fn(async () => []) },
      authorizer: { authorizeSearch: () => true, authorizeFetch: () => true },
    });
    const s = await runtime.searchWeb({ query: 'hello', extra: 1 });
    expect(s.ok).toBe(false);
    expect(s.started).toBe(false);

    const f = await runtime.fetchWeb({ url: 'https://example.com', extra: 1 });
    expect(f.ok).toBe(false);
    expect(f.started).toBe(false);

    const r = runtime.readWeb({ snapshot_id: 'snap_1', extra: 1 });
    expect(r.ok).toBe(false);
    expect(r.started).toBe(false);
  });

  it('fails closed on missing, throwing, or denying authorizer and caches deniedDigests', async () => {
    const searchSpy = vi.fn(async () => []);
    const authSpy = vi.fn(() => false);
    const runtime = new WebResearchRuntime({
      enabled: true,
      searchAdapter: { search: searchSpy },
      authorizer: { authorizeSearch: authSpy, authorizeFetch: () => { throw new Error('boom'); } },
    });

    const r1 = await runtime.searchWeb({ query: 'secret query' });
    expect(r1.code).toBe('authorization_denied');
    const r2 = await runtime.searchWeb({ query: 'secret query' });
    expect(r2.code).toBe('authorization_denied');
    expect(authSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).not.toHaveBeenCalled();

    const f1 = await runtime.fetchWeb({ url: 'https://example.com/a' });
    expect(f1.code).toBe('authorization_denied');
  });

  it('blocks non-public IPs, http:, credentials, and mixed DNS in production transport', async () => {
    const blockedIps = [
      '0.0.0.0',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '198.18.0.1',
      '::1',
      '::ffff:127.0.0.1',
      '64:ff9b::a9fe:a9fe',
      'fe80::1',
      'fc00::1',
    ];
    for (const ip of blockedIps) {
      expect(isPublicIpAddress(ip)).toBe(false);
    }
    expect(isPublicIpAddress('93.184.216.34')).toBe(true);

    const prod = createProductionWebTransport();
    const httpRes = await prod.fetch({ url: 'http://example.com', timeoutMs: 1000, maxPageBytes: 1024 });
    expect(httpRes.ok).toBe(false);
    expect(httpRes.code).toBe('invalid_url');

    const credRes = await prod.fetch({ url: 'https://user:pass@example.com', timeoutMs: 1000, maxPageBytes: 1024 });
    expect(credRes.ok).toBe(false);
    expect(credRes.code).toBe('invalid_url');

    const loopRes = await prod.fetch({ url: 'https://127.0.0.1/test', timeoutMs: 1000, maxPageBytes: 1024 });
    expect(loopRes.ok).toBe(false);
    expect(loopRes.code).toBe('ssrf_blocked');

    const mixedTransport = new SafeWebTransport({
      lookup: (_host, _opts, cb) => {
        cb(null, [
          { address: '93.184.216.34', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ]);
      },
    });
    const mixedRes = await mixedTransport.fetch({ url: 'https://example.com', timeoutMs: 1000, maxPageBytes: 1024 });
    expect(mixedRes.ok).toBe(false);
    expect(mixedRes.code).toBe('ssrf_blocked');
  });

  it('strips script/style/noscript/template/comments deterministically', () => {
    const html = '<html><head><style>body{}</style><script>alert(1)</script></head><body><!-- secret --><noscript>no</noscript><template>tpl</template><p>Hello &amp; 👋</p></body></html>';
    expect(extractTextFromHtml(html)).toBe('Hello & 👋');
  });

  it('enforces WebSnapshotStore limits and code-point-accurate shape-5 citations', () => {
    const store = new WebSnapshotStore();
    const stored = store.put('https://example.com', 'A👋B');
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.snapshot.total_code_points).toBe(3);

    const results = new Map<string, StoredWebToolResult>();
    results.set('c1', {
      call_id: 'c1',
      run_id: 'run_1',
      tool: 'fetch_web',
      outer_status: 'ok',
      output: { ok: true, snapshot_id: stored.snapshot.snapshot_id, char_start: 0, char_end: 3, termination_confirmed: true },
    });

    expect(validateShape5Citation({ call_id: 'c1', snapshot_id: stored.snapshot.snapshot_id, char_start: 1, char_end: 2 }, 'run_1', results, store).valid).toBe(true);
    expect(validateShape5Citation({ call_id: 'c1', snapshot_id: 'forged', char_start: 0, char_end: 1 }, 'run_1', results, store).valid).toBe(false);
    expect(validateShape5Citation({ call_id: 'c1', snapshot_id: stored.snapshot.snapshot_id, char_start: 0, char_end: 4 }, 'run_1', results, store).valid).toBe(false);
    expect(validateShape5Citation({ call_id: 'c1', snapshot_id: stored.snapshot.snapshot_id, char_start: 0, char_end: 2001 }, 'run_1', results, store).valid).toBe(false);
    expect(validateShape5Citation({ call_id: 'c1', snapshot_id: stored.snapshot.snapshot_id, char_start: 0, char_end: 1 }, 'run_2', results, store).valid).toBe(false);

    expect(classifyWebToolOutcome('fetch_web', 'ok', { ok: true, termination_confirmed: true })).toBe('success');
    expect(classifyWebToolOutcome('fetch_web', 'ok', { ok: true, termination_confirmed: false })).toBe('unknown');
    expect(classifyWebToolOutcome('fetch_web', 'timeout', { ok: true, termination_confirmed: true })).toBe('unknown');
  });

  it('BraveWebSearchAdapter sends X-Subscription-Token, normalizes results, and redacts token on error', async () => {
    const fakeTransport = {
      fetch: vi.fn(async (opts: { headers?: Record<string, string> }) => {
        expect(opts.headers?.['X-Subscription-Token']).toBe('secret-token-123');
        return {
          ok: true,
          statusCode: 200,
          bodyText: JSON.stringify({
            web: { results: [{ title: 'T1', url: 'https://a.test', description: 'D1' }] },
          }),
          termination_confirmed: true,
          wireBytes: 10,
          decompressedBytes: 10,
        };
      }),
    } as unknown as SafeWebTransport;

    const adapter = new BraveWebSearchAdapter({ apiKey: 'secret-token-123', transport: fakeTransport });
    const res = await adapter.search('test query', 3, new AbortController().signal);
    expect(res).toEqual([{ title: 'T1', url: 'https://a.test', snippet: 'D1' }]);

    const errTransport = {
      fetch: vi.fn(async () => {
        throw new Error('Failed with secret-token-123');
      }),
    } as unknown as SafeWebTransport;
    const errAdapter = new BraveWebSearchAdapter({ apiKey: 'secret-token-123', transport: errTransport });
    await expect(errAdapter.search('q', 1, new AbortController().signal)).rejects.toThrow(/\[REDACTED\]/);
  });
});
