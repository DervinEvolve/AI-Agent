/**
 * cap_document_understanding_9 — Sandboxed document and artifact ingestion, parsing, and extraction.
 *
 * Host-controller adapter layer (TypeScript). The heavy parsing runs in the
 * isolated run_python-class sandbox (docparse/*.py); this module implements the
 * trust/security contract enforced by the controller BEFORE and AFTER dispatch:
 *
 *   sniff -> disarm -> sandboxed parse -> taint + provenance -> cap output
 *
 * Every output is tainted evidence with provenance and is never treated as an
 * instruction. Mirrors the taint contract established by cap_browser_automation_8.
 */

export type DocAction =
  | 'ingest'
  | 'parse'
  | 'ocr'
  | 'extract'
  | 'summarize'
  | 'list_manifest';

export type DocStatus =
  | 'ok'
  | 'failed'
  | 'policy_blocked'
  | 'budget_exhausted'
  | 'timeout'
  | 'quarantined';

export const DEFAULT_MAX_OUTPUT_BYTES = 262144;
export const HARD_MAX_OUTPUT_BYTES = 1048576;

// Independent decompression caps (must all be enforced, per zip-bomb research).
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MiB
export const DEFAULT_MAX_EXPANSION_RATIO = 200; // absolute + ratio, not depth-only
export const DEFAULT_MAX_ARCHIVE_ENTRIES = 4096;
export const DEFAULT_MAX_NESTING_DEPTH = 8;

// Active-content classes stripped by the CDR layer.
export const ACTIVE_CONTENT_CLASSES = [
  'javascript',
  'openaction',
  'launch',
  'xfa',
  'embedded_file',
  'macro',
  'ole',
  'dde',
  'remote_template',
  'event_handler',
  'external_reference',
] as const;
export type ActiveContentClass = (typeof ACTIVE_CONTENT_CLASSES)[number];

// XML-defense exception names mirror defusedxml exactly.
export type XmlDefenseException =
  | 'DTDForbidden'
  | 'EntitiesForbidden'
  | 'ExternalReferenceForbidden';

export interface DocParseInput {
  action: DocAction;
  artifact_ref: string;
  declared_mime?: string;
  extraction_schema?: Record<string, unknown>;
  ocr?: { enabled?: boolean; languages?: string[]; pages?: number[] };
  page_range?: { start: number; end: number };
  archive_options?: {
    list_only?: boolean;
    allow_extract?: boolean;
    max_entries?: number;
  };
  max_output_bytes?: number;
}

export interface DetectedType {
  mime: string;
  magic_verified: boolean;
  mismatch_with_declared: boolean;
}

export interface ManifestEntry {
  entry_name: string;
  size: number;
  ratio: number;
  entry_type: string;
  skipped_reason?: string;
}

export interface Provenance {
  source_ref: string;
  sha256: string;
  ingest_timestamp: string;
  parser: string;
  parser_version: string;
  action_trace: string[];
  page_refs?: number[];
}

export interface DerivedArtifact {
  artifact_id: string;
  type: string;
  bytes: number;
}

export interface DisarmReport {
  active_content_removed: string[];
  external_refs_blocked: number;
}

export interface DocParseError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface DocParseResult {
  status: DocStatus;
  error?: DocParseError;
  detected_type?: DetectedType;
  content?: Record<string, unknown>;
  extracted_fields?: Record<string, unknown>;
  manifest?: ManifestEntry[];
  artifacts: DerivedArtifact[];
  provenance?: Provenance;
  tainted: true;
  truncated: boolean;
  disarmed: DisarmReport;
}

/** Reservation the adapter atomically claims from the unified BudgetTracker. */
export interface BudgetReservation {
  cpu_ms: number;
  wall_ms: number;
  memory_bytes: number;
  pages: number;
  jobs: number;
}

/** Minimal shape of the unified BudgetTracker (cap_subagent_orchestration_5). */
export interface BudgetLike {
  reserve(r: BudgetReservation): { ok: boolean; reason?: string };
  release(r: BudgetReservation): void;
}

