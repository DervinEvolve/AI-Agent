import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../tool_registry';
import {
  ApprovalGatedToolRegistry,
  canonicalizeJson,
  sha256Digest,
} from '../approval_gate';

function makeTool(
  name: string,
  call = vi.fn(async () => ({ status: 'success', started: true })),
  schema?: { safeParse: (value: unknown) => { success: boolean; data?: unknown } },
) {
  return {
    name,
    call,
    schema: schema ?? {
      safeParse: (value: unknown) => ({ success: true, data: value }),
    },
  };
}

function makeRegistry() {
  return new ToolRegistry();
}

describe('canonicalizeJson', () => {
  it('handles primitives', () => {
    expect(canonicalizeJson(null)).toBe('null');
    expect(canonicalizeJson('hello')).toBe('"hello"');
    expect(canonicalizeJson(true)).toBe('true');
    expect(canonicalizeJson(false)).toBe('false');
    expect(canonicalizeJson(42)).toBe('42');
    expect(canonicalizeJson(3.14)).toBe('3.14');
    expect(canonicalizeJson(-0)).toBe('0');
  });

  it('sorts object keys', () => {
    const input = { b: 2, a: 1, c: { z: 26, y: 25 } };
    expect(canonicalizeJson(input)).toBe('{"a":1,"b":2,"c":{"y":25,"z":26}}');
  });

  it('handles arrays and nested structures', () => {
    const input = [3, 1, { b: 2, a: 1 }, [2, 1]];
    expect(canonicalizeJson(input)).toBe('[3,1,{"a":1,"b":2},[2,1]]');
  });

  it('handles strings with special characters', () => {
    expect(canonicalizeJson('a\"b\\c')).toBe('"a\\\"b\\\\c"');
  });

  it('handles non-finite numbers as null', () => {
    expect(canonicalizeJson(Infinity)).toBe('null');
    expect(canonicalizeJson(-Infinity)).toBe('null');
    expect(canonicalizeJson(NaN)).toBe('null');
  });
});

describe('sha256Digest', () => {
  it('computes correct SHA-256 hash', () => {
    expect(sha256Digest('test')).toBe(
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    );
    expect(sha256Digest('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('ApprovalGatedToolRegistry additional scenarios', () => {
  it('ask tier with deny decision returns approval_denied', async () => {
    const registry = makeRegistry();
    const tool = makeTool('write_file');
    registry.register(tool);
    const gate = new ApprovalGatedToolRegistry(registry, {
      tiers: { write_file: 'ask' },
      approver: () => 'deny',
    });

    const result = await gate.call('write_file', { path: '/tmp/a' });

    expect(result).toEqual({ status: 'approval_denied', started: false });
    expect(tool.call).not.toHaveBeenCalled();
  });

  it('ask tier with approver throw returns approval_denied', async () => {
    const registry = makeRegistry();
    const tool = makeTool('write_file');
    registry.register(tool);
    const gate = new ApprovalGatedToolRegistry(registry, {
      tiers: { write_file: 'ask' },
      approver: () => {
        throw new Error('approver failure');
      },
    });

    const result = await gate.call('write_file', { path: '/tmp/a' });

    expect(result).toEqual({ status: 'approval_denied', started: false });
    expect(tool.call).not.toHaveBeenCalled();
  });

  it('ask tier without approver returns approval_denied', async () => {
    const registry = makeRegistry();
    const tool = makeTool('write_file');
    registry.register(tool);
    const gate = new ApprovalGatedToolRegistry(registry, {
      tiers: { write_file: 'ask' },
    });

    const result = await gate.call('write_file', { path: '/tmp/a' });

    expect(result).toEqual({ status: 'approval_denied', started: false });
    expect(tool.call).not.toHaveBeenCalled();
  });
});
