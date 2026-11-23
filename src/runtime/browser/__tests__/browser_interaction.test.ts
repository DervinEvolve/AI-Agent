import { describe, it, expect } from 'vitest';
import {
  evaluateNavigationPolicy,
  resolveSnapshotRef,
  type BrowserPolicy,
  type PagePort,
  type SnapshotRef,
} from '../types';
import { BrowserSession } from '../session';

function makeFakePagePort(overrides?: Partial<PagePort>): PagePort {
  let docId = 'doc_1';
  let domGen = 1;
  let url = 'https://example.com/';
  return {
    capabilities: {
      requestInterception: true,
      pinnedConnections: true,
      guardedTargets: true,
      lifecycleReporting: true,
    },
    async getIdentity() {
      return { documentId: docId, domGeneration: domGen, url };
    },
    async navigate(nextUrl) {
      docId = 'doc_2';
      domGen = 1;
      url = nextUrl;
      return { ok: true, terminationConfirmed: true, documentId: docId, domGeneration: domGen, status: 200 };
    },
    async snapshot() {
      return {
        ok: true,
        terminationConfirmed: true,
        documentId: docId,
        domGeneration: domGen,
        url,
        textExcerpt: 'Example page',
        elements: [
          { targetId: 'el_btn_1', role: 'button', name: 'Submit', tag: 'button' },
          { targetId: 'el_pwd_1', role: 'textbox', name: 'Password', tag: 'input', inputType: 'password' },
          { targetId: 'el_file_1', role: 'textbox', name: 'Upload', tag: 'input', inputType: 'file' },
        ],
      };
    },
    async actGuarded(req) {
      if (req.ref.document_id !== docId || req.ref.dom_generation !== domGen) {
        return { ok: false, terminationConfirmed: true, errorCode: 'stale_target' };
      }
      domGen += 1;
      return { ok: true, terminationConfirmed: true, documentId: docId, domGeneration: domGen };
    },
    async awaitSettlement() {
      return true;
    },
    async dispose() {
      return true;
    },
    ...overrides,
  };
}

describe('cap_browser_interaction_13 policy & ref binding', () => {
  const basePolicy: BrowserPolicy = {
    allowedHosts: ['example.com'],
  };

  it('rejects forbidden schemes, credentials, ports, hosts, and excess redirects', async () => {
    const dns = async () => ['93.184.216.34'];
    expect((await evaluateNavigationPolicy('http://example.com/', basePolicy, dns)).reason).toBe('forbidden_scheme');
    expect((await evaluateNavigationPolicy('https://user:pass@example.com/', basePolicy, dns)).reason).toBe('url_credentials_forbidden');
    expect((await evaluateNavigationPolicy('https://example.com:8443/', basePolicy, dns)).reason).toBe('forbidden_port');
    expect((await evaluateNavigationPolicy('https://evil.com/', basePolicy, dns)).reason).toBe('host_not_allowlisted');
    expect((await evaluateNavigationPolicy('https://example.com/', basePolicy, dns, 3)).reason).toBe('excess_redirects');
  });

  it('normalizes IPv4-mapped IPv6 and rejects private/loopback/metadata/mixed DNS answers', async () => {
    const resLoopback = await evaluateNavigationPolicy('https://example.com/', basePolicy, async () => ['::ffff:127.0.0.1']);
    expect(resLoopback.allowed).toBe(false);
    expect(resLoopback.reason).toContain('loopback_ipv4');

    const resMixed = await evaluateNavigationPolicy('https://example.com/', basePolicy, async () => ['93.184.216.34', '169.254.169.254']);
    expect(resMixed.allowed).toBe(false);
    expect(resMixed.reason).toContain('link_local_or_metadata_ipv4');

    const resEmpty = await evaluateNavigationPolicy('https://example.com/', basePolicy, async () => []);
    expect(resEmpty.allowed).toBe(false);
    expect(resEmpty.reason).toBe('empty_dns_answer');

    const resOk = await evaluateNavigationPolicy('https://example.com/', basePolicy, async () => ['93.184.216.34']);
    expect(resOk.allowed).toBe(true);
    expect(resOk.pinnedAddress).toBe('93.184.216.34');
  });

  it('enforces navigationAuthorizer approval and denies on throw', async () => {
    const dns = async () => ['93.184.216.34'];
    const denied = await evaluateNavigationPolicy(
      'https://example.com/a',
      { ...basePolicy, navigationAuthorizer: () => false },
      dns,
    );
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('navigation_authorizer_denied');

    const threw = await evaluateNavigationPolicy(
      'https://example.com/a',
      { ...basePolicy, navigationAuthorizer: () => { throw new Error('boom'); } },
      dns,
    );
    expect(threw.allowed).toBe(false);
    expect(threw.reason).toBe('navigation_authorizer_error');
  });

  it('rejects stale, cross-run, changed-document, and changed-generation SnapshotRefs', () => {
    const ref: SnapshotRef = {
      run_id: 'run_1',
      snapshot_id: 'snap_1',
      ref_id: 'ref_1',
      document_id: 'doc_1',
      dom_generation: 1,
      target_id: 'el_1',
    };
    const activeRefs = new Map([['ref_1', ref]]);
    expect(resolveSnapshotRef(ref, 'run_2', 'snap_1', activeRefs, { documentId: 'doc_1', domGeneration: 1, url: 'https://example.com' }).reason).toBe('cross_run_ref');
    expect(resolveSnapshotRef(ref, 'run_1', 'snap_2', activeRefs, { documentId: 'doc_1', domGeneration: 1, url: 'https://example.com' }).reason).toBe('stale_snapshot_id');
    expect(resolveSnapshotRef(ref, 'run_1', 'snap_1', activeRefs, { documentId: 'doc_2', domGeneration: 1, url: 'https://example.com' }).reason).toBe('document_changed');
    expect(resolveSnapshotRef(ref, 'run_1', 'snap_1', activeRefs, { documentId: 'doc_1', domGeneration: 2, url: 'https://example.com' }).reason).toBe('dom_generation_changed');
  });
});

