import { createHash } from 'node:crypto';
import {
  DocumentConfig,
  DocumentObservation,
  DocumentRefusalCode,
  DocumentTarget,
  InclusiveCaps,
  ParserPort,
} from '../runtime/documents/types';

export const DOCUMENT_CAPABILITY_ID = 'cap_document_understanding_69';

export interface InputManifest {
  has(artifactId: string): boolean;
  get(artifactId: string): { id: string; sha256?: string; size?: number } | undefined;
}

export interface ObservationStore {
  store(observation: DocumentObservation): void;
}

export interface DocumentCitation {
  call_id: string;
  artifact_id: string;
  extraction_id: string;
  kind: 'pdf' | 'xlsx';
  page?: number;
  sheet?: string;
  coordinate?: string;
  char_start?: number;
  char_end?: number;
}

export interface EvidenceValidator {
  registerCitation?(citation: DocumentCitation): void;
}

export interface Finalizer {
  confirmTerminationAndCleanup?(callId: string): void;
}

export interface Clock {
  now(): number;
}

export interface DocumentUnderstandingDeps {
  config: DocumentConfig;
  inputManifest: InputManifest;
  observationStore: ObservationStore;
  evidenceValidator?: EvidenceValidator;
  finalizer?: Finalizer;
  clock?: Clock;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`);
  return `{${parts.join(',')}}`;
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function computeExtractionId(
  artifactSha256: string,
  parserId: string,
  parserVersion: string,
  parserOptions: Record<string, unknown>,
): string {
  const canonicalOptions = stableStringify(parserOptions);
  const raw = `${artifactSha256}:${parserId}:${parserVersion}:${canonicalOptions}`;
  return sha256(raw);
}

function columnLetterToNumber(letters: string): number {
  let result = 0;
  for (const char of letters.toUpperCase()) {
    result = result * 26 + (char.charCodeAt(0) - 64);
  }
  return result;
}

export interface A1Range {
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
  cellCount: number;
}

export function parseA1Range(range: string): A1Range | null {
  const match = /^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/.exec(range.trim());
  if (!match) return null;
  const colStart = columnLetterToNumber(match[1]);
  const rowStart = Number(match[2]);
  const colEnd = columnLetterToNumber(match[3]);
  const rowEnd = Number(match[4]);
  if (rowStart < 1 || rowEnd < 1 || colStart < 1 || colEnd < 1) return null;
  if (rowStart > rowEnd || colStart > colEnd) return null;
  const rows = rowEnd - rowStart + 1;
  const cols = colEnd - colStart + 1;
  return { rowStart, rowEnd, colStart, colEnd, cellCount: rows * cols };
}

export type TargetValidation =
  | { ok: true }
  | { ok: false; code: DocumentRefusalCode; message: string };

export function validatePDFTarget(
  target: DocumentTarget & { kind: 'pdf' },
  pageCount: number,
  caps: InclusiveCaps,
): TargetValidation {
  if (target.page < 1 || target.page > pageCount) {
    return { ok: false, code: 'target_too_large', message: `Page ${target.page} is outside 1..${pageCount}` };
  }
  const start = target.char_start ?? 0;
  const end = target.char_end ?? start + caps.pdfWindowCodePoints;
  if (start < 0 || end < start) {
    return { ok: false, code: 'target_too_large', message: 'Invalid character offsets' };
  }
  if (end - start > caps.pdfWindowCodePoints) {
    return { ok: false, code: 'span_too_large', message: `PDF window exceeds ${caps.pdfWindowCodePoints} code points` };
  }
  return { ok: true };
}

export function validateXLSXTarget(
  target: DocumentTarget & { kind: 'xlsx' },
  caps: InclusiveCaps,
): TargetValidation {
  if (!target.sheet || typeof target.sheet !== 'string' || target.sheet.trim().length === 0) {
    return { ok: false, code: 'target_too_large', message: 'XLSX target requires a sheet name' };
  }
  if (!target.cell_range || typeof target.cell_range !== 'string' || target.cell_range.trim().length === 0) {
    return { ok: false, code: 'target_too_large', message: 'XLSX target requires a bounded cell range' };
  }
  const range = parseA1Range(target.cell_range);
  if (!range) {
    return { ok: false, code: 'target_too_large', message: `Invalid or unbounded cell range: ${target.cell_range}` };
  }
  const requestedMax = target.max_cells ?? caps.xlsxMaxCellsDefault;
  if (requestedMax > caps.xlsxMaxCellsHard) {
    return { ok: false, code: 'range_too_large', message: `Requested max_cells ${requestedMax} exceeds hard cap ${caps.xlsxMaxCellsHard}` };
  }
  if (range.cellCount > requestedMax || range.cellCount > caps.xlsxMaxCellsHard) {
    return { ok: false, code: 'range_too_large', message: `Cell range ${target.cell_range} contains ${range.cellCount} cells, exceeding cap` };
  }
  return { ok: true };
}

export function validateInputSize(size: number | undefined, caps: InclusiveCaps): TargetValidation {
  if (size !== undefined && size > caps.maxInputBytes) {
    return { ok: false, code: 'input_too_large', message: `Input size ${size} exceeds ${caps.maxInputBytes} bytes` };
  }
  return { ok: true };
}

export function validateStoredOutputSize(observation: DocumentObservation, caps: InclusiveCaps): TargetValidation {
  const size = Buffer.byteLength(JSON.stringify(observation), 'utf8');
  if (size > caps.maxStoredOutputBytes) {
    return { ok: false, code: 'target_too_large', message: `Stored output ${size} bytes exceeds ${caps.maxStoredOutputBytes}` };
  }
  return { ok: true };
}

export function validateStartupConfig(config: DocumentConfig): { ok: boolean; reason?: string } {
  if (!config.enabled) {
    return { ok: false, reason: 'document_tools_unavailable' };
  }
  if (!config.artifactInputPath) {
    return { ok: false, reason: 'document_tools_unavailable' };
  }
  if (!config.parserPort) {
    return { ok: false, reason: 'document_tools_unavailable' };
  }
  if (!config.pdf?.id || !config.pdf?.version) {
    return { ok: false, reason: 'document_tools_unavailable' };
  }
  if (!config.xlsx?.id || !config.xlsx?.version) {
    return { ok: false, reason: 'document_tools_unavailable' };
  }
  return { ok: true };
}

export class DocumentUnderstandingCapability {
  private readonly config: DocumentConfig;
  private readonly inputManifest: InputManifest;
  private readonly observationStore: ObservationStore;
  private readonly evidenceValidator?: EvidenceValidator;
  private readonly finalizer?: Finalizer;
  private readonly clock?: Clock;

  constructor(deps: DocumentUnderstandingDeps) {
    this.config = deps.config;
    this.inputManifest = deps.inputManifest;
    this.observationStore = deps.observationStore;
    this.evidenceValidator = deps.evidenceValidator;
    this.finalizer = deps.finalizer;
    this.clock = deps.clock;
  }

  private refusal(
    artifactId: string,
    code: DocumentRefusalCode,
    message: string,
  ): DocumentObservation {
    return {
      ok: false,
      started: false,
      artifact_id: artifactId,
      extraction_id: '',
      format: 'pdf',
      sheet_elided_count: 0,
      warnings: [],
      complete: false,
      reason: code,
    };
  }

  private async authorize(artifactId: string): Promise<
    | { ok: true; artifact: { id: string; sha256?: string; size?: number } }
    | { ok: false; observation: DocumentObservation }
  > {
    const startup = validateStartupConfig(this.config);
    if (!startup.ok) {
      return { ok: false, observation: this.refusal(artifactId, 'document_tools_unavailable', startup.reason ?? 'Document tools unavailable') };
    }
    if (!this.inputManifest.has(artifactId)) {
      return { ok: false, observation: this.refusal(artifactId, 'artifact_not_authorized', 'Artifact not authorized for this principal') };
    }
    const artifact = this.inputManifest.get(artifactId);
    if (!artifact) {
      return { ok: false, observation: this.refusal(artifactId, 'artifact_not_authorized', 'Artifact not authorized for this principal') };
    }
    const sizeCheck = validateInputSize(artifact.size, this.config.caps);
    if (!sizeCheck.ok) {
      return { ok: false, observation: this.refusal(artifactId, sizeCheck.code, sizeCheck.message) };
    }
    return { ok: true, artifact };
  }

  private parserFor(format: 'pdf' | 'xlsx') {
    return format === 'pdf' ? this.config.pdf : this.config.xlsx;
  }

  private ensureExtractionId(observation: DocumentObservation, artifactSha256: string): DocumentObservation {
    if (observation.extraction_id) return observation;
    const parser = this.parserFor(observation.format);
    const extractionId = computeExtractionId(artifactSha256, parser.id, parser.version, parser.options);
    return { ...observation, extraction_id: extractionId };
  }

  async inspect(artifactId: string): Promise<DocumentObservation> {
    const auth = await this.authorize(artifactId);
    if (!auth.ok) return auth.observation;

    const startedAt = this.clock?.now() ?? 0;
    const raw = await this.config.parserPort.inspect(artifactId);
    const observation = this.ensureExtractionId(raw, auth.artifact.sha256 ?? auth.artifact.id);

    const sizeCheck = validateStoredOutputSize(observation, this.config.caps);
    if (!sizeCheck.ok) {
      return this.refusal(artifactId, sizeCheck.code, sizeCheck.message);
    }

    const stored = { ...observation, started: true };
    this.observationStore.store(stored);

    const elapsed = (this.clock?.now() ?? 0) - startedAt;
    if (elapsed > this.config.caps.parseTimeoutMs) {
      return this.refusal(artifactId, 'timeout', 'Parser timed out');
    }

    return stored;
  }

  async read(artifactId: string, target: DocumentTarget, callId?: string): Promise<DocumentObservation> {
    const auth = await this.authorize(artifactId);
    if (!auth.ok) return auth.observation;

    if (target.kind === 'pdf') {
      const validation = validatePDFTarget(target, this.config.caps.maxPages, this.config.caps);
      if (!validation.ok) {
        return this.refusal(artifactId, validation.code, validation.message);
      }
    } else if (target.kind === 'xlsx') {
      const validation = validateXLSXTarget(target, this.config.caps);
      if (!validation.ok) {
        return this.refusal(artifactId, validation.code, validation.message);
      }
    } else {
      return this.refusal(artifactId, 'target_too_large', 'Unsupported target kind');
    }

    const startedAt = this.clock?.now() ?? 0;
    const raw = await this.config.parserPort.read(artifactId, target);
    const observation = this.ensureExtractionId(raw, auth.artifact.sha256 ?? auth.artifact.id);

    const sizeCheck = validateStoredOutputSize(observation, this.config.caps);
    if (!sizeCheck.ok) {
      return this.refusal(artifactId, sizeCheck.code, sizeCheck.message);
    }

    const stored = { ...observation, started: true };
    this.observationStore.store(stored);

    if (callId && this.evidenceValidator?.registerCitation) {
      const citation = this.buildCitation(callId, artifactId, stored.extraction_id, target);
      this.evidenceValidator.registerCitation(citation);
    }

    const elapsed = (this.clock?.now() ?? 0) - startedAt;
    if (elapsed > this.config.caps.parseTimeoutMs) {
      return this.refusal(artifactId, 'timeout', 'Parser timed out');
    }

    return stored;
  }

  private buildCitation(
    callId: string,
    artifactId: string,
    extractionId: string,
    target: DocumentTarget,
  ): DocumentCitation {
    const base: DocumentCitation = {
      call_id: callId,
      artifact_id: artifactId,
      extraction_id: extractionId,
      kind: target.kind,
    };
    if (target.kind === 'pdf') {
      base.page = target.page;
      base.char_start = target.char_start ?? 0;
      base.char_end = target.char_end ?? (target.char_start ?? 0) + this.config.caps.pdfWindowCodePoints;
    } else {
      base.sheet = target.sheet;
      base.coordinate = target.cell_range;
    }
    return base;
  }
}

export const documentTools = {
  inspect_document: {
    idempotent: true,
    concurrentSafe: false,
    schema: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string' },
      },
      required: ['artifact_id'],
    },
  },
  read_document: {
    idempotent: true,
    concurrentSafe: false,
    schema: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string' },
        target: {
          oneOf: [
            {
              type: 'object',
              properties: {
                kind: { const: 'pdf' },
                page: { type: 'number' },
                char_start: { type: 'number' },
                char_end: { type: 'number' },
              },
              required: ['kind', 'page'],
            },
            {
              type: 'object',
              properties: {
                kind: { const: 'xlsx' },
                sheet: { type: 'string' },
                cell_range: { type: 'string' },
                max_cells: { type: 'number' },
              },
              required: ['kind', 'sheet', 'cell_range'],
            },
          ],
        },
      },
      required: ['artifact_id', 'target'],
    },
  },
};
