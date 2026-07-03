import { describe, it, expect } from 'vitest';
import {
  DocumentParseAdapter,
  DocParseResult,
  ArtifactStore,
  SandboxBackend,
  SandboxJob,
  SandboxResult,
  BudgetLike,
  BudgetReservation,
  isValidArtifactRef,
  isSafeArchiveEntry,
  checkDecompressionCaps,
  canControlFromTaintedDocument,
  schemaConformanceClearsTaint,
  ACTIVE_CONTENT_CLASSES,
  DEFAULT_MAX_OUTPUT_BYTES,
  HARD_MAX_OUTPUT_BYTES,
} from '../cap_document_understanding_9';

// ---- Test doubles -----------------------------------------------------------

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

class FakeStore implements ArtifactStore {
  constructor(private map: Record<string, { bytes: Uint8Array; declared_mime?: string }>) {}
  resolve(ref: string) {
    return this.map[ref] ?? null;
  }
}

class FakeBudget implements BudgetLike {
  public reserved: BudgetReservation[] = [];
  public released: BudgetReservation[] = [];
  constructor(private allow = true, private reason?: string) {}
  reserve(r: BudgetReservation) {
    if (!this.allow) return { ok: false, reason: this.reason };
    this.reserved.push(r);
    return { ok: true };
  }
  release(r: BudgetReservation) {
    this.released.push(r);
  }
}

class RecordingSandbox implements SandboxBackend {
  public lastJob?: SandboxJob;
  constructor(private result: SandboxResult) {}
  async runParser(job: SandboxJob): Promise<SandboxResult> {
    this.lastJob = job;
    return this.result;
  }
}

function okResult(over: Partial<SandboxResult> = {}): SandboxResult {
  return {
    status: 'ok',
    content: { text: 'hello world' },
    parser: 'test_parser',
    parser_version: '0.0.1',
    disarmed: { active_content_removed: [], external_refs_blocked: 0 },
    ...over,
  };
}

function makeAdapter(opts: {
  store: FakeStore;
  sandbox: SandboxBackend;
  budget?: BudgetLike;
  mime?: string;
  magic_verified?: boolean;
  caller?: string;
}) {
  return new DocumentParseAdapter({
    store: opts.store,
    sandbox: opts.sandbox,
    budget: opts.budget ?? new FakeBudget(),
    sniff: () => ({ mime: opts.mime ?? 'text/plain', magic_verified: opts.magic_verified ?? true }),
    sha256: () => 'deadbeef',
    now: () => new Date('2025-01-01T00:00:00.000Z'),
    caller: opts.caller ?? 'host_controller',
  });
}

// ---- artifact_ref scoping ---------------------------------------------------

describe('artifact_ref scoping', () => {
  it('rejects host paths, file:// URLs, and traversal', () => {
    expect(isValidArtifactRef('/etc/passwd')).toBe(false);
    expect(isValidArtifactRef('file:///etc/passwd')).toBe(false);
    expect(isValidArtifactRef('http://evil/x')).toBe(false);
    expect(isValidArtifactRef('../../secret')).toBe(false);
    expect(isValidArtifactRef('C:\\Windows\\x')).toBe(false);
    expect(isValidArtifactRef('')).toBe(false);
  });
  it('accepts task-scoped artifact ids', () => {
    expect(isValidArtifactRef('artifact_123')).toBe(true);
    expect(isValidArtifactRef('dl-abc.pdf')).toBe(true);
  });
  it('adapter policy-blocks an invalid artifact_ref', async () => {
    const store = new FakeStore({});
    const adapter = makeAdapter({ store, sandbox: new RecordingSandbox(okResult()) });
    const r = await adapter.run({ action: 'parse', artifact_ref: '/etc/passwd' });
    expect(r.status).toBe('policy_blocked');
    expect(r.error?.code).toBe('invalid_artifact_ref');
    expect(r.tainted).toBe(true);
  });
});

