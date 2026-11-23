import { describe, it, expect } from 'vitest';
import { resolveSnapshotRef } from '../snapshot_refs';
import { BrowserSession, BROWSER_TOOL_METADATA } from '../session';
import type { PagePort, SnapshotRef } from '../types';

function makePagePort(capOverrides?: Partial<PagePort['capabilities']>): PagePort {
  return {
    capabilities: {
      requestInterception: true,
      pinnedConnections: true,
      guardedTargets: true,
      lifecycleReporting: true,
      ...capOverrides,
    },
    async getIdentity() {
      return { documentId: 'doc_1', domGeneration: 1, url: 'https://example.com/' };
    },
    async navigate() {
      return { ok: true, terminationConfirmed: true, documentId: 'doc_1', domGeneration: 1, status: 200 };
    },
    async snapshot() {
      return {
        ok: true,
        terminationConfirmed: true,
        documentId: 'doc_1',
        domGeneration: 1,
        url: 'https://example.com/',
        textExcerpt: 'Example',
        elements: [],
      };
    },
    async actGuarded() {
      return { ok: true, terminationConfirmed: true, documentId: 'doc_1', domGeneration: 2 };
    },
    async awaitSettlement() {
      return true;
    },
    async dispose() {
      return true;
    },
  };
}

describe('resolveSnapshotRef', () => {
  const storedRef: SnapshotRef = {
    run_id: 'run_1',
    snapshot_id: 'snap_1',
    ref_id: 'ref_1',
    document_id: 'doc_1',
    dom_generation: 1,
    target_id: 'el_1',
    role: 'button',
    name: 'Submit',
  };

  const activeRefs = new Map<string, SnapshotRef>([['ref_1', storedRef]]);
  const currentIdentity = { documentId: 'doc_1', domGeneration: 1, url: 'https://example.com/' };

  it('resolves a valid matching ref', () => {
    const res = resolveSnapshotRef(storedRef, 'run_1', 'snap_1', activeRefs, currentIdentity);
    expect(res).toEqual({ ok: true, ref: storedRef });
  });

  it('rejects cross-run refs', () => {
    const otherRunRef: SnapshotRef = { ...storedRef, run_id: 'run_2' };
    const res = resolveSnapshotRef(otherRunRef, 'run_1', 'snap_1', activeRefs, currentIdentity);
    expect(res).toEqual({ ok: false, reason: 'cross_run_ref' });
  });

  it('rejects stale or null snapshot IDs', () => {
    expect(resolveSnapshotRef(storedRef, 'run_1', null, activeRefs, currentIdentity)).toEqual({
      ok: false,
      reason: 'stale_snapshot_id',
    });
    expect(resolveSnapshotRef(storedRef, 'run_1', 'snap_2', activeRefs, currentIdentity)).toEqual({
      ok: false,
      reason: 'stale_snapshot_id',
    });
  });

  it('rejects missing refs', () => {
    const missingRef: SnapshotRef = { ...storedRef, ref_id: 'ref_missing' };
    const res = resolveSnapshotRef(missingRef, 'run_1', 'snap_1', activeRefs, currentIdentity);
    expect(res).toEqual({ ok: false, reason: 'missing_ref' });
  });

  it('rejects when document_id changed', () => {
    const res = resolveSnapshotRef(storedRef, 'run_1', 'snap_1', activeRefs, {
      ...currentIdentity,
      documentId: 'doc_2',
    });
    expect(res).toEqual({ ok: false, reason: 'document_changed' });
  });

  it('rejects when dom_generation changed', () => {
    const res = resolveSnapshotRef(storedRef, 'run_1', 'snap_1', activeRefs, {
      ...currentIdentity,
      domGeneration: 2,
    });
    expect(res).toEqual({ ok: false, reason: 'dom_generation_changed' });
  });

  it('rejects when target_id mismatches stored ref', () => {
    const mismatchedTarget: SnapshotRef = { ...storedRef, target_id: 'el_other' };
    const res = resolveSnapshotRef(mismatchedTarget, 'run_1', 'snap_1', activeRefs, currentIdentity);
    expect(res).toEqual({ ok: false, reason: 'target_identity_mismatch' });
  });
});

describe('BrowserSession & BROWSER_TOOL_METADATA', () => {
  it('fails startup when any required PagePort capability is missing', () => {
    const missingCaps: Array<Partial<PagePort['capabilities']>> = [
      { requestInterception: false },
      { pinnedConnections: false },
      { guardedTargets: false },
      { lifecycleReporting: false },
    ];

    for (const capOverride of missingCaps) {
      expect(
        () =>
          new BrowserSession({
            runId: 'run_1',
            policy: { allowedHosts: ['example.com'] },
            pagePort: makePagePort(capOverride),
          }),
      ).toThrow();
    }
  });

  it('marks all browser tools non-idempotent, non-concurrent, and excluded from delegation', () => {
    expect(BROWSER_TOOL_METADATA.map((t) => t.name)).toEqual([
      'browser_navigate',
      'browser_snapshot',
      'browser_act',
    ]);
    for (const tool of BROWSER_TOOL_METADATA) {
      expect(tool.idempotent).toBe(false);
      expect(tool.concurrentSafe).toBe(false);
      expect(tool.excludeFromDelegation).toBe(true);
    }
  });
});