describe('BrowserSession orchestration', () => {
  it('fails startup if PagePort lacks required capabilities', () => {
    const badPort = makeFakePagePort({
      capabilities: {
        requestInterception: false,
        pinnedConnections: true,
        guardedTargets: true,
        lifecycleReporting: true,
      },
    });
    expect(() => new BrowserSession({
      runId: 'run_1',
      policy: { allowedHosts: ['example.com'] },
      pagePort: badPort,
      dnsResolver: async () => ['93.184.216.34'],
    })).toThrow(/PagePort missing required capabilities/);
  });

  it('navigates, snapshots, acts on valid ref, and blocks password/file inputs', async () => {
    const session = new BrowserSession({
      runId: 'run_1',
      policy: { allowedHosts: ['example.com'] },
      pagePort: makeFakePagePort(),
      dnsResolver: async () => ['93.184.216.34'],
    });

    const nav = await session.navigate('https://example.com/');
    expect(nav.ok).toBe(true);
    expect(nav.pinned_address).toBe('93.184.216.34');

    const snap = await session.snapshot();
    expect(snap.ok).toBe(true);
    expect(snap.refs.length).toBe(3);

    const actOk = await session.act({ ref: snap.refs[0].ref, action: 'click' });
    expect(actOk.ok).toBe(true);
    expect(actOk.termination_confirmed).toBe(true);

    // Active refs were invalidated by the previous action.
    const actStale = await session.act({ ref: snap.refs[0].ref, action: 'click' });
    expect(actStale.ok).toBe(false);
    expect(actStale.error_code).toBe('stale_snapshot_id');

    const snap2 = await session.snapshot();
    const actPwd = await session.act({ ref: snap2.refs[1].ref, action: 'type', value: 'secret' });
    expect(actPwd.ok).toBe(false);
    expect(actPwd.error_code).toBe('forbidden_input_type');

    const disposed = await session.dispose();
    expect(disposed.ok).toBe(true);
  });

  it('taints session on outer timeout until authoritative settlement', async () => {
    const session = new BrowserSession({
      runId: 'run_1',
      policy: { allowedHosts: ['example.com'] },
      pagePort: makeFakePagePort(),
      dnsResolver: async () => ['93.184.216.34'],
    });

    session.markOuterTimeout();
    const blockedSnap = await session.snapshot();
    expect(blockedSnap.ok).toBe(false);
    expect(blockedSnap.error_code).toBe('session_tainted_by_timeout');

    const settled = await session.awaitAuthoritativeSettlement();
    expect(settled).toBe(true);

    const unblockedSnap = await session.snapshot();
    expect(unblockedSnap.ok).toBe(true);
  });
});
