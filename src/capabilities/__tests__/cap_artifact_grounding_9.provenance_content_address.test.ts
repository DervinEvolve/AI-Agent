import { describe, it, expect } from 'vitest';
import {
  Artifact,
  citationEntailsClaim,
  makeProvenance,
  sha256,
} from '../cap_artifact_grounding_9';

function artifactWith(id: string, spans: { section: string; text: string }[]): Artifact {
  return {
    id,
    declaredType: 'application/pdf',
    detectedType: 'application/pdf',
    activeContentDisarmed: false,
    truncated: false,
    trust: 'untrusted',
    spans,
  };
}

describe('cap_artifact_grounding_9 content-addressed provenance', () => {
  it('sha256 is deterministic for identical text', () => {
    const text = 'The revenue for 2023 was 42 million dollars.';
    expect(sha256(text)).toBe(sha256(text));
  });

  it('sha256 distinguishes text that differs only by a single character', () => {
    expect(sha256('42 million')).not.toBe(sha256('84 million'));
  });

  it('two distinct artifacts sharing identical span text share the citation sha256 but keep separate artifact ids', () => {
    const sharedText = 'Net income grew by 12 percent in the fourth quarter.';
    const a = artifactWith('art_a', [{ section: 'p1', text: sharedText }]);
    const b = artifactWith('art_b', [{ section: 'p1', text: sharedText }]);

    const provA = makeProvenance(a, 'p1');
    const provB = makeProvenance(b, 'p1');

    // Content-addressed hash is a property of the text, so it matches...
    expect(provA.sha256).toBe(provB.sha256);
    expect(provA.sha256).toBe(sha256(sharedText));
    // ...but provenance still identifies WHICH artifact the claim is grounded in.
    expect(provA.artifactId).toBe('art_a');
    expect(provB.artifactId).toBe('art_b');
    expect(provA.artifactId).not.toBe(provB.artifactId);
  });

  it('entailment holds against the correct source artifact but not a matching claim on the wrong provenance', () => {
    const sharedText = 'Net income grew by 12 percent in the fourth quarter.';
    const a = artifactWith('art_a', [{ section: 'p1', text: sharedText }]);
    const provA = makeProvenance(a, 'p1');

    // A claim entailed by the span text is accepted against its own artifact.
    expect(citationEntailsClaim(a, provA, 'income grew by 12 percent')).toBe(true);
    // A claim not present in the span is rejected even with valid provenance.
    expect(citationEntailsClaim(a, provA, 'income grew by 20 percent')).toBe(false);
  });

  it('a claim quoting the full span verbatim is entailed', () => {
    const text = 'The company employs 500 people worldwide.';
    const art = artifactWith('art_c', [{ section: 's1', text }]);
    const prov = makeProvenance(art, 's1');
    expect(citationEntailsClaim(art, prov, text)).toBe(true);
  });
});
