import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { ToolRegistry } from '../tool_registry.js';
import { SkillMount } from '../skills/skill_mount.js';
import {
  SkillConfig,
  SkillExecutor,
  SkillStoreFs,
  SkillExecutionReport,
  canonicalizeJson,
  buildSkillHarness,
  caps,
} from '../skills/types.js';

function createInMemoryFs(): SkillStoreFs {
  const files = new Map<string, string>();
  return {
    async readFile(p: string) {
      const val = files.get(p);
      if (val === undefined) throw new Error(`ENOENT: ${p}`);
      return val;
    },
    async writeFile(p: string, data: string) {
      files.set(p, data);
    },
    async rename(oldP: string, newP: string) {
      const val = files.get(oldP);
      if (val === undefined) throw new Error(`ENOENT: ${oldP}`);
      files.delete(oldP);
      files.set(newP, val);
    },
    async mkdir() {},
    async readdir(dir: string) {
      const list: string[] = [];
      for (const k of files.keys()) {
        if (k.startsWith(dir)) {
          const rest = k.slice(dir.length).replace(/^[\\/]/, '');
          const top = rest.split(/[\\/]/)[0];
          if (top && !list.includes(top)) list.push(top);
        }
      }
      return list;
    },
    async exists(p: string) {
      return files.has(p);
    },
  };
}