/** Minimal shape of the isolated sandbox backend (con_exec_isolation_1). */
export interface SandboxBackend {
  /** Runs a parser module in-sandbox with deny-by-default egress. */
  runParser(job: SandboxJob): Promise<SandboxResult>;
}

export interface SandboxJob {
  module: string;
  artifact_bytes: Uint8Array;
  detected_type: DetectedType;
  page_range?: { start: number; end: number };
  extraction_schema?: Record<string, unknown>;
  ocr?: { enabled?: boolean; languages?: string[]; pages?: number[] };
  archive_options?: DocParseInput['archive_options'];
  egress: 'deny';
  host_fs: false;
}

export interface SandboxResult {
  status: DocStatus;
  content?: Record<string, unknown>;
  extracted_fields?: Record<string, unknown>;
  manifest?: ManifestEntry[];
  artifacts?: DerivedArtifact[];
  disarmed?: DisarmReport;
  parser: string;
  parser_version: string;
  error?: DocParseError;
}

/** Task-scoped artifact store; resolves only task artifact ids, never host paths. */
export interface ArtifactStore {
  resolve(artifact_ref: string): { bytes: Uint8Array; declared_mime?: string } | null;
}

export class DocumentParseError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
    this.name = 'DocumentParseError';
  }
}

/**
 * artifact_ref must be a task-scoped id, never a host path / file:// URL / traversal.
 */
export function isValidArtifactRef(ref: unknown): ref is string {
  if (typeof ref !== 'string' || ref.length === 0) return false;
  const lowered = ref.toLowerCase();
  if (lowered.startsWith('file:')) return false;
  if (lowered.includes('://')) return false;
  if (ref.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(ref)) return false;
  if (ref.includes('..')) return false;
  if (ref.includes('\0')) return false;
  // task-scoped ids: alnum, dash, underscore, dot (no path separators).
  return /^[A-Za-z0-9._-]+$/.test(ref);
}

/** Archive entry names must not escape the sandbox artifact area. */
export function isSafeArchiveEntry(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(name)) return false; // absolute
  if (name.includes('\0')) return false;
  const parts = name.split(/[\\/]/);
  if (parts.some((p) => p === '..')) return false; // traversal
  return true;
}

/** Enforce independent decompression caps (ratio + absolute + entries). */
export function checkDecompressionCaps(opts: {
  compressedBytes: number;
  decompressedBytes: number;
  entries: number;
  nestingDepth?: number;
  maxDecompressedBytes?: number;
  maxRatio?: number;
  maxEntries?: number;
  maxDepth?: number;
}): { ok: boolean; reason?: string } {
  const maxBytes = opts.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;
  const maxRatio = opts.maxRatio ?? DEFAULT_MAX_EXPANSION_RATIO;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ARCHIVE_ENTRIES;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_NESTING_DEPTH;

  if (opts.decompressedBytes > maxBytes) {
    return { ok: false, reason: 'absolute_decompressed_size_exceeded' };
  }
  if (opts.entries > maxEntries) {
    return { ok: false, reason: 'entry_count_exceeded' };
  }
  if ((opts.nestingDepth ?? 0) > maxDepth) {
    return { ok: false, reason: 'nesting_depth_exceeded' };
  }
  // Ratio cap catches non-recursive high-ratio bombs (Fifield).
  if (opts.compressedBytes > 0) {
    const ratio = opts.decompressedBytes / opts.compressedBytes;
    if (ratio > maxRatio) {
      return { ok: false, reason: 'expansion_ratio_exceeded' };
    }
  }
  return { ok: true };
}

function clampOutputBytes(requested?: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_MAX_OUTPUT_BYTES;
  }
  return Math.min(Math.floor(requested), HARD_MAX_OUTPUT_BYTES);
}

