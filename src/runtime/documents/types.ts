export type DocumentFormat = 'pdf' | 'xlsx';

export type ValueType = 'number' | 'string' | 'boolean' | 'date' | 'error' | 'empty';

export interface ParserIdentity {
  id: string;
  version: string;
  options: Record<string, unknown>;
}

export interface InclusiveCaps {
  maxInputBytes: number;
  maxDecompressedBytes: number;
  maxPages: number;
  maxCellsParsed: number;
  maxSheets: number;
  pdfWindowCodePoints: number;
  xlsxMaxCellsDefault: number;
  xlsxMaxCellsHard: number;
  maxStoredOutputBytes: number;
  parseTimeoutMs: number;
}

export const DEFAULT_DOCUMENT_CAPS: InclusiveCaps = {
  maxInputBytes: 64 * 1024 * 1024,
  maxDecompressedBytes: 256 * 1024 * 1024,
  maxPages: 2000,
  maxCellsParsed: 1_000_000,
  maxSheets: 128,
  pdfWindowCodePoints: 2000,
  xlsxMaxCellsDefault: 256,
  xlsxMaxCellsHard: 4096,
  maxStoredOutputBytes: 64 * 1024,
  parseTimeoutMs: 60_000,
};

export const HARD_DOCUMENT_CAPS: InclusiveCaps = {
  maxInputBytes: 256 * 1024 * 1024,
  maxDecompressedBytes: 1024 * 1024 * 1024,
  maxPages: 10000,
  maxCellsParsed: 10_000_000,
  maxSheets: 256,
  pdfWindowCodePoints: 2000,
  xlsxMaxCellsDefault: 256,
  xlsxMaxCellsHard: 4096,
  maxStoredOutputBytes: 256 * 1024,
  parseTimeoutMs: 300_000,
};

export type DocumentWarningCode =
  | 'encrypted'
  | 'missing_text'
  | 'unsupported_feature'
  | 'truncated_extraction'
  | 'cache_missing';

export type DocumentRefusalCode =
  | 'artifact_not_authorized'
  | 'document_tools_unavailable'
  | 'input_too_large'
  | 'span_too_large'
  | 'range_too_large'
  | 'target_too_large'
  | 'decompression_limit'
  | 'timeout';

export interface DocumentWarning {
  code: DocumentWarningCode;
  message: string;
}

export interface PDFTarget {
  kind: 'pdf';
  page: number;
  char_start?: number;
  char_end?: number;
}

export interface XLSXTarget {
  kind: 'xlsx';
  sheet: string;
  cell_range: string;
  max_cells?: number;
}

export type DocumentTarget = PDFTarget | XLSXTarget;

export interface DocumentItem {
  page?: number;
  sheet?: string;
  coordinate: string;
  kind: 'text' | 'cell';
  text?: string;
  value?: unknown;
  value_type?: ValueType;
  formula?: string;
  cached_value?: unknown;
  cached_type?: ValueType;
}

export interface DocumentObservation {
  ok: boolean;
  artifact_id: string;
  extraction_id: string;
  format: DocumentFormat;
  page_count?: number;
  sheets?: Array<{ name: string; dimension?: string; used_range?: string }>;
  sheet_elided_count: number;
  warnings: DocumentWarning[];
  items?: DocumentItem[];
  complete: boolean;
  next_char_start?: number;
  started?: boolean;
  reason?: DocumentRefusalCode;
}

export interface ParserPort {
  inspect(artifactId: string): Promise<DocumentObservation>;
  read(artifactId: string, target: DocumentTarget): Promise<DocumentObservation>;
}

export interface DocumentConfig {
  enabled: boolean;
  principalBinding?: string;
  pdf: ParserIdentity;
  xlsx: ParserIdentity;
  caps: InclusiveCaps;
  parserPort: ParserPort;
  artifactInputPath?: string;
}
