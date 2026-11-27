import { describe, it, expect, vi } from 'vitest';
import {
  DocumentUnderstandingCapability,
  computeExtractionId,
  parseA1Range,
  validatePDFTarget,
  validateXLSXTarget,
  validateInputSize,
  validateStoredOutputSize,
  validateStartupConfig,
} from '../cap_document_understanding_69';
import {
  DEFAULT_DOCUMENT_CAPS,
  HARD_DOCUMENT_CAPS,
  DocumentObservation,
  DocumentTarget,
} from '../../runtime/documents/types';

describe('document understanding 69 constants', () => {
  it('exposes bounded inclusive caps', () => {
    expect(DEFAULT_DOCUMENT_CAPS.maxInputBytes).toBe(64 * 1024 * 1024);
    expect(DEFAULT_DOCUMENT_CAPS.maxDecompressedBytes).toBe(256 * 1024 * 1024);
    expect(DEFAULT_DOCUMENT_CAPS.maxPages).toBe(2000);
    expect(DEFAULT_DOCUMENT_CAPS.maxCellsParsed).toBe(1_000_000);
    expect(DEFAULT_DOCUMENT_CAPS.maxSheets).toBe(128);
    expect(DEFAULT_DOCUMENT_CAPS.pdfWindowCodePoints).toBe(2000);
    expect(DEFAULT_DOCUMENT_CAPS.xlsxMaxCellsDefault).toBe(256);
    expect(DEFAULT_DOCUMENT_CAPS.xlsxMaxCellsHard).toBe(4096);
    expect(DEFAULT_DOCUMENT_CAPS.maxStoredOutputBytes).toBe(64 * 1024);
    expect(DEFAULT_DOCUMENT_CAPS.parseTimeoutMs).toBe(60_000);

    expect(HARD_DOCUMENT_CAPS.maxInputBytes).toBe(256 * 1024 * 1024);
    expect(HARD_DOCUMENT_CAPS.maxDecompressedBytes).toBe(1024 * 1024 * 1024);
    expect(HARD_DOCUMENT_CAPS.maxPages).toBe(10000);
    expect(HARD_DOCUMENT_CAPS.maxCellsParsed).toBe(10_000_000);
    expect(HARD_DOCUMENT_CAPS.maxSheets).toBe(256);
    expect(HARD_DOCUMENT_CAPS.maxStoredOutputBytes).toBe(256 * 1024);
    expect(HARD_DOCUMENT_CAPS.parseTimeoutMs).toBe(300_000);
  });
});

