import { describe, it, expect } from 'vitest';
import {
  ACTIVE_CONTENT_CLASSES,
  DEFAULT_MAX_OUTPUT_BYTES,
  HARD_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_DECOMPRESSED_BYTES,
  DEFAULT_MAX_EXPANSION_RATIO,
  DEFAULT_MAX_ARCHIVE_ENTRIES,
  DEFAULT_MAX_NESTING_DEPTH,
} from '../cap_document_understanding_9';

/**
 * These constants are load-bearing security parameters for the sandboxed
 * document ingestion capability. The spec mandates that decompression is
 * bounded by BOTH an absolute output-size cap AND an expansion-ratio cap
 * ("absolute + ratio, not depth-only"), that the default output cap never
 * exceeds the hard maximum, and that the active-content taxonomy covers the
 * concrete attack classes named in the threat model (embedded JS, /Launch,
 * /OpenAction, XFA, embedded files, macros, external references).
 *
 * We verify the real exported values and their invariants rather than mocking.
 */
describe('cap_document_understanding_9 security constants', () => {
  it('keeps the default output cap at or below the hard maximum', () => {
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBeGreaterThan(0);
    expect(HARD_MAX_OUTPUT_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBeLessThanOrEqual(HARD_MAX_OUTPUT_BYTES);
  });

  it('uses the exact documented output byte caps', () => {
    // 262144 = 256 KiB, 1048576 = 1 MiB per the interface spec.
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(256 * 1024);
    expect(HARD_MAX_OUTPUT_BYTES).toBe(1024 * 1024);
  });

  it('bounds decompression by both an absolute size cap and a ratio cap', () => {
    // Both must be finite, positive, and independently enforceable.
    expect(DEFAULT_MAX_DECOMPRESSED_BYTES).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_MAX_DECOMPRESSED_BYTES)).toBe(true);
    expect(DEFAULT_MAX_EXPANSION_RATIO).toBeGreaterThan(1);
    expect(Number.isFinite(DEFAULT_MAX_EXPANSION_RATIO)).toBe(true);
    // Documented values: 100 MiB absolute, 200x ratio.
    expect(DEFAULT_MAX_DECOMPRESSED_BYTES).toBe(100 * 1024 * 1024);
    expect(DEFAULT_MAX_EXPANSION_RATIO).toBe(200);
  });

  it('bounds archive entry count and nesting depth to defeat zip bombs', () => {
    expect(DEFAULT_MAX_ARCHIVE_ENTRIES).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_MAX_ARCHIVE_ENTRIES)).toBe(true);
    expect(DEFAULT_MAX_NESTING_DEPTH).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_MAX_NESTING_DEPTH)).toBe(true);
    // A finite nesting depth is what prevents nested-archive (recursive) bombs.
    expect(DEFAULT_MAX_NESTING_DEPTH).toBeLessThan(DEFAULT_MAX_ARCHIVE_ENTRIES);
  });

  it('enumerates the active-content classes named in the threat model', () => {
    // The CDR layer must be able to name/report each of these when stripping.
    const required = [
      'javascript',
      'openaction',
      'launch',
      'xfa',
      'embedded_file',
      'macro',
      'external_reference',
    ];
    for (const cls of required) {
      expect(ACTIVE_CONTENT_CLASSES).toContain(cls);
    }
  });

  it('has a non-empty, unique active-content taxonomy', () => {
    expect(ACTIVE_CONTENT_CLASSES.length).toBeGreaterThan(0);
    const unique = new Set(ACTIVE_CONTENT_CLASSES);
    expect(unique.size).toBe(ACTIVE_CONTENT_CLASSES.length);
    // Every class is a non-empty string identifier.
    for (const cls of ACTIVE_CONTENT_CLASSES) {
      expect(typeof cls).toBe('string');
      expect(cls.length).toBeGreaterThan(0);
    }
  });
});
