// cap_artifact_grounding_9
//
// Turns raw artifact extraction into trustworthy, cited, provenance-aware
// reasoning and reinforces the prompt-injection boundary: artifact text is
// EVIDENCE, never INSTRUCTION. This parallels the browser grounding behavior
// (beh_browser_grounding_8) at the point where the controller acts on
// extracted content.
//
// Design notes (from exploration consensus):
//  - Every consequential claim must carry a provenance tuple
//    (artifactId, section, sha256) and the citation must actually entail the
//    claim (not merely exist) -> `citationEntailsClaim`.
//  - Reliability signals (type mismatch, disarmed active content, low OCR
//    confidence, truncation) are FLAGGED, not silently trusted. Low OCR
//    confidence triggers cross-check / request-original rather than hard
//    rejection, since confidence is an imperfect proxy.
//  - Instruction-like / tool-like strings inside artifacts surface as reported
//    DATA, never executed. This invariant must hold across the memory
//    boundary too (disarmed text re-injected via long-term memory must not
//    regain instruction trust).

import { createHash } from 'node:crypto';

export type TrustLabel = 'trusted' | 'untrusted' | 'quarantined';

export interface Provenance {
  artifactId: string;
  /** page/section locator within the artifact, e.g. 'p3' or 'section:intro' */
  section: string;
  /** sha256 of the exact cited text span */
  sha256: string;
}

export interface ArtifactSpan {
  /** locator within the artifact (page/section) */
  section: string;
  /** the exact extracted text of this span */
  text: string;
  /** OCR confidence in [0,1] when the span came from OCR; undefined for native text */
  ocrConfidence?: number;
}

export interface Artifact {
  id: string;
  /** content-type the artifact CLAIMED to be (e.g. from an upload header) */
  declaredType: string;
  /** content-type actually detected by sniffing the bytes */
  detectedType: string;
  /** whether active content (macros/scripts/embedded execs) was disarmed */
  activeContentDisarmed: boolean;
  /** whether extraction was truncated (too large / limits hit) */
  truncated: boolean;
  spans: ArtifactSpan[];
  /** trust label carried alongside the content; ingested content is untrusted */
  trust: TrustLabel;
}

export interface ReliabilitySignal {
  kind:
    | 'type_mismatch'
    | 'disarmed_active_content'
    | 'low_ocr_confidence'
    | 'truncation';
  artifactId: string;
  detail: string;
  /** recommended handling: never a hard reject for OCR */
  recommendation: 'cross_check' | 'request_original' | 'flag_only';
}

export interface ReportedInstructionString {
  artifactId: string;
  section: string;
  /** the instruction/tool-like text, surfaced as inert data */
  text: string;
  /** always false: artifact strings are never executed */
  executed: false;
}

export interface GroundedClaim {
  claim: string;
  provenance: Provenance;
  /** true only when the cited span actually supports the claim */
  supported: boolean;
}

export interface GroundingResult {
  claims: GroundedClaim[];
  signals: ReliabilitySignal[];
  reportedInstructions: ReportedInstructionString[];
  /** consequential claims that could not be grounded -> require cross-check */
  unsupportedClaims: string[];
}

export const LOW_OCR_CONFIDENCE_THRESHOLD = 0.6;

/** Compute sha256 hex of a text span. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Build a provenance tuple for an exact span in an artifact.
 * Throws if the section does not exist so we can never fabricate provenance.
 */
export function makeProvenance(artifact: Artifact, section: string): Provenance {
  const span = artifact.spans.find((s) => s.section === section);
  if (!span) {
    throw new Error(
      `cannot cite unknown section '${section}' in artifact '${artifact.id}'`,
    );
  }
  return { artifactId: artifact.id, section, sha256: sha256(span.text) };
}

/** Normalize text for lenient containment matching. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * A citation ENTAILS a claim only if the cited span (a) hashes to the
 * provenance sha256 (the citation points at real, unaltered text) and
 * (b) actually contains the claim text. This rejects "fake citations":
 * a claim that has an id/quote but is not supported by the span.
 */
export function citationEntailsClaim(
  artifact: Artifact,
  provenance: Provenance,
  claim: string,
): boolean {
  if (provenance.artifactId !== artifact.id) return false;
  const span = artifact.spans.find((s) => s.section === provenance.section);
  if (!span) return false;
  // Provenance hash must match the actual span text (no tampering / staleness).
  if (sha256(span.text) !== provenance.sha256) return false;
  // The span must actually contain the claim (entailment, not mere existence).
  return normalize(span.text).includes(normalize(claim));
}