describe('extraction id', () => {
  it('is sha256 of artifact sha, parser identity, version, and canonical options', () => {
    const id1 = computeExtractionId('abc', 'pypdf', '1.2.3', { a: 1, b: 2 });
    const id2 = computeExtractionId('abc', 'pypdf', '1.2.3', { b: 2, a: 1 });
    const id3 = computeExtractionId('def', 'pypdf', '1.2.3', { a: 1, b: 2 });
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('A1 range parsing', () => {
  it('parses bounded ranges and rejects whole columns/rows', () => {
    expect(parseA1Range('A1:B2')).toEqual({ rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 2, cellCount: 4 });
    expect(parseA1Range('A:A')).toBeNull();
    expect(parseA1Range('1:1')).toBeNull();
    expect(parseA1Range('A1')).toBeNull();
    expect(parseA1Range('A1:B')).toBeNull();
  });
});

describe('target validation', () => {
  it('rejects PDF spans over 2000 code points', () => {
    const target: DocumentTarget & { kind: 'pdf' } = { kind: 'pdf', page: 1, char_start: 0, char_end: 2001 };
    const result = validatePDFTarget(target, 10, DEFAULT_DOCUMENT_CAPS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('span_too_large');
  });

  it('rejects out-of-range PDF pages', () => {
    const result = validatePDFTarget({ kind: 'pdf', page: 11 }, 10, DEFAULT_DOCUMENT_CAPS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('target_too_large');
  });

  it('rejects omitted or unbounded XLSX ranges', () => {
    const noRange = validateXLSXTarget({ kind: 'xlsx', sheet: 'Sheet1', cell_range: '' }, DEFAULT_DOCUMENT_CAPS);
    expect(noRange.ok).toBe(false);
    if (!noRange.ok) expect(noRange.code).toBe('target_too_large');

    const wholeColumn = validateXLSXTarget({ kind: 'xlsx', sheet: 'Sheet1', cell_range: 'A:A' }, DEFAULT_DOCUMENT_CAPS);
    expect(wholeColumn.ok).toBe(false);
    if (!wholeColumn.ok) expect(wholeColumn.code).toBe('target_too_large');
  });

  it('rejects XLSX ranges over the requested cell cap', () => {
    const result = validateXLSXTarget(
      { kind: 'xlsx', sheet: 'Sheet1', cell_range: 'A1:Z100', max_cells: 10 },
      DEFAULT_DOCUMENT_CAPS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('range_too_large');
  });

  it('rejects max_cells over the hard cap', () => {
    const result = validateXLSXTarget(
      { kind: 'xlsx', sheet: 'Sheet1', cell_range: 'A1:B2', max_cells: 5000 },
      DEFAULT_DOCUMENT_CAPS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('range_too_large');
  });

  it('rejects oversized inputs before parsing', () => {
    const result = validateInputSize(DEFAULT_DOCUMENT_CAPS.maxInputBytes + 1, DEFAULT_DOCUMENT_CAPS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_too_large');
  });

  it('rejects stored output over the byte cap', () => {
    const bigObservation: DocumentObservation = {
      ok: true,
      artifact_id: 'a',
      extraction_id: 'x',
      format: 'pdf',
      sheet_elided_count: 0,
      warnings: [],
      items: [{ coordinate: 'x', kind: 'text', text: 'a'.repeat(DEFAULT_DOCUMENT_CAPS.maxStoredOutputBytes + 1) }],
      complete: true,
    };
    const result = validateStoredOutputSize(bigObservation, DEFAULT_DOCUMENT_CAPS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('target_too_large');
  });
});

describe('DocumentUnderstandingCapability', () => {
  const makeConfig = () => ({
    enabled: true,
    pdf: { id: 'pypdf', version: '1.0.0', options: { mode: 'text' } },
    xlsx: { id: 'openpyxl', version: '3.1.0', options: { read_only: true } },
    caps: DEFAULT_DOCUMENT_CAPS,
    parserPort: {
      inspect: vi.fn(async () => ({
        ok: true,
        artifact_id: 'a',
        extraction_id: '',
        format: 'pdf' as const,
        page_count: 2,
        sheet_elided_count: 0,
        warnings: [],
        complete: true,
      })),
      read: vi.fn(async () => ({
        ok: true,
        artifact_id: 'a',
        extraction_id: '',
        format: 'pdf' as const,
        sheet_elided_count: 0,
        warnings: [],
        items: [
          { page: 1, coordinate: '0-10', kind: 'text' as const, text: 'hello' },
        ],
        complete: true,
      })),
    },
    artifactInputPath: '/tmp/docs',
  });

  it('inspects and stores a bounded observation', async () => {
    const config = makeConfig();
    const manifest = {
      has: vi.fn(() => true),
      get: vi.fn(() => ({ id: 'a', sha256: 'abc', size: 100 })),
    };
    const store = { store: vi.fn() };
    const evidence = { registerCitation: vi.fn() };
    const cap = new DocumentUnderstandingCapability({
      config,
      inputManifest: manifest,
      observationStore: store,
      evidenceValidator: evidence,
      clock: { now: () => 0 },
    });

    const obs = await cap.inspect('a');
    expect(obs.ok).toBe(true);
    expect(obs.started).toBe(true);
    expect(obs.extraction_id).toMatch(/^[a-f0-9]{64}$/);
    expect(store.store).toHaveBeenCalledTimes(1);
    expect(evidence.registerCitation).not.toHaveBeenCalled();
  });

  it('reads a PDF window and registers a citation', async () => {
    const config = makeConfig();
    const manifest = {
      has: vi.fn(() => true),
      get: vi.fn(() => ({ id: 'a', sha256: 'abc', size: 100 })),
    };
    const store = { store: vi.fn() };
    const evidence = { registerCitation: vi.fn() };
    const cap = new DocumentUnderstandingCapability({
      config,
      inputManifest: manifest,
      observationStore: store,
      evidenceValidator: evidence,
      clock: { now: () => 0 },
    });

    const obs = await cap.read('a', { kind: 'pdf', page: 1, char_start: 0, char_end: 20 }, 'call-1');
    expect(obs.ok).toBe(true);
    expect(store.store).toHaveBeenCalledTimes(1);
    expect(evidence.registerCitation).toHaveBeenCalledTimes(1);
    const citation = evidence.registerCitation.mock.calls[0][0];
    expect(citation).toMatchObject({
      call_id: 'call-1',
      artifact_id: 'a',
      kind: 'pdf',
      page: 1,
      char_start: 0,
      char_end: 20,
    });
    expect(citation.extraction_id).toBe(obs.extraction_id);
  });

  it('refuses unknown artifacts without parsing or storing', async () => {
    const config = makeConfig();
    const manifest = {
      has: vi.fn(() => false),
      get: vi.fn(() => undefined),
    };
    const store = { store: vi.fn() };
    const cap = new DocumentUnderstandingCapability({
      config,
      inputManifest: manifest,
      observationStore: store,
      clock: { now: () => 0 },
    });

    const obs = await cap.inspect('unknown');
    expect(obs.ok).toBe(false);
    expect(obs.started).toBe(false);
    expect(obs.reason).toBe('artifact_not_authorized');
    expect(store.store).not.toHaveBeenCalled();
    expect(config.parserPort.inspect).not.toHaveBeenCalled();
  });

  it('refuses oversized inputs before parser start', async () => {
    const config = makeConfig();
    const manifest = {
      has: vi.fn(() => true),
      get: vi.fn(() => ({ id: 'a', sha256: 'abc', size: DEFAULT_DOCUMENT_CAPS.maxInputBytes + 1 })),
    };
    const store = { store: vi.fn() };
    const cap = new DocumentUnderstandingCapability({
      config,
      inputManifest: manifest,
      observationStore: store,
      clock: { now: () => 0 },
    });

    const obs = await cap.read('a', { kind: 'pdf', page: 1 });
    expect(obs.ok).toBe(false);
    expect(obs.reason).toBe('input_too_large');
    expect(store.store).not.toHaveBeenCalled();
    expect(config.parserPort.read).not.toHaveBeenCalled();
  });

  it('refuses disabled configuration', async () => {
    const config = makeConfig();
    config.enabled = false;
    const manifest = {
      has: vi.fn(() => true),
      get: vi.fn(() => ({ id: 'a', sha256: 'abc', size: 100 })),
    };
    const store = { store: vi.fn() };
    const cap = new DocumentUnderstandingCapability({
      config,
      inputManifest: manifest,
      observationStore: store,
      clock: { now: () => 0 },
    });

    const obs = await cap.inspect('a');
    expect(obs.ok).toBe(false);
    expect(obs.reason).toBe('document_tools_unavailable');
    expect(store.store).not.toHaveBeenCalled();
  });

  it('startup validation requires enabled, path, parser port, and identities', () => {
    const base = makeConfig();
    expect(validateStartupConfig(base).ok).toBe(true);
    expect(validateStartupConfig({ ...base, enabled: false }).ok).toBe(false);
    expect(validateStartupConfig({ ...base, artifactInputPath: undefined }).ok).toBe(false);
    expect(validateStartupConfig({ ...base, parserPort: undefined as unknown as typeof base.parserPort }).ok).toBe(false);
    expect(validateStartupConfig({ ...base, pdf: { ...base.pdf, id: '' } }).ok).toBe(false);
  });
});
