import { describe, it, expect } from 'vitest';
import { ARTIFACT_NO_ACTIVE_CONTENT_CONSTRAINT } from './artifact_no_active_content_9';

// These tests guard the *content* of the first-class constraint record against
// silent weakening. The spec mandates that this single record span ALL artifact
// types and enumerate the XXE/SSRF and DoS-bomb threat classes as non-negotiable
// failure conditions. If any of these named threat classes is dropped from the
// description, the constraint would no longer bind future parsers as intended,
// so we assert each one is present.

describe('con_artifact_no_active_content_9 threat coverage', () => {
  const desc = ARTIFACT_NO_ACTIVE_CONTENT_CONSTRAINT.description;

  it('is an active constraint added at epoch 9 with the canonical id', () => {
    expect(ARTIFACT_NO_ACTIVE_CONTENT_CONSTRAINT.id).toBe('con_artifact_no_active_content_9');
    expect(ARTIFACT_NO_ACTIVE_CONTENT_CONSTRAINT.status).toBe('active');
    expect(ARTIFACT_NO_ACTIVE_CONTENT_CONSTRAINT.added_epoch).toBe(9);
  });

  it('forbids executing active content and states parsing is data extraction only', () => {
    expect(desc).toContain('NEVER execute');
    expect(desc.toLowerCase()).toContain('data extraction only');
  });

  it('enumerates the active-content vectors from the research (PDF actions, macros, JS, hooks)', () => {
    for (const vector of [
      'macros',
      'JavaScript',
      '/Launch',
      '/OpenAction',
      '/AA',
      'XFA',
      'post-install hooks',
    ]) {
      expect(desc).toContain(vector);
    }
  });

  it('covers the XML XXE/SSRF/XInclude threat class', () => {
    for (const term of ['DTD', 'external entity', 'XXE', 'SSRF', 'XInclude']) {
      expect(desc).toContain(term);
    }
  });

  it('covers the expansion-bomb DoS threat class (billion-laughs / zip-bomb)', () => {
    for (const term of ['billion-laughs', 'zip-bomb', 'decompression']) {
      expect(desc).toContain(term);
    }
  });

  it('mandates sandbox isolation with deny-by-default egress as a hard failure boundary', () => {
    expect(desc).toContain('sandbox');
    expect(desc).toContain('deny-by-default egress');
    expect(desc).toContain('hard failure');
  });

  it('declares parsed output permanently tainted evidence, never controller instructions', () => {
    const lower = desc.toLowerCase();
    expect(lower).toContain('tainted evidence');
    expect(lower).toContain('never be interpreted as instructions');
  });
});