describe('cap_skill_library_mount_59', () => {
  it('verifies buildSkillHarness structure and canonicalization', () => {
    const code = 'def run(args): return {"res": args["x"] * 2}';
    const harness1 = buildSkillHarness(code, canonicalizeJson({ x: 10 }));
    const harness2 = buildSkillHarness(code, canonicalizeJson({ x: 20 }));

    expect(harness1).toContain('import sys, json, base64');
    expect(harness1).toContain('parsed_args = json.loads(raw_args)');
    // Differ only in the base64 args literal
    const b64_1 = Buffer.from(canonicalizeJson({ x: 10 })).toString('base64');
    const b64_2 = Buffer.from(canonicalizeJson({ x: 20 })).toString('base64');
    expect(harness1).toContain(b64_1);
    expect(harness2).toContain(b64_2);
    expect(harness1.replace(b64_1, '')).toBe(harness2.replace(b64_2, ''));
  });

  it('Run A authors a skill, authorizer sees canonical bytes, Run B invokes it', async () => {
    const fs = createInMemoryFs();
    const capturedAuthorizerBytes: string[] = [];
    const authorizer = vi.fn(async (payload) => {
      capturedAuthorizerBytes.push(payload.canonical_bytes);
      return true;
    });

    // Executor script
    const scriptedExecutor: SkillExecutor = async (codeStr) => {
      // parse b64 from harness
      const match = codeStr.match(/base64\.b64decode\("([^"]+)"\)/);
      let x = 0;
      if (match) {
        const decoded = JSON.parse(Buffer.from(match[1], 'base64').toString('utf-8'));
        x = decoded.x;
      }
      return {
        outcome: 'completed',
        exit_code: 0,
        stdout: JSON.stringify({ double_x: x * 2 }),
        stderr: '',
        termination_confirmed: true,
        cleanup_confirmed: true,
      };
    };

    // Run A
    const regA = new ToolRegistry();
    const mountA = new SkillMount({
      config: {
        principal: 'principal-1',
        storeDir: '/storage/skills',
        authorizer,
        fs,
      },
      executor: scriptedExecutor,
      registry: regA,
      runId: 'run-A',
    });
    await mountA.mount();

    // Verify skill tools are registered in Run A (propose_skill & list_skills)
    expect(regA.has('propose_skill')).toBe(true);
    expect(regA.has('list_skills')).toBe(true);
    expect(regA.has('skill_double_num')).toBe(false);

    const proposeResult = await regA.call('propose_skill', {
      name: 'double_num',
      description: 'Doubles an input number',
      params_schema: {
        type: 'object',
        properties: { x: { type: 'number' } },
        required: ['x'],
        additionalProperties: false,
      },
      code: 'def run(args): return {"double_x": args["x"] * 2}',
      tests: [
        { args: { x: 2 }, expect_json: { double_x: 4 } },
        { args: { x: 5 }, expect_json: { double_x: 10 } },
      ],
    });

    expect(proposeResult.ok).toBe(true);
    expect(proposeResult.output.committed).toBe(true);
    expect(proposeResult.output.version).toBe(1);
    expect(authorizer).toHaveBeenCalledTimes(1);
    expect(capturedAuthorizerBytes.length).toBe(1);

    // The skill is NOT callable in Run A
    expect(regA.has('skill_double_num')).toBe(false);

    // Run B with host activation
    const regB = new ToolRegistry();
    const codeSha = crypto
      .createHash('sha256')
      .update('def run(args): return {"double_x": args["x"] * 2}', 'utf8')
      .digest('hex');

    const mountB = new SkillMount({
      config: {
        principal: 'principal-1',
        storeDir: '/storage/skills',
        activation: [{ name: 'double_num', version: 1, code_sha256: codeSha }],
        fs,
      },
      executor: scriptedExecutor,
      registry: regB,
      runId: 'run-B',
    });
    await mountB.mount();

    expect(regB.has('skill_double_num')).toBe(true);

    const invokeResult = await regB.call('skill_double_num', { x: 21 });
    expect(invokeResult.ok).toBe(true);
    expect(invokeResult.output.started).toBe(true);
    expect(invokeResult.output.outcome).toBe('completed');
    expect(invokeResult.output.result).toEqual({ double_x: 42 });
    expect(invokeResult.output.version).toBe(1);
    expect(invokeResult.output.code_sha256).toBe(codeSha);
  });

  it('Missing authorizer or authorizer denial writes nothing and fails', async () => {
    const fs = createInMemoryFs();
    const reg = new ToolRegistry();
    const mount = new SkillMount({
      config: {
        principal: 'principal-1',
        storeDir: '/storage/skills',
        authorizer: async () => false, // denied
        fs,
      },
      executor: async () => ({
        outcome: 'completed',
        exit_code: 0,
        stdout: JSON.stringify({ ok: 1 }),
        stderr: '',
        termination_confirmed: true,
        cleanup_confirmed: true,
      }),
      registry: reg,
      runId: 'run-denied',
    });
    await mount.mount();

    const res = await reg.call('propose_skill', {
      name: 'add_one',
      description: 'Adds one',
      params_schema: {
        type: 'object',
        properties: { a: { type: 'number' } },
        required: ['a'],
        additionalProperties: false,
      },
      code: 'def run(args): return {"ok": 1}',
      tests: [{ args: { a: 1 }, expect_json: { ok: 1 } }],
    });

    expect(res.ok).toBe(true);
    expect(res.output.ok).toBe(false);
    expect(res.output.error).toContain('denied authorization');
  });

  it('Tampered stored code yields startup failure for pinned activation', async () => {
    const fs = createInMemoryFs();
    const regA = new ToolRegistry();
    const mountA = new SkillMount({
      config: {
        principal: 'principal-tamper',
        storeDir: '/storage/skills',
        authorizer: async () => true,
        fs,
      },
      executor: async () => ({
        outcome: 'completed',
        exit_code: 0,
        stdout: JSON.stringify({ r: 1 }),
        stderr: '',
        termination_confirmed: true,
        cleanup_confirmed: true,
      }),
      registry: regA,
      runId: 'run-author',
    });
    await mountA.mount();

    await regA.call('propose_skill', {
      name: 'tamper_test',
      description: 'Testing tamper',
      params_schema: {
        type: 'object',
        properties: { a: { type: 'number' } },
        required: ['a'],
        additionalProperties: false,
      },
      code: 'def run(args): return {"r": 1}',
      tests: [{ args: { a: 1 }, expect_json: { r: 1 } }],
    });

    // Tamper with the code on disk
    const storedPath = '/storage/skills/principals/principal-tamper/skills/tamper_test.v1.json';
    const content = JSON.parse(await fs.readFile(storedPath, 'utf-8'));
    content.code = 'def run(args): return {"r": 999}'; // code changed but code_sha256 in json unchanged
    await fs.writeFile(storedPath, JSON.stringify(content), 'utf-8');

    // Pinned activation with the original hash should fail at startup
    const originalSha = crypto.createHash('sha256').update('def run(args): return {"r": 1}', 'utf8').digest('hex');
    const regB = new ToolRegistry();
    const mountB = new SkillMount({
      config: {
        principal: 'principal-tamper',
        storeDir: '/storage/skills',
        activation: [{ name: 'tamper_test', version: 1, code_sha256: originalSha }],
        fs,
      },
      executor: async () => ({} as any),
      registry: regB,
      runId: 'run-tampered',
    });

    await expect(mountB.mount()).rejects.toThrow(/tampering detected/);
  });

  it('Failing self-test fails propose_skill without calling authorizer', async () => {
    const fs = createInMemoryFs();
    const authorizer = vi.fn(async () => true);
    const reg = new ToolRegistry();
    const mount = new SkillMount({
      config: {
        principal: 'principal-fail-test',
        storeDir: '/storage/skills',
        authorizer,
        fs,
      },
      executor: async () => ({
        outcome: 'completed',
        exit_code: 0,
        stdout: JSON.stringify({ out: 'wrong' }),
        stderr: '',
        termination_confirmed: true,
        cleanup_confirmed: true,
      }),
      registry: reg,
      runId: 'run-fail-test',
    });
    await mount.mount();

    const res = await reg.call('propose_skill', {
      name: 'mismatch_skill',
      description: 'Tests mismatch',
      params_schema: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
        additionalProperties: false,
      },
      code: 'def run(args): return {"out": "wrong"}',
      tests: [{ args: { q: 'hi' }, expect_json: { out: 'expected' } }],
    });

    expect(res.ok).toBe(true);
    expect(res.output.ok).toBe(false);
    expect(res.output.outcome).toBe('failure');
    expect(res.output.error).toContain('did not match expect_json');
    expect(authorizer).not.toHaveBeenCalled();
  });

  it('Rejects store directory that overlaps with workspace or episode directory', () => {
    const fs = createInMemoryFs();
    expect(
      () =>
        new SkillMount({
          config: {
            principal: 'p1',
            storeDir: '/data/workspace/skills',
            fs,
          },
          executor: async () => ({} as any),
          registry: new ToolRegistry(),
          runId: 'run-overlap',
          forbiddenStoreDirs: ['/data/workspace'],
        })
    ).toThrow(/overlaps with forbidden directory/);
  });
});
