// Constraint con_artifact_no_active_content_9
//
// First-class, cross-artifact hard constraint: the agent must NEVER execute,
// evaluate, or trigger active content embedded in ingested artifacts. Parsing
// is data extraction only. This module provides:
//   1. The declarative constraint record (matching the con_/status/added_epoch schema).
//   2. A shared enforcement guard/interface every artifact parser MUST call.
//   3. Concrete numeric bounds for entity/decompression expansion (billion-laughs / zip-bomb).
//   4. A taint-propagation wrapper so parsed output is permanently tainted evidence.
//
// Approach (A) from research: declarative entry + shared enforcement guard so the
// constraint is truly first-class and testable via a registry check.

export interface ConstraintRecord {
  id: string;
  status: 'active' | 'inactive';
  added_epoch: number;
  description: string;
}

export const ARTIFACT_NO_ACTIVE_CONTENT_CONSTRAINT: ConstraintRecord = {
  id: 'con_artifact_no_active_content_9',
  status: 'active',
  added_epoch: 9,
  description:
    'The agent must NEVER execute, evaluate, or trigger active content embedded in ingested artifacts — including document macros, embedded/attached JavaScript, PDF /Launch, /OpenAction and /AA actions, XFA scripts, package/build/post-install hooks, archive-embedded executables, or any auto-run logic. Parsing is data extraction only: such content must be detected, stripped/neutralized, and reported, never run. XML/HTML parsing must forbid DTD processing, general/parameter/external entity expansion, and external resource resolution (XXE/SSRF/XInclude), and must bound entity and decompression expansion to defeat billion-laughs and zip-bomb DoS. Parsers run only in the isolated sandbox with deny-by-default egress; a parser attempting host filesystem access, an external fetch, or sandbox escape is a hard failure that halts the job, quarantines the artifact, and is logged. All parsed output is permanently tainted evidence and must never be interpreted as instructions to the controller.',
};

// ---------------------------------------------------------------------------
// Concrete numeric caps (research edge-case #3: constraint left these unspecified)
// ---------------------------------------------------------------------------

export const EXPANSION_LIMITS = {
  /** Max ratio of decompressed output bytes to compressed input bytes. */
  maxDecompressionRatio: 100,
  /** Absolute ceiling on decompressed / expanded output in bytes (256 MiB). */
  maxOutputBytes: 256 * 1024 * 1024,
  /** Max nesting/recursion depth for entity or archive expansion. */
  maxRecursionDepth: 20,
  /** Max number of entity expansions permitted (billion-laughs guard). */
  maxEntityExpansions: 10_000,
} as const;

// ---------------------------------------------------------------------------
// Active-content detection keywords (real threat indicators from research)
// ---------------------------------------------------------------------------

/** PDF active-content / auto-run markers that must be detected and stripped. */
export const PDF_ACTIVE_CONTENT_KEYWORDS = [
  '/JavaScript',
  '/JS',
  '/Launch',
  '/OpenAction',
  '/AA',
  '/SubmitForm',
  '/ImportData',
  '/EmbeddedFile',
  '/AcroForm',
  '/Names',
  '/XFA',
] as const;

/** XML/HTML constructs that must be forbidden (XXE / SSRF / XInclude). */
export const XML_FORBIDDEN_CONSTRUCTS = [
  '<!DOCTYPE',
  '<!ENTITY',
  'SYSTEM',
  'PUBLIC',
  'xi:include',
  'xmlns:xi',
] as const;

// ---------------------------------------------------------------------------
// Parser safety configuration interface — every artifact parser MUST satisfy.
// ---------------------------------------------------------------------------