function approxByteLength(value: unknown): number {
  if (value == null) return 0;
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  // UTF-8 byte length estimate.
  let bytes = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

export interface DocumentParseAdapterDeps {
  store: ArtifactStore;
  sandbox: SandboxBackend;
  budget: BudgetLike;
  sniff: (bytes: Uint8Array) => { mime: string; magic_verified: boolean };
  sha256: (bytes: Uint8Array) => string;
  now?: () => Date;
  /** Caller context: only the host controller may invoke document_parse. */
  caller?: 'host_controller' | 'run_python' | 'custom_tool' | string;
}

function moduleForType(mime: string): string {
  if (mime === 'application/pdf') return 'docparse/parsers/pdf_parser.py';
  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime === 'application/msword' ||
    mime.startsWith('application/vnd.ms-') ||
    mime.startsWith('application/vnd.openxmlformats-officedocument')
  )
    return 'docparse/parsers/office_parser.py';
  if (mime === 'text/csv' || mime === 'application/vnd.ms-excel')
    return 'docparse/parsers/table_parser.py';
  if (
    mime === 'text/html' ||
    mime === 'application/xml' ||
    mime === 'text/xml' ||
    mime === 'application/json'
  )
    return 'docparse/parsers/xml_html_parser.py';
  if (
    mime === 'application/zip' ||
    mime === 'application/x-tar' ||
    mime === 'application/gzip' ||
    mime === 'application/x-gzip'
  )
    return 'docparse/parsers/archive_parser.py';
  if (mime.startsWith('image/')) return 'docparse/ocr_worker.py';
  return 'docparse/parsers/xml_html_parser.py';
}

function reservationFor(action: DocAction, pages: number): BudgetReservation {
  const base: BudgetReservation = {
    cpu_ms: 5000,
    wall_ms: 15000,
    memory_bytes: 256 * 1024 * 1024,
    pages: Math.max(1, pages),
    jobs: 1,
  };
  if (action === 'ocr') {
    base.cpu_ms = 20000;
    base.wall_ms = 60000;
    base.memory_bytes = 512 * 1024 * 1024;
  }
  return base;
}

/**
 * The host-controller adapter. Orchestrates the security contract; delegates the
 * actual byte-level parsing to the sandbox backend.
 */