// ---- host-controller only ---------------------------------------------------

describe('document_parse is host-controller only', () => {
  it('policy-blocks calls from run_python', async () => {
    const store = new FakeStore({ a: { bytes: bytes('x') } });
    const adapter = makeAdapter({
      store,
      sandbox: new RecordingSandbox(okResult()),
      caller: 'run_python',
    });
    const r = await adapter.run({ action: 'parse', artifact_ref: 'a' });
    expect(r.status).toBe('policy_blocked');
    expect(r.error?.code).toBe('caller_not_permitted');
  });
  it('policy-blocks calls from a custom tool', async () => {
    const store = new FakeStore({ a: { bytes: bytes('x') } });
    const adapter = makeAdapter({
      store,
      sandbox: new RecordingSandbox(okResult()),
      caller: 'custom_tool',
    });
    const r = await adapter.run({ action: 'parse', artifact_ref: 'a' });
    expect(r.status).toBe('policy_blocked');
  });
});

// ---- sniffing over declared_mime --------------------------------------------

describe('content sniffing is authoritative', () => {
  it('reports detected_type and flags declared/detected mismatch', async () => {
    const store = new FakeStore({ a: { bytes: bytes('%PDF-'), declared_mime: 'image/png' } });
    const adapter = makeAdapter({
      store,
      sandbox: new RecordingSandbox(okResult()),
      mime: 'application/pdf',
    });
    const r = await adapter.run({ action: 'ingest', artifact_ref: 'a', declared_mime: 'image/png' });
    expect(r.detected_type?.mime).toBe('application/pdf');
    expect(r.detected_type?.mismatch_with_declared).toBe(true);
    expect(r.detected_type?.magic_verified).toBe(true);
  });
});

// ---- taint always true + provenance ----------------------------------------

describe('taint and provenance', () => {
  it('every result is tainted with provenance (sha256, parser+version)', async () => {
    const store = new FakeStore({ a: { bytes: bytes('x') } });
    const adapter = makeAdapter({ store, sandbox: new RecordingSandbox(okResult()) });
    const r = await adapter.run({ action: 'parse', artifact_ref: 'a' });
    expect(r.tainted).toBe(true);
    expect(r.provenance?.sha256).toBe('deadbeef');
    expect(r.provenance?.parser).toBe('test_parser');
    expect(r.provenance?.parser_version).toBe('0.0.1');
    expect(r.provenance?.source_ref).toBe('a');
  });
  it('tainted document content is evidence, not instruction', () => {
    expect(canControlFromTaintedDocument()).toBe(false);
  });
  it('schema conformance never clears taint', () => {
    expect(schemaConformanceClearsTaint()).toBe(false);
  });
});

// ---- sandbox dispatch contract ----------------------------------------------

describe('sandbox dispatch contract', () => {
  it('dispatches with deny-by-default egress and no host fs', async () => {
    const store = new FakeStore({ a: { bytes: bytes('%PDF-') } });
    const sandbox = new RecordingSandbox(okResult());
    const adapter = makeAdapter({ store, sandbox, mime: 'application/pdf' });
    await adapter.run({ action: 'parse', artifact_ref: 'a' });
    expect(sandbox.lastJob?.egress).toBe('deny');
    expect(sandbox.lastJob?.host_fs).toBe(false);
    expect(sandbox.lastJob?.module).toBe('docparse/parsers/pdf_parser.py');
  });
});

// ---- disarm reporting -------------------------------------------------------

