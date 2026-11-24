import { describe, it, expect } from 'vitest';
import {
  DiscoveryManager,
  HARD_MAX_CATALOG_SEARCH_RESULTS,
  HARD_MAX_LOADED_TOOLS,
  ToolCatalogEntry,
  computeBm25FieldScore,
  tokenizeIdentifier,
  truncateUtf8Bytes,
} from '../index.js';

function makeCatalog(count = 5): ToolCatalogEntry[] {
  const entries: ToolCatalogEntry[] = [
    {
      tool_name: 'search_tools',
      description: 'Search available tools',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  ];
  for (let i = entries.length; i < count; i++) {
    entries.push({
      tool_name: `tool_${i}`,
      description: `Tool ${i}`,
      parameters: { type: 'object', properties: {} },
    });
  }
  return entries;
}

describe('bm25 helpers', () => {
  it('tokenizeIdentifier splits camelCase, snake_case, kebab-case, and delimiters', () => {
    expect(tokenizeIdentifier('')).toEqual([]);
    expect(tokenizeIdentifier('getUserProfile')).toEqual(['get', 'user', 'profile']);
    expect(tokenizeIdentifier('file_read-v2.0/path:name')).toEqual([
      'file',
      'read',
      'v2',
      '0',
      'path',
      'name',
    ]);
  });

  it('computeBm25FieldScore scores matching documents higher and handles empty inputs', () => {
    expect(computeBm25FieldScore(['file'], [], 0)).toBe(0);
    expect(computeBm25FieldScore([], [['file']], 0)).toBe(0);

    const docs = [
      ['file', 'read'],
      ['network', 'fetch'],
      ['file', 'write', 'log'],
    ];
    const matchScore = computeBm25FieldScore(['file', 'read'], docs, 0);
    const partialScore = computeBm25FieldScore(['file', 'read'], docs, 2);
    const zeroScore = computeBm25FieldScore(['file', 'read'], docs, 1);

    expect(matchScore).toBeGreaterThan(partialScore);
    expect(partialScore).toBeGreaterThan(0);
    expect(zeroScore).toBe(0);
  });

  it('truncateUtf8Bytes respects byte limits for ASCII and multi-byte UTF-8', () => {
    expect(truncateUtf8Bytes('hello', 10)).toBe('hello');
    expect(truncateUtf8Bytes('hello world', 5)).toBe('hello');

    const multiByte = '😀😀😀'; // 4 bytes each = 12 bytes
    const truncated = truncateUtf8Bytes(multiByte, 5);
    expect(new TextEncoder().encode(truncated).length).toBeLessThanOrEqual(5);
  });
});

describe('DiscoveryManager config validation', () => {
  it('rejects forbidden co-mounted capabilities', () => {
    const catalog = makeCatalog(3);
    expect(
      () =>
        new DiscoveryManager(
          {
            enabled: true,
            alwaysVisibleTools: ['search_tools'],
            mountedCapabilities: ['cap_durable_runs_mount_41'],
          },
          catalog
        )
    ).toThrow();

    expect(
      () =>
        new DiscoveryManager(
          {
            enabled: true,
            alwaysVisibleTools: ['search_tools'],
            mountedCapabilities: ['cap_interactive_session_49'],
          },
          catalog
        )
    ).toThrow();
  });

  it('rejects out-of-range maxLoadedTools and maxCatalogSearchResults', () => {
    const catalog = makeCatalog(3);
    expect(
      () =>
        new DiscoveryManager(
          {
            enabled: true,
            alwaysVisibleTools: ['search_tools'],
            maxLoadedTools: 0,
          },
          catalog
        )
    ).toThrow();

    expect(
      () =>
        new DiscoveryManager(
          {
            enabled: true,
            alwaysVisibleTools: ['search_tools'],
            maxLoadedTools: HARD_MAX_LOADED_TOOLS + 1,
          },
          catalog
        )
    ).toThrow();

    expect(
      () =>
        new DiscoveryManager(
          {
            enabled: true,
            alwaysVisibleTools: ['search_tools'],
            maxCatalogSearchResults: 0,
          },
          catalog
        )
    ).toThrow();

    expect(
      () =>
        new DiscoveryManager(
          {
            enabled: true,
            alwaysVisibleTools: ['search_tools'],
            maxCatalogSearchResults: HARD_MAX_CATALOG_SEARCH_RESULTS + 1,
          },
          catalog
        )
    ).toThrow();
  });
});
