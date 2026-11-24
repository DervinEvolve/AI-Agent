import { describe, it, expect } from 'vitest';
import {
  DiscoveryManager,
  DISCOVERY_REASON_CODES,
  HARD_MAX_LOADED_TOOLS,
  NOT_LOADED_STUB_DESCRIPTION,
  ToolCatalogEntry,
} from '../index.js';

function makeCatalog(count = 20): ToolCatalogEntry[] {
  const entries: ToolCatalogEntry[] = [
    { tool_name: 'search_tools', description: 'Search available tools', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
    { tool_name: 'gui_observe', description: 'Observe GUI state', parameters: { type: 'object', properties: {} } },
    { tool_name: 'file_read', description: 'Read a file from disk', host_tags: ['fs'], parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    { tool_name: 'file_write', description: 'Write a file to disk', host_tags: ['fs'], parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
    { tool_name: 'decoy_tool', description: 'file_read file_read file_read repeated in description', parameters: { type: 'object', properties: {} } },
  ];
  for (let i = entries.length; i < count; i++) {
    entries.push({
      tool_name: `extra_tool_${i}`,
      description: `Extra tool number ${i}`,
      parameters: { type: 'object', properties: { arg: { type: 'string' } } },
    });
  }
  return entries;
}

describe('Demand-driven tool discovery', () => {
  it('disabled configuration renders full catalog as pass-through', () => {
    const catalog = makeCatalog(20);
    const mgr = new DiscoveryManager({ enabled: false, alwaysVisibleTools: ['search_tools'] }, catalog);
    const rendered = mgr.renderToolsForContext([]);
    expect(rendered.ok).toBe(true);
    if (rendered.ok) {
      expect(rendered.tools.length).toBe(20);
    }
    expect(mgr.checkToolCall('extra_tool_10')).toEqual({ allowed: true });
  });

  it('fails startup on forbidden co-mount or caps exceeded', () => {
    const catalog = makeCatalog(5);
    expect(() => new DiscoveryManager({
      enabled: true,
      alwaysVisibleTools: ['search_tools'],
      mountedCapabilities: ['cap_durable_runs_mount_41'],
    }, catalog)).toThrow();

    expect(() => new DiscoveryManager({
      enabled: true,
      alwaysVisibleTools: ['search_tools'],
      maxLoadedTools: HARD_MAX_LOADED_TOOLS + 1,
    }, catalog)).toThrow();
  });

  it('returns tool_not_loaded for registered unloaded tool and unknown_tool for unregistered', () => {
    const catalog = makeCatalog(10);
    const mgr = new DiscoveryManager({ enabled: true, alwaysVisibleTools: ['search_tools'] }, catalog);
    const unloaded = mgr.checkToolCall('file_read');
    expect(unloaded).toMatchObject({
      status: DISCOVERY_REASON_CODES.TOOL_NOT_LOADED,
      started: false,
      slotExempt: true,
      tripsBatchLatch: false,
    });
    const unknown = mgr.checkToolCall('nonexistent_tool');
    expect(unknown).toEqual({ status: 'error', started: false, reason: 'unknown_tool' });
  });

  it('ranks name-equal query above description-only decoy', () => {
    const catalog = makeCatalog(10);
    const mgr = new DiscoveryManager({ enabled: true, alwaysVisibleTools: ['search_tools'] }, catalog);
    const res = mgr.searchTools({ query: 'file_read' });
    expect(res.started).toBe(true);
    if (res.started && res.output.ok) {
      expect(res.output.results[0].tool_name).toBe('file_read');
      expect(res.output.results.some((r) => r.tool_name === 'decoy_tool')).toBe(false);
    }
  });

  it('commits loaded tools only at turn boundary and preserves not_loaded stubs for historical calls', () => {
    const catalog = makeCatalog(10);
    const mgr = new DiscoveryManager({ enabled: true, alwaysVisibleTools: ['search_tools'], maxLoadedTools: 3 }, catalog);
    const res = mgr.searchTools({ query: 'file_read' });
    expect(res.started).toBe(true);
    // Before turn boundary, same-batch sibling still sees unloaded
    expect(mgr.checkToolCall('file_read')).toMatchObject({ status: 'tool_not_loaded' });
    mgr.commitTurnBoundary(1);
    expect(mgr.checkToolCall('file_read')).toEqual({ allowed: true });

    const rendered = mgr.renderToolsForContext(['extra_tool_9']);
    expect(rendered.ok).toBe(true);
    if (rendered.ok) {
      const stub = rendered.tools.find((t) => t.name === 'extra_tool_9');
      expect(stub).toBeDefined();
      expect(stub?.description).toBe(NOT_LOADED_STUB_DESCRIPTION);
      expect(stub?.isStub).toBe(true);
    }
  });

  it('respects pinned tools during LRU eviction and omits search_tools for children', () => {
    const catalog = makeCatalog(10);
    const mgr = new DiscoveryManager({
      enabled: true,
      alwaysVisibleTools: ['search_tools'],
      initialLoadedTools: ['gui_observe', 'file_read'],
      maxLoadedTools: 3,
    }, catalog);
    const res = mgr.searchTools({ query: 'file_write' }, { needsObservation: true });
    expect(res.started).toBe(true);
    mgr.commitTurnBoundary(1);
    // gui_observe was pinned by needsObservation, so file_read should be evicted
    expect(mgr.checkToolCall('gui_observe')).toEqual({ allowed: true });
    expect(mgr.checkToolCall('file_read')).toMatchObject({ status: 'tool_not_loaded' });

    const childTools = mgr.getChildTools(['search_tools', 'file_read', 'extra_tool_5']);
    expect(childTools.map((t) => t.name)).toEqual(['file_read', 'extra_tool_5']);
  });
});
