import { describe, it, expect, beforeEach } from 'vitest';
import {
  ARTIFACT_NO_ACTIVE_CONTENT_CONSTRAINT,
  ArtifactParserSafetyConfig,
  checkParserSafety,
  assertParserSafe,
  ActiveContentViolationError,
  EXPANSION_LIMITS,
  enforceExpansionBounds,
  scanPdfActiveContent,
  scanXmlDangerousConstructs,
  taint,
  isTainted,
  registerArtifactParser,
  getRegisteredParsers,
  verifyAllParsersCompliant,
} from './artifact_no_active_content_9';

const compliant = (over: Partial<ArtifactParserSafetyConfig> = {}): ArtifactParserSafetyConfig => ({
  capabilityId: 'cap_test_parser',
  artifactType: 'xml',
  executesActiveContent: false,
  dtdProcessingEnabled: false,
  entityExpansionEnabled: false,
  externalResourceResolutionEnabled: false,
  boundsExpansion: true,
  runsInSandbox: true,
  denyByDefaultEgress: true,
  taintsOutput: true,
  ...over,
});

describe('con_artifact_no_active_content_9 constraint record', () => {
  it('has the expected schema fields', () => {
    expect(ARTIFACT_NO_ACTIVE_CONTENT_CONSTRAINT.id).toBe('con_artifact_no_active_content_9');
    expect(ARTIFACT_NO_ACTIVE_CONTENT_CONSTRAINT.status).toBe('active');
    expect(ARTIFACT_NO_ACTIVE_CONTENT_CONSTRAINT.added_epoch).toBe(9);
    expect(ARTIFACT_NO_ACTIVE_CONTENT_CONSTRAINT.description).toContain('active content');
  });
});

describe('checkParserSafety', () => {
  it('accepts a fully compliant parser', () => {
    expect(checkParserSafety(compliant()).ok).toBe(true);
  });

  it('rejects a parser that executes active content', () => {
    const r = checkParserSafety(compliant({ executesActiveContent: true }));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.field === 'executesActiveContent')).toBe(true);
  });

  it('rejects DTD/entity/external-resource enabled parsers', () => {
    const r = checkParserSafety(
      compliant({
        dtdProcessingEnabled: true,
        entityExpansionEnabled: true,
        externalResourceResolutionEnabled: true,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects non-sandboxed / egress-open / untainted parsers', () => {
    const r = checkParserSafety(
      compliant({ runsInSandbox: false, denyByDefaultEgress: false, taintsOutput: false }),
    );
    expect(r.ok).toBe(false);
  });

  it('rejects a missing config', () => {
    // @ts-expect-error deliberate misuse
    expect(checkParserSafety(undefined).ok).toBe(false);
  });
});

describe('assertParserSafe', () => {
  it('does not throw for compliant parsers', () => {
    expect(() => assertParserSafe(compliant())).not.toThrow();
  });

  it('throws ActiveContentViolationError with constraint id', () => {
    try {
      assertParserSafe(compliant({ executesActiveContent: true }));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ActiveContentViolationError);
      expect((e as ActiveContentViolationError).constraintId).toBe('con_artifact_no_active_content_9');
      expect((e as ActiveContentViolationError).violations.length).toBeGreaterThan(0);
    }
  });
});

describe('enforceExpansionBounds', () => {
  it('passes within limits', () => {
    expect(() =>
      enforceExpansionBounds({ inputBytes: 1000, outputBytes: 5000, depth: 3, entityExpansions: 10 }),
    ).not.toThrow();
  });

  it('throws on excessive output bytes (zip-bomb)', () => {
    expect(() =>
      enforceExpansionBounds({ inputBytes: 1, outputBytes: EXPANSION_LIMITS.maxOutputBytes + 1, depth: 1 }),
    ).toThrow(ActiveContentViolationError);
  });

  it('throws on excessive ratio', () => {
    expect(() =>
      enforceExpansionBounds({ inputBytes: 10, outputBytes: 10 * (EXPANSION_LIMITS.maxDecompressionRatio + 5), depth: 1 }),
    ).toThrow(ActiveContentViolationError);
  });

  it('throws on excessive depth', () => {
    expect(() =>
      enforceExpansionBounds({ inputBytes: 10, outputBytes: 20, depth: EXPANSION_LIMITS.maxRecursionDepth + 1 }),
    ).toThrow(ActiveContentViolationError);
  });

  it('throws on billion-laughs entity expansion', () => {
    expect(() =>
      enforceExpansionBounds({
        inputBytes: 100,
        outputBytes: 200,
        depth: 1,
        entityExpansions: EXPANSION_LIMITS.maxEntityExpansions + 1,
      }),
    ).toThrow(ActiveContentViolationError);
  });
});

describe('active content scanning', () => {
  it('detects PDF active-content markers', () => {
    const r = scanPdfActiveContent('%PDF-1.7 /OpenAction /JavaScript');
    expect(r.clean).toBe(false);
    expect(r.findings).toContain('/OpenAction');
    expect(r.findings).toContain('/JavaScript');
  });

  it('reports clean pdf text', () => {
    expect(scanPdfActiveContent('just some plain text stream').clean).toBe(true);
  });

  it('detects XXE / XInclude constructs', () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]>';
    const r = scanXmlDangerousConstructs(xml);
    expect(r.clean).toBe(false);
    expect(r.findings).toContain('<!DOCTYPE');
    expect(r.findings).toContain('<!ENTITY');
    expect(r.findings).toContain('SYSTEM');
  });

  it('reports clean xml', () => {
    expect(scanXmlDangerousConstructs('<root><a>1</a></root>').clean).toBe(true);
  });
});

describe('taint propagation', () => {
  it('marks parsed output as permanently tainted, never instructions', () => {
    const t = taint({ text: 'hello' }, 'artifact.pdf');
    expect(isTainted(t)).toBe(true);
    expect(t.isInstruction).toBe(false);
    expect(t.value).toEqual({ text: 'hello' });
    expect(t.source).toBe('artifact.pdf');
  });

  it('taint objects are frozen', () => {
    const t = taint('x', 's');
    expect(Object.isFrozen(t)).toBe(true);
  });

  it('isTainted is false for plain values', () => {
    expect(isTainted('plain')).toBe(false);
    expect(isTainted({ value: 1 })).toBe(false);
    expect(isTainted(null)).toBe(false);
  });
});

describe('parser registry compliance', () => {
  beforeEach(() => {
    // Registry is module-global; a compliant register keeps it verifiable.
  });

  it('registers compliant parsers and reports them', () => {
    registerArtifactParser(compliant({ capabilityId: 'cap_reg_test_1' }));
    expect(getRegisteredParsers().some((p) => p.capabilityId === 'cap_reg_test_1')).toBe(true);
  });

  it('refuses to register a non-compliant parser', () => {
    expect(() =>
      registerArtifactParser(compliant({ capabilityId: 'cap_reg_bad', executesActiveContent: true })),
    ).toThrow(ActiveContentViolationError);
  });

  it('verifyAllParsersCompliant reports all registered parsers as compliant', () => {
    registerArtifactParser(compliant({ capabilityId: 'cap_reg_test_2' }));
    expect(verifyAllParsersCompliant().ok).toBe(true);
  });
});