// Patterns that look like instructions or tool invocations embedded in data.
const INSTRUCTION_PATTERNS: RegExp[] = [
  /ignore (all |the |your )?(previous|prior|above) (instructions|prompts?)/i,
  /disregard (all |the |your )?(previous|prior|above)/i,
  /system prompt/i,
  /you are now/i,
  /\bexec(?:ute)?\s*\(/i,
  /\brun\s+(the\s+)?(following|this)\s+(command|code|tool)/i,
  /<tool_call>/i,
  /\bcall\s+(the\s+)?tool\b/i,
  /```(?:tool|shell|bash|sh)/i,
];

/** Detect instruction/tool-like strings inside a span (does NOT execute them). */
export function detectInstructionStrings(text: string): string[] {
  const hits: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (INSTRUCTION_PATTERNS.some((re) => re.test(line))) {
      hits.push(line.trim());
    }
  }
  return hits;
}

/** Collect reliability signals from an artifact's metadata and spans. */
export function collectReliabilitySignals(artifact: Artifact): ReliabilitySignal[] {
  const signals: ReliabilitySignal[] = [];

  if (artifact.detectedType !== artifact.declaredType) {
    signals.push({
      kind: 'type_mismatch',
      artifactId: artifact.id,
      detail: `declared '${artifact.declaredType}' but detected '${artifact.detectedType}'`,
      // Obscured content-type weakens malware/sandbox classification
      // (polyglot/embedded-file attacks) -> request the original.
      recommendation: 'request_original',
    });
  }

  if (artifact.activeContentDisarmed) {
    signals.push({
      kind: 'disarmed_active_content',
      artifactId: artifact.id,
      detail: 'active content (macros/scripts/embedded execs) was disarmed',
      recommendation: 'flag_only',
    });
  }

  if (artifact.truncated) {
    signals.push({
      kind: 'truncation',
      artifactId: artifact.id,
      detail: 'extraction was truncated; some content is missing',
      recommendation: 'request_original',
    });
  }

  for (const span of artifact.spans) {
    if (
      typeof span.ocrConfidence === 'number' &&
      span.ocrConfidence < LOW_OCR_CONFIDENCE_THRESHOLD
    ) {
      signals.push({
        kind: 'low_ocr_confidence',
        artifactId: artifact.id,
        detail: `section '${span.section}' OCR confidence ${span.ocrConfidence.toFixed(2)} below threshold`,
        // OCR confidence is an imperfect proxy: cross-check, never hard-reject.
        recommendation: 'cross_check',
      });
    }
  }

  return signals;
}

export interface DraftClaim {
  claim: string;
  provenance: Provenance;
}

/**
 * Ground a set of draft claims against artifacts. Claims whose citation does
 * not entail them are moved to `unsupportedClaims` (they must be cross-checked
 * or the original requested), never emitted as grounded. Instruction-like
 * strings across all artifacts are surfaced as inert reported data.
 */
export function groundClaims(
  artifacts: Artifact[],
  drafts: DraftClaim[],
): GroundingResult {
  const byId = new Map(artifacts.map((a) => [a.id, a]));

  const claims: GroundedClaim[] = [];
  const unsupportedClaims: string[] = [];

  for (const d of drafts) {
    const artifact = byId.get(d.provenance.artifactId);
    const supported = artifact
      ? citationEntailsClaim(artifact, d.provenance, d.claim)
      : false;
    if (supported) {
      claims.push({ claim: d.claim, provenance: d.provenance, supported: true });
    } else {
      unsupportedClaims.push(d.claim);
    }
  }

  const signals: ReliabilitySignal[] = [];
  const reportedInstructions: ReportedInstructionString[] = [];

  for (const artifact of artifacts) {
    signals.push(...collectReliabilitySignals(artifact));
    for (const span of artifact.spans) {
      for (const text of detectInstructionStrings(span.text)) {
        reportedInstructions.push({
          artifactId: artifact.id,
          section: span.section,
          text,
          executed: false,
        });
      }
    }
  }

  return { claims, signals, reportedInstructions, unsupportedClaims };
}

/**
 * Enforce the memory boundary: any artifact-derived text written to long-term
 * memory keeps an untrusted/quarantined trust label and provenance, so it can
 * never regain system-prompt-level (trusted) authority when re-injected.
 */
export interface MemoryRecord {
  text: string;
  provenance: Provenance;
  trust: TrustLabel;
  /** artifact-derived content is data, never executable instruction */
  isInstruction: false;
}

export function toMemoryRecord(
  artifact: Artifact,
  section: string,
): MemoryRecord {
  const span = artifact.spans.find((s) => s.section === section);
  if (!span) {
    throw new Error(
      `cannot persist unknown section '${section}' in artifact '${artifact.id}'`,
    );
  }
  const trust: TrustLabel =
    artifact.trust === 'trusted' ? 'untrusted' : artifact.trust;
  return {
    text: span.text,
    provenance: makeProvenance(artifact, section),
    trust,
    isInstruction: false,
  };
}