describe('CDR disarm reporting', () => {
  it('surfaces active content removed and external refs blocked', async () => {
    const store = new FakeStore({ a: { bytes: bytes('%PDF-') } });
    const sandbox = new RecordingSandbox(
      okResult({
        disarmed: {
          active_content_removed: ['javascript', 'openaction', 'launch', 'xfa', 'embedded_file'],
          external_refs_blocked: 3,
        },
      }),
    );
    const adapter = makeAdapter({ store, sandbox, mime: 'application/pdf' });
    const r = await adapter.run({ action: 'parse', artifact_ref: 'a' });
    expect(r.disarmed.active_content_removed).toContain('javascript');
    expect(r.disarmed.active_content_removed).toContain('openaction');
    expect(r.disarmed.active_content_removed).toContain('xfa');
    expect(r.disarmed.external_refs_blocked).toBe(3);
  });
  it('active content classes include the classic malicious PDF combo', () => {
    expect(ACTIVE_CONTENT_CLASSES).toContain('javascript');
    expect(ACTIVE_CONTENT_CLASSES).toContain('openaction');
    expect(ACTIVE_CONTENT_CLASSES).toContain('launch');
    expect(ACTIVE_CONTENT_CLASSES).toContain('xfa');
  });
});

// ---- decompression caps -----------------------------------------------------