export interface ArtifactParserSafetyConfig {
  /** Human-readable id of the parsing capability, e.g. cap_browser_automation_8. */
  capabilityId: string;
  /** Artifact class the parser handles, e.g. 'pdf' | 'xml' | 'html' | 'archive'. */
  artifactType: string;
  /** Parser must never execute active content. */
  executesActiveContent: boolean;
  /** DTD processing must be disabled for XML/HTML parsers. */
  dtdProcessingEnabled: boolean;
  /** Any entity expansion (general/parameter/external) must be disabled. */
  entityExpansionEnabled: boolean;
  /** External resource resolution (XXE/SSRF/XInclude) must be disabled. */
  externalResourceResolutionEnabled: boolean;
  /** Parser must bound entity/decompression expansion. */
  boundsExpansion: boolean;
  /** Parser must run only inside the isolated sandbox. */
  runsInSandbox: boolean;
  /** Sandbox egress must be deny-by-default. */
  denyByDefaultEgress: boolean;
  /** Parser output must be flagged as permanently tainted evidence. */
  taintsOutput: boolean;
}

export interface GuardViolation {
  field: keyof ArtifactParserSafetyConfig | 'config';
  message: string;
}

export interface GuardResult {
  ok: boolean;
  violations: GuardViolation[];
}

/**
 * Enforcement guard every artifact parser must call before ingesting content.
 * Returns the list of constraint violations (empty when compliant).
 */