export class DocumentParseAdapter {
  constructor(private deps: DocumentParseAdapterDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  async run(input: DocParseInput): Promise<DocParseResult> {
    const emptyDisarm: DisarmReport = {
      active_content_removed: [],
      external_refs_blocked: 0,
    };

    // document_parse is host-controller only.
    const caller = this.deps.caller ?? 'host_controller';
    if (caller !== 'host_controller') {
      return {
        status: 'policy_blocked',
        error: {
          code: 'caller_not_permitted',
          message: 'document_parse is host-controller only',
          retryable: false,
        },
        tainted: true,
        truncated: false,
        artifacts: [],
        disarmed: emptyDisarm,
      };
    }

    // artifact_ref must be a task-scoped id.
    if (!isValidArtifactRef(input.artifact_ref)) {
      return {
        status: 'policy_blocked',
        error: {
          code: 'invalid_artifact_ref',
          message: 'artifact_ref must be a task-scoped artifact id, not a host path',
          retryable: false,
        },
        tainted: true,
        truncated: false,
        artifacts: [],
        disarmed: emptyDisarm,
      };
    }

    const resolved = this.deps.store.resolve(input.artifact_ref);
    if (!resolved) {
      return {
        status: 'failed',
        error: {
          code: 'artifact_not_found',
          message: 'artifact_ref did not resolve within the task-scoped store',
          retryable: false,
        },
        tainted: true,
        truncated: false,
        artifacts: [],
        disarmed: emptyDisarm,
      };
    }

    // Sniff: content is authoritative, declared_mime is only a hint.
    const sniffed = this.deps.sniff(resolved.bytes);
    const declared = input.declared_mime ?? resolved.declared_mime;
    const detected_type: DetectedType = {
      mime: sniffed.mime,
      magic_verified: sniffed.magic_verified,
      mismatch_with_declared:
        declared != null && declared.length > 0 && declared !== sniffed.mime,
    };

    const sha256 = this.deps.sha256(resolved.bytes);
    const action_trace: string[] = [`ingest:${input.artifact_ref}`, `sniff:${sniffed.mime}`];

    if (input.action === 'ingest') {
      return {
        status: 'ok',
        detected_type,
        provenance: {
          source_ref: input.artifact_ref,
          sha256,
          ingest_timestamp: this.now().toISOString(),
          parser: 'quarantine',
          parser_version: '1',
          action_trace,
        },
        tainted: true,
        truncated: false,
        artifacts: [],
        disarmed: emptyDisarm,
      };
    }

    // Budget reservation is atomic and precedes dispatch.
    const pages =
      input.page_range && input.page_range.end >= input.page_range.start
        ? input.page_range.end - input.page_range.start + 1
        : 1;
    const reservation = reservationFor(input.action, pages);
    const claim = this.deps.budget.reserve(reservation);
    if (!claim.ok) {
      return {
        status: 'budget_exhausted',
        error: {
          code: 'budget_exhausted',
          message: claim.reason ?? 'insufficient budget for parse job',
          retryable: true,
        },
        detected_type,
        tainted: true,
        truncated: false,
        artifacts: [],
        disarmed: emptyDisarm,
      };
    }

    try {
      const module = moduleForType(sniffed.mime);
      action_trace.push(`dispatch:${module}`);

      const job: SandboxJob = {
        module,
        artifact_bytes: resolved.bytes,
        detected_type,
        page_range: input.page_range,
        extraction_schema: input.action === 'extract' ? input.extraction_schema : undefined,
        ocr: input.action === 'ocr' ? input.ocr : undefined,
        archive_options: input.archive_options,
        egress: 'deny',
        host_fs: false,
      };

      const sr = await this.deps.sandbox.runParser(job);
      action_trace.push(`parsed:${sr.parser}@${sr.parser_version}`);

      const disarmed: DisarmReport = sr.disarmed ?? emptyDisarm;

      if (sr.status !== 'ok') {
        return {
          status: sr.status,
          error: sr.error,
          detected_type,
          manifest: sr.manifest,
          provenance: {
            source_ref: input.artifact_ref,
            sha256,
            ingest_timestamp: this.now().toISOString(),
            parser: sr.parser,
            parser_version: sr.parser_version,
            action_trace,
          },
          tainted: true,
          truncated: false,
          artifacts: sr.artifacts ?? [],
          disarmed,
        };
      }

      // Cap output.
      const cap = clampOutputBytes(input.max_output_bytes);
      let truncated = false;
      let content = sr.content;
      if (content != null && approxByteLength(content) > cap) {
        truncated = true;
        content = this.truncateContent(content, cap);
      }

      return {
        status: 'ok',
        detected_type,
        content,
        extracted_fields: sr.extracted_fields,
        manifest: sr.manifest,
        artifacts: sr.artifacts ?? [],
        provenance: {
          source_ref: input.artifact_ref,
          sha256,
          ingest_timestamp: this.now().toISOString(),
          parser: sr.parser,
          parser_version: sr.parser_version,
          action_trace,
          page_refs: input.page_range
            ? Array.from(
                { length: pages },
                (_v, i) => (input.page_range as { start: number }).start + i,
              )
            : undefined,
        },
        tainted: true,
        truncated,
        disarmed,
      };
    } finally {
      this.deps.budget.release(reservation);
    }
  }

  private truncateContent(
    content: Record<string, unknown>,
    cap: number,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    let used = 0;
    for (const [k, v] of Object.entries(content)) {
      if (typeof v === 'string') {
        const remaining = cap - used;
        if (remaining <= 0) break;
        const slice = v.slice(0, Math.max(0, remaining));
        out[k] = slice;
        used += approxByteLength(slice);
      } else {
        const sz = approxByteLength(v);
        if (used + sz > cap) break;
        out[k] = v;
        used += sz;
      }
    }
    return out;
  }
}

/**
 * Taint contract helper: tainted document content is EVIDENCE, not INSTRUCTION.
 * It may inform reasoning but must never directly set tool params, egress
 * targets, navigation URLs, side-effecting custom-tool inputs, or sub-agent
 * goals without independent validation. Mirrors cap_browser_automation_8.
 */
export function canControlFromTaintedDocument(): false {
  return false;
}

/**
 * Promotion of extracted content to long-term memory must pass content_policy,
 * PII/secret redaction, and scope authorization (cap_long_term_memory_3).
 * Extraction-schema conformance never clears taint.
 */
export function schemaConformanceClearsTaint(): false {
  return false;
}