describe('decompression caps (ratio + absolute + entries + depth)', () => {
  it('refuses on absolute decompressed-size overflow', () => {
    const r = checkDecompressionCaps({
      compressedBytes: 1000,
      decompressedBytes: 500 * 1024 * 1024,
      entries: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('absolute_decompressed_size_exceeded');
  });
  it('refuses non-recursive high-ratio bombs even under absolute cap', () => {
    const r = checkDecompressionCaps({
      compressedBytes: 1000,
      decompressedBytes: 10 * 1024 * 1024,
      entries: 1,
      maxDecompressedBytes: 100 * 1024 * 1024,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('expansion_ratio_exceeded');
  });
  it('refuses excessive entry counts', () => {
    const r = checkDecompressionCaps({
      compressedBytes: 100000,
      decompressedBytes: 200000,
      entries: 100000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('entry_count_exceeded');
  });
  it('refuses excessive nesting depth', () => {
    const r = checkDecompressionCaps({
      compressedBytes: 100000,
      decompressedBytes: 200000,
      entries: 1,
      nestingDepth: 50,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('nesting_depth_exceeded');
  });
  it('accepts a benign archive', () => {
    const r = checkDecompressionCaps({
      compressedBytes: 100000,
      decompressedBytes: 300000,
      entries: 10,
      nestingDepth: 1,
    });
    expect(r.ok).toBe(true);
  });
});

// ---- archive path traversal -------------------------------------------------

describe('archive entry safety', () => {
  it('rejects traversal, absolute, and null-byte entries', () => {
    expect(isSafeArchiveEntry('../../etc/passwd')).toBe(false);
    expect(isSafeArchiveEntry('/etc/passwd')).toBe(false);
    expect(isSafeArchiveEntry('a/../../b')).toBe(false);
    expect(isSafeArchiveEntry('C:\\x')).toBe(false);
    expect(isSafeArchiveEntry('a\0b')).toBe(false);
  });
  it('accepts safe relative entries', () => {
    expect(isSafeArchiveEntry('docs/readme.txt')).toBe(true);
    expect(isSafeArchiveEntry('file.csv')).toBe(true);
  });
});

// ---- budget ------------------------------------------------------------------

describe('unified BudgetTracker integration', () => {
  it('returns budget_exhausted when reservation is refused', async () => {
    const store = new FakeStore({ a: { bytes: bytes('x') } });
    const budget = new FakeBudget(false, 'no pages left');
    const adapter = makeAdapter({
      store,
      sandbox: new RecordingSandbox(okResult()),
      budget,
    });
    const r = await adapter.run({ action: 'parse', artifact_ref: 'a' });
    expect(r.status).toBe('budget_exhausted');
    expect(r.error?.retryable).toBe(true);
  });
  it('reserves before dispatch and releases after', async () => {
    const store = new FakeStore({ a: { bytes: bytes('x') } });
    const budget = new FakeBudget();
    const adapter = makeAdapter({
      store,
      sandbox: new RecordingSandbox(okResult()),
      budget,
    });
    await adapter.run({ action: 'parse', artifact_ref: 'a' });
    expect(budget.reserved.length).toBe(1);
    expect(budget.released.length).toBe(1);
  });
  it('propagates a sandbox budget_exhausted (bomb hits budget, not host)', async () => {
    const store = new FakeStore({ a: { bytes: bytes('PK') } });
    const sandbox = new RecordingSandbox({
      status: 'budget_exhausted',
      parser: 'archive_parser',
      parser_version: '0.1',
      error: { code: 'budget_exhausted', message: 'decompression bomb', retryable: true },
    });
    const adapter = makeAdapter({ store, sandbox, mime: 'application/zip' });
    const r = await adapter.run({ action: 'parse', artifact_ref: 'a' });
    expect(r.status).toBe('budget_exhausted');
  });
});

// ---- output cap --------------------------------------------------------------

describe('output capping', () => {
  it('truncates over max_output_bytes and reports truncated=true', async () => {
    const store = new FakeStore({ a: { bytes: bytes('x') } });
    const big = 'A'.repeat(5000);
    const sandbox = new RecordingSandbox(okResult({ content: { text: big } }));
    const adapter = makeAdapter({ store, sandbox });
    const r = await adapter.run({ action: 'parse', artifact_ref: 'a', max_output_bytes: 1000 });
    expect(r.truncated).toBe(true);
    expect((r.content?.text as string).length).toBeLessThanOrEqual(1000);
  });
  it('does not truncate small output', async () => {
    const store = new FakeStore({ a: { bytes: bytes('x') } });
    const sandbox = new RecordingSandbox(okResult({ content: { text: 'small' } }));
    const adapter = makeAdapter({ store, sandbox });
    const r = await adapter.run({ action: 'parse', artifact_ref: 'a' });
    expect(r.truncated).toBe(false);
  });
  it('honors default and hard-cap constants', () => {
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBeLessThan(HARD_MAX_OUTPUT_BYTES);
  });
});

// ---- malformed / not found ---------------------------------------------------

describe('robustness', () => {
  it('returns structured failure when artifact is not found', async () => {
    const store = new FakeStore({});
    const adapter = makeAdapter({ store, sandbox: new RecordingSandbox(okResult()) });
    const r = await adapter.run({ action: 'parse', artifact_ref: 'missing' });
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('artifact_not_found');
    expect(r.tainted).toBe(true);
  });
  it('surfaces quarantined status from the sandbox without throwing', async () => {
    const store = new FakeStore({ a: { bytes: bytes('bad') } });
    const sandbox = new RecordingSandbox({
      status: 'quarantined',
      parser: 'pdf_parser',
      parser_version: '0.1',
      error: { code: 'corrupt', message: 'malformed', retryable: false },
    });
    const adapter = makeAdapter({ store, sandbox, mime: 'application/pdf' });
    const r = await adapter.run({ action: 'parse', artifact_ref: 'a' });
    expect(r.status).toBe('quarantined');
    expect(r.tainted).toBe(true);
  });
});

// ---- extract -----------------------------------------------------------------

describe('schema extraction', () => {
  it('passes extraction_schema to the sandbox and returns extracted_fields', async () => {
    const store = new FakeStore({ a: { bytes: bytes('col1,col2\n1,2') } });
    const sandbox = new RecordingSandbox(
      okResult({ extracted_fields: { total: 3 }, content: undefined }),
    );
    const adapter = makeAdapter({ store, sandbox, mime: 'text/csv' });
    const r = await adapter.run({
      action: 'extract',
      artifact_ref: 'a',
      extraction_schema: { type: 'object' },
    });
    expect(r.status).toBe('ok');
    expect(r.extracted_fields?.total).toBe(3);
    expect(sandbox.lastJob?.extraction_schema).toEqual({ type: 'object' });
    expect(r.tainted).toBe(true);
  });
});
