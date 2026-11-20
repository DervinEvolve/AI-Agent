import { describe, it, expect } from 'vitest';
import { WebSnapshotStore, validateDelegationAllowedTools } from '../web_research_mount.js';
import { BraveWebSearchAdapter } from '../brave_web_search_adapter.js';

describe('cap_web_research_mount_37 extra coverage', () => {
  it('WebSnapshotStore counts Unicode code points accurately for non-BMP characters and enforces maxSnapshots', () => {
    const store = new WebSnapshotStore();
    const first = store.put('https://example.com/0', 'a😀b');
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.snapshot.total_code_points).toBe(3);
      expect(first.snapshot.byteLength).toBe(6);
      expect(first.snapshot.text_sha256).toMatch(/^[0-9a-f]{64}$/);
    }

    for (let i = 1; i < store.maxSnapshots; i++) {
      const res = store.put(`https://example.com/${i}`, `page-${i}`);
      expect(res.ok).toBe(true);
    }

    const overflow = store.put('https://example.com/overflow', 'extra');
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.code).toBe('snapshot_limit');
    }
  });

  it('BraveWebSearchAdapter rejects when API key is missing', async () => {
    const adapter = new BraveWebSearchAdapter({});
    const controller = new AbortController();
    await expect(adapter.search('vitest', 5, controller.signal)).rejects.toThrow();
  });

  it('validateDelegationAllowedTools allows non-web tools', () => {
    expect(() => validateDelegationAllowedTools(['read_file', 'write_file'])).not.toThrow();
  });
});
