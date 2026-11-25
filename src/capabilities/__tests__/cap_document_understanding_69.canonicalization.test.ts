import { describe, it, expect } from 'vitest';
import { computeExtractionId } from '../cap_document_understanding_69';

describe('computeExtractionId canonicalization', () => {
  it('is stable across nested key order and distinguishes nested value order', () => {
    const artifactSha256 = 'artifact-sha';
    const parserId = 'pypdf';
    const version = '1.2.3';

    const a = computeExtractionId(artifactSha256, parserId, version, {
      nested: { b: 1, a: 2 },
      list: [1, 2],
    });
    const b = computeExtractionId(artifactSha256, parserId, version, {
      nested: { a: 2, b: 1 },
      list: [1, 2],
    });
    const c = computeExtractionId(artifactSha256, parserId, version, {
      nested: { a: 2, b: 1 },
      list: [2, 1],
    });
    const d = computeExtractionId(artifactSha256, parserId, '1.2.4', {
      nested: { a: 2, b: 1 },
      list: [1, 2],
    });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});
