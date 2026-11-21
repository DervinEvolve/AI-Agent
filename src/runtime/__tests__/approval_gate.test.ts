import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../tool_registry';
import {
  ApprovalGatedToolRegistry,
  ApprovalPolicy,
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

describe('ApprovalGatedToolRegistry', () => {
  it('allow tier proceeds unchanged', async () => {
    const registry = makeRegistry();
    const tool = makeTool('write_file');
    registry.register(tool);
    const gate = new ApprovalGatedToolRegistry(registry, {
      defaultTier: 'allow',
    });

    const result = await gate.call('write_file', { path: '/tmp/a' });

    expect(result).toEqual({ status: 'success', started: true });
    expect(tool.call).toHaveBeenCalledTimes(1);
  });

  it('deny tier returns approval_denied and does not invoke tool', async () => {
    const registry = makeRegistry();
    const tool = makeTool('write_file');
    registry.register(tool);
    const gate = new ApprovalGatedToolRegistry(registry, {
      defaultTier: 'deny',
    });

    const result = await gate.call('write_file', { path: '/tmp/a' });

    expect(result).toEqual({ status: 'approval_denied', started: false });
    expect(tool.call).not.toHaveBeenCalled();
  });

  it('ask tier with approve decision proceeds', async () => {
    const registry = makeRegistry();
    const tool = makeTool('write_file');
    registry.register(tool);
    const gate = new ApprovalGatedToolRegistry(registry, {
      tiers: { write_file: 'ask' },
      approver: () => 'approve',
    });

    const result = await gate.call('write_file', { path: '/tmp/a' });

    expect(result).toEqual({ status: 'success', started: true });
    expect(tool.call).toHaveBeenCalledTimes(1);
  });

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

  it('approver timeout returns approval_denied', async () => {
    const registry = makeRegistry();
    const tool = makeTool('write_file');
    registry.register(tool);
    const gate = new ApprovalGatedToolRegistry(registry, {
      tiers: { write_file: 'ask' },
      approverTimeoutMs: 10,
      approver: () => {
        const end = Date.now() + 50;
        while (Date.now() < end) {
          // busy wait to exceed the bounded timeout
        }
        return 'approve';
      },
    });

    const result = await gate.call('write_file', { path: '/tmp/a' });

    expect(result).toEqual({ status: 'approval_denied', started: false });
    expect(tool.call).not.toHaveBeenCalled();
  });

  it('approver throw returns approval_denied', async () => {
    const registry = makeRegistry();
    const tool = makeTool('write_file');
    registry.register(tool);
    const gate = new ApprovalGatedToolRegistry(registry, {
      tiers: { write_file: 'ask' },
      approver: () => {
        throw new Error('approver exploded');
      },
    });

    const result = await gate.call('write_file', { path: '/tmp/a' });

    expect(result).toEqual({ status: 'approval_denied', started: false });
    expect(tool.call).not.toHaveBeenCalled();
  });

  it('missing approver for ask tier returns approval_denied', async () => {
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

  it('records approval decisions with canonical argument digest', async () => {
    const registry = makeRegistry();
    const tool = makeTool('write_file');
    registry.register(tool);
    const gate = new ApprovalGatedToolRegistry(registry, {
      tiers: { write_file: 'ask' },
      approver: () => 'approve',
    });

    await gate.call('write_file', { b: 2, a: 1 });
    const records = gate.getRecords();

    expect(records).toHaveLength(1);
    expect(records[0].decision).toBe('approve');
    expect(records[0].toolName).toBe('write_file');
    expect(records[0].argumentDigest).toBe(
      sha256Digest(canonicalizeJson({ a: 1, b: 2 })),
    );
    expect(records[0].exactBytes).toBe(canonicalizeJson({ a: 1, b: 2 }));
  });

  it('replay of a denied intent is refused without re-invoking approver', async () => {
    const registry = makeRegistry();
    const tool = makeTool('write_file');
    registry.register(tool);
    let approverCalls = 0;
    const gate = new ApprovalGatedToolRegistry(registry, {
      tiers: { write_file: 'ask' },
      approver: () => {
        approverCalls += 1;
        return 'deny';
      },
    });

    const first = await gate.call('write_file', { path: '/tmp/a' });
    const second = await gate.call('write_file', { path: '/tmp/a' });

    expect(first).toEqual({ status: 'approval_denied', started: false });
    expect(second).toEqual({ status: 'approval_denied', started: false });
    expect(approverCalls).toBe(1);
    expect(tool.call).not.toHaveBeenCalled();
  });

  it('schema validation runs before approval policy', async () => {
    const registry = makeRegistry();
    const tool = makeTool('write_file', vi.fn(), {
      safeParse: () => ({ success: false }),
    });
    registry.register(tool);
    const gate = new ApprovalGatedToolRegistry(registry, {
      defaultTier: 'deny',
    });

    const result = await gate.call('write_file', { path: '/tmp/a' });

    expect(result.status).not.toBe('approval_denied');
    expect(tool.call).not.toHaveBeenCalled();
  });

  it('ask-tier delegation refusal throws on configuration', () => {
    const registry = makeRegistry();
    registry.register(makeTool('ask_tool'));
    const policy: ApprovalPolicy = {
      tiers: { ask_tool: 'ask' },
      delegation: { allowedTools: ['ask_tool'] },
    };

    expect(() => new ApprovalGatedToolRegistry(registry, policy)).toThrow(
      /cannot be listed in delegation.allowedTools/,
    );
  });

  it('default tier is deny unless host explicitly selects allow', async () => {
    const registry = makeRegistry();
    const tool = makeTool('write_file');
    registry.register(tool);

    const denyGate = new ApprovalGatedToolRegistry(registry, {});
    const denyResult = await denyGate.call('write_file', { path: '/tmp/a' });
    expect(denyResult).toEqual({ status: 'approval_denied', started: false });

    const allowGate = new ApprovalGatedToolRegistry(registry, {
      defaultTier: 'allow',
    });
    const allowResult = await allowGate.call('write_file', { path: '/tmp/a' });
    expect(allowResult).toEqual({ status: 'success', started: true });
    expect(tool.call).toHaveBeenCalledTimes(1);
  });

  it('absent configuration preserves original behavior exactly', async () => {
    const registry = makeRegistry();
    const tool = makeTool('write_file');
    registry.register(tool);
    const gate = new ApprovalGatedToolRegistry(registry);

    const result = await gate.call('write_file', { path: '/tmp/a' });

    expect(result).toEqual({ status: 'success', started: true });
    expect(tool.call).toHaveBeenCalledTimes(1);
    expect(gate.getRecords()).toHaveLength(0);
  });
});
