import { describe, it, expect } from 'vitest';
import {
  classifyBeforeTruncate,
  PagedRecallStore,
  BROWSER_VIEW_CAP_BYTES,
} from '../classify_before_truncate';

describe('classify-before-truncate and paged recall', () => {
  const largeContent = 'x'.repeat(BROWSER_VIEW_CAP_BYTES + 1024);

  it('classifies success for a view exceeding 24 KiB with success-classifying fields', () => {
    const result = {
      status: 'ok',
      output: { ok: true, content: largeContent },
      termination_confirmed: true,
      cleanup_confirmed: true,
    };

    expect(classifyBeforeTruncate(result)).toBe('success');
  });

  it('classifies known_failure for a view exceeding 24 KiB with output.ok=false', () => {
    const result = {
      status: 'ok',
      output: { ok: false, content: largeContent },
      termination_confirmed: true,
      cleanup_confirmed: true,
    };

    expect(classifyBeforeTruncate(result)).toBe('known_failure');
  });

  it('recovers every node and full value with advancing offsets', () => {
    const store = new PagedRecallStore();
    const values = [
      'a'.repeat(BROWSER_VIEW_CAP_BYTES + 1),
      'b'.repeat(BROWSER_VIEW_CAP_BYTES + 2),
      'c'.repeat(BROWSER_VIEW_CAP_BYTES + 3),
    ];

    values.forEach((value) => store.store(value));

    const collected: string[] = [];
    let offset = 0;

    while (true) {
      const page = store.recall(offset, 1);
      for (const node of page.nodes) {
        collected.push(node.fullOutput);
      }

      if (!page.hasMore) {
        break;
      }

      offset = page.nextOffset;
    }

    expect(collected).toEqual(values);
  });
});
