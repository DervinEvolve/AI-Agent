import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DOCUMENT_CAPS,
  HARD_DOCUMENT_CAPS,
  DocumentConfig,
  DocumentObservation,
  DocumentTarget,
  ParserPort,
} from '../documents/types';

describe('document runtime types', () => {
  it('exports config, parser port, observation, and caps types', () => {
    const config: DocumentConfig = {
      enabled: false,
      pdf: { id: 'pypdf', version: '1.0.0', options: {} },
      xlsx: { id: 'openpyxl', version: '3.1.0', options: {} },
      caps: DEFAULT_DOCUMENT_CAPS,
      parserPort: {} as ParserPort,
    };
    expect(config.enabled).toBe(false);

    const observation: DocumentObservation = {
      ok: true,
      artifact_id: 'a',
      extraction_id: 'e',
      format: 'pdf',
      sheet_elided_count: 0,
      warnings: [],
      complete: true,
    };
    expect(observation.ok).toBe(true);

    const target: DocumentTarget = { kind: 'pdf', page: 1 };
    expect(target.kind).toBe('pdf');

    expect(HARD_DOCUMENT_CAPS.maxInputBytes).toBeGreaterThan(DEFAULT_DOCUMENT_CAPS.maxInputBytes);
  });
});