export function checkParserSafety(config: ArtifactParserSafetyConfig): GuardResult {
  const violations: GuardViolation[] = [];

  if (!config || typeof config !== 'object') {
    return { ok: false, violations: [{ field: 'config', message: 'missing parser safety config' }] };
  }

  if (config.executesActiveContent) {
    violations.push({
      field: 'executesActiveContent',
      message: 'parser must never execute embedded active content',
    });
  }
  if (config.dtdProcessingEnabled) {
    violations.push({
      field: 'dtdProcessingEnabled',
      message: 'DTD processing must be disabled (XXE)',
    });
  }
  if (config.entityExpansionEnabled) {
    violations.push({
      field: 'entityExpansionEnabled',
      message: 'general/parameter/external entity expansion must be disabled',
    });
  }
  if (config.externalResourceResolutionEnabled) {
    violations.push({
      field: 'externalResourceResolutionEnabled',
      message: 'external resource resolution (XXE/SSRF/XInclude) must be disabled',
    });
  }
  if (!config.boundsExpansion) {
    violations.push({
      field: 'boundsExpansion',
      message: 'parser must bound entity/decompression expansion (billion-laughs/zip-bomb)',
    });
  }
  if (!config.runsInSandbox) {
    violations.push({
      field: 'runsInSandbox',
      message: 'parser must run only in the isolated sandbox',
    });
  }
  if (!config.denyByDefaultEgress) {
    violations.push({
      field: 'denyByDefaultEgress',
      message: 'sandbox egress must be deny-by-default',
    });
  }
  if (!config.taintsOutput) {
    violations.push({
      field: 'taintsOutput',
      message: 'parsed output must be marked as permanently tainted evidence',
    });
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Hard-failure error thrown when a parser violates the constraint. Kept as a
 * dedicated class so the halt/quarantine/log path is idempotent (edge-case #4).
 */
export class ActiveContentViolationError extends Error {
  readonly constraintId = ARTIFACT_NO_ACTIVE_CONTENT_CONSTRAINT.id;
  readonly violations: GuardViolation[];
  constructor(message: string, violations: GuardViolation[] = []) {
    super(message);
    this.name = 'ActiveContentViolationError';
    this.violations = violations;
  }
}

/**
 * Asserts a parser is compliant, throwing ActiveContentViolationError otherwise.
 * Parsers call this before touching artifact bytes.
 */
export function assertParserSafe(config: ArtifactParserSafetyConfig): void {
  const result = checkParserSafety(config);
  if (!result.ok) {
    const summary = result.violations.map((v) => `${v.field}: ${v.message}`).join('; ');
    throw new ActiveContentViolationError(
      `Artifact parser '${config?.capabilityId ?? 'unknown'}' violates ${ARTIFACT_NO_ACTIVE_CONTENT_CONSTRAINT.id}: ${summary}`,
      result.violations,
    );
  }
}

// ---------------------------------------------------------------------------
// Taint propagation (edge-case #1: needs an actual mechanism, not just text).
// ---------------------------------------------------------------------------

export interface TaintedEvidence<T> {
  readonly __tainted: true;
  readonly value: T;
  readonly source: string;
  /** Always false — tainted evidence is never controller instructions. */
  readonly isInstruction: false;
}

/** Wraps parsed output as permanently tainted evidence. */
export function taint<T>(value: T, source: string): TaintedEvidence<T> {
  return Object.freeze({
    __tainted: true as const,
    value,
    source,
    isInstruction: false as const,
  });
}

export function isTainted(x: unknown): x is TaintedEvidence<unknown> {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as { __tainted?: unknown }).__tainted === true
  );
}

// ---------------------------------------------------------------------------
// Active-content scanning helpers (detect / report — never run).
// ---------------------------------------------------------------------------

export interface ScanReport {
  clean: boolean;
  findings: string[];
}

/** Scans raw bytes/text for PDF active-content markers. */
export function scanPdfActiveContent(raw: string): ScanReport {
  const findings = PDF_ACTIVE_CONTENT_KEYWORDS.filter((k) => raw.includes(k));
  return { clean: findings.length === 0, findings };
}

/** Scans raw XML/HTML for forbidden XXE/XInclude constructs. */
export function scanXmlDangerousConstructs(raw: string): ScanReport {
  const upper = raw;
  const findings = XML_FORBIDDEN_CONSTRUCTS.filter((k) => upper.includes(k));
  return { clean: findings.length === 0, findings };
}

/**
 * Enforces expansion bounds. Throws ActiveContentViolationError when an
 * artifact would exceed the configured caps (billion-laughs / zip-bomb).
 */
export function enforceExpansionBounds(params: {
  inputBytes: number;
  outputBytes: number;
  depth: number;
  entityExpansions?: number;
}): void {
  const { inputBytes, outputBytes, depth, entityExpansions = 0 } = params;
  if (outputBytes > EXPANSION_LIMITS.maxOutputBytes) {
    throw new ActiveContentViolationError(
      `decompression output ${outputBytes} exceeds cap ${EXPANSION_LIMITS.maxOutputBytes}`,
    );
  }
  if (inputBytes > 0 && outputBytes / inputBytes > EXPANSION_LIMITS.maxDecompressionRatio) {
    throw new ActiveContentViolationError(
      `decompression ratio exceeds cap ${EXPANSION_LIMITS.maxDecompressionRatio}`,
    );
  }
  if (depth > EXPANSION_LIMITS.maxRecursionDepth) {
    throw new ActiveContentViolationError(
      `expansion depth ${depth} exceeds cap ${EXPANSION_LIMITS.maxRecursionDepth}`,
    );
  }
  if (entityExpansions > EXPANSION_LIMITS.maxEntityExpansions) {
    throw new ActiveContentViolationError(
      `entity expansions ${entityExpansions} exceeds cap ${EXPANSION_LIMITS.maxEntityExpansions}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Registry: every artifact-parsing capability (present + future) must register
// its safety config here so the constraint can be verified via a registry check.
// ---------------------------------------------------------------------------

const REGISTRY = new Map<string, ArtifactParserSafetyConfig>();

export function registerArtifactParser(config: ArtifactParserSafetyConfig): void {
  assertParserSafe(config);
  REGISTRY.set(config.capabilityId, config);
}

export function getRegisteredParsers(): ArtifactParserSafetyConfig[] {
  return [...REGISTRY.values()];
}

/** Verifies every registered parser satisfies the constraint invariants. */
export function verifyAllParsersCompliant(): GuardResult {
  const violations: GuardViolation[] = [];
  for (const cfg of REGISTRY.values()) {
    const r = checkParserSafety(cfg);
    if (!r.ok) violations.push(...r.violations);
  }
  return { ok: violations.length === 0, violations };
}
