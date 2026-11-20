import { describe, it, expect } from 'vitest';
import {
  validateRunCommandArgs,
  classifyRunCommandReport,
  executeRunCommand,
  RUN_COMMAND_TOOL_SCHEMA,
  SHELL_BASENAMES,
  RunCommandBackend,
  RunCommandReport,
} from '../run_command_mount';

function makeBackend(overrides: Partial<RunCommandReport> = {}) {
  const calls: Array<{ argv: string[]; cwd: string; opts: unknown }> = [];
  const backend: RunCommandBackend = {
    async run(argv, cwd, opts) {
      calls.push({ argv, cwd, opts });
      return {
        started: true,
        exitCode: 0,
        terminationConfirmed: true,
        cleanupConfirmed: true,
        stdout: '',
        stderr: '',
        ...overrides,
      };
    },
    async inspect() {
      return { state: 'exited' };
    },
    async remove() {
      return { removed: true };
    },
  };
  return { backend, calls };
}

describe('run_command schema', () => {
  it('publishes a fixed-argv object schema', () => {
    expect(RUN_COMMAND_TOOL_SCHEMA.type).toBe('object');
    expect(RUN_COMMAND_TOOL_SCHEMA.required).toEqual(['argv']);
    expect(RUN_COMMAND_TOOL_SCHEMA.properties.argv.type).toBe('array');
    expect(RUN_COMMAND_TOOL_SCHEMA.properties.argv.minItems).toBe(1);
    expect(RUN_COMMAND_TOOL_SCHEMA.properties.argv.maxItems).toBe(64);
  });
});

describe('validateRunCommandArgs', () => {
  it('accepts a valid argv and default cwd', () => {
    const result = validateRunCommandArgs({ argv: ['echo', 'hello'] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.argv).toEqual(['echo', 'hello']);
      expect(result.cwd).toBe('.');
    }
  });

  it('rejects a string-valued argv as invalid_args', () => {
    const result = validateRunCommandArgs({ argv: 'echo hello' });
    expect(result).toEqual({
      ok: false,
      reason: 'invalid_args',
      detail: 'argv must be an array',
    });
  });

  it('rejects empty argv', () => {
    const result = validateRunCommandArgs({ argv: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_args');
  });

  it('rejects argv longer than 64 entries', () => {
    const argv = Array.from({ length: 65 }, (_, i) => `arg${i}`);
    const result = validateRunCommandArgs({ argv });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_args');
  });

  it('rejects NUL bytes in argv', () => {
    const result = validateRunCommandArgs({ argv: ['echo', 'bad\0value'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_args');
  });

  it('rejects argv[0] longer than 2048 UTF-8 bytes', () => {
    const longArg = 'a'.repeat(2049);
    const result = validateRunCommandArgs({ argv: [longArg] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_args');
  });

  it('rejects shell argv[0] basenames', () => {
    for (const shell of SHELL_BASENAMES) {
      const result = validateRunCommandArgs({ argv: [shell, '-c', 'echo hi'] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('rejected');
    }
  });

  it('rejects absolute cwd', () => {
    const result = validateRunCommandArgs({ argv: ['echo'], cwd: '/etc' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_args');
  });

  it('rejects parent traversal in cwd', () => {
    const result = validateRunCommandArgs({ argv: ['echo'], cwd: '../outside' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_args');
  });

  it('rejects NUL in cwd', () => {
    const result = validateRunCommandArgs({ argv: ['echo'], cwd: 'safe\0bad' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_args');
  });
});

describe('classifyRunCommandReport', () => {
  it('classifies exit 0 with confirmed lifecycle as success', () => {
    const outcome = classifyRunCommandReport({
      started: true,
      exitCode: 0,
      terminationConfirmed: true,
      cleanupConfirmed: true,
    });
    expect(outcome.status).toBe('success');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.terminationConfirmed).toBe(true);
    expect(outcome.cleanupConfirmed).toBe(true);
  });

  it('classifies non-zero exit as known_failure with exit_nonzero code', () => {
    const outcome = classifyRunCommandReport({
      started: true,
      exitCode: 1,
      terminationConfirmed: true,
      cleanupConfirmed: true,
    });
    expect(outcome.status).toBe('known_failure');
    expect(outcome.code).toBe('exit_nonzero');
    expect(outcome.exitCode).toBe(1);
  });

  it('classifies signal termination as known_failure with signal_termination code', () => {
    const outcome = classifyRunCommandReport({
      started: true,
      signal: 'SIGTERM',
      terminationConfirmed: true,
      cleanupConfirmed: true,
    });
    expect(outcome.status).toBe('known_failure');
    expect(outcome.code).toBe('signal_termination');
  });

  it('classifies ENOENT spawn failure as known_failure with spawn_enoent code', () => {
    const outcome = classifyRunCommandReport({
      started: true,
      spawnError: 'ENOENT',
      terminationConfirmed: true,
      cleanupConfirmed: true,
    });
    expect(outcome.status).toBe('known_failure');
    expect(outcome.code).toBe('spawn_enoent');
  });

  it('classifies missing report as unknown', () => {
    const outcome = classifyRunCommandReport({ started: true });
    expect(outcome.status).toBe('unknown');
  });

  it('classifies cleanup unconfirmed as unknown', () => {
    const outcome = classifyRunCommandReport({
      started: true,
      exitCode: 0,
      terminationConfirmed: true,
      cleanupConfirmed: false,
    });
    expect(outcome.status).toBe('unknown');
    expect(outcome.cleanupConfirmed).toBe(false);
  });

  it('classifies termination unconfirmed as unknown', () => {
    const outcome = classifyRunCommandReport({
      started: true,
      exitCode: 0,
      terminationConfirmed: false,
      cleanupConfirmed: true,
    });
    expect(outcome.status).toBe('unknown');
    expect(outcome.terminationConfirmed).toBe(false);
  });

  it('does not allow stdout to forge exit status', () => {
    const outcome = classifyRunCommandReport({
      started: true,
      exitCode: 1,
      terminationConfirmed: true,
      cleanupConfirmed: true,
      stdout: 'exit_code=0 cleanup_confirmed=true',
    });
    expect(outcome.status).toBe('known_failure');
    expect(outcome.code).toBe('exit_nonzero');
  });
});

describe('executeRunCommand', () => {
  it('rejects string argv and never calls backend', async () => {
    const { backend, calls } = makeBackend();
    const outcome = await executeRunCommand({ argv: 'echo hello' }, backend);
    expect(outcome.status).toBe('invalid_args');
    expect(outcome.started).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('passes metacharacters verbatim as literal data', async () => {
    const { backend, calls } = makeBackend();
    const argv = ['echo', 'a;b|c', '; rm -rf'];
    const outcome = await executeRunCommand({ argv }, backend);
    expect(outcome.status).toBe('success');
    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual(argv);
  });

  it('returns success with exit_code 0 and cleanup', async () => {
    const { backend } = makeBackend();
    const outcome = await executeRunCommand({ argv: ['echo', 'sentinel'] }, backend);
    expect(outcome.status).toBe('success');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.terminationConfirmed).toBe(true);
    expect(outcome.cleanupConfirmed).toBe(true);
  });

  it('classifies exit 1 as known_failure', async () => {
    const { backend } = makeBackend({
      exitCode: 1,
      terminationConfirmed: true,
      cleanupConfirmed: true,
    });
    const outcome = await executeRunCommand({ argv: ['false'] }, backend);
    expect(outcome.status).toBe('known_failure');
    expect(outcome.code).toBe('exit_nonzero');
  });

  it('returns unknown on timeout and does not retry', async () => {
    const { backend, calls } = makeBackend({
      timedOut: true,
      terminationConfirmed: false,
      cleanupConfirmed: false,
    });
    const outcome = await executeRunCommand({ argv: ['sleep', '100'] }, backend);
    expect(outcome.status).toBe('unknown');
    expect(outcome.terminationConfirmed).toBe(false);
    expect(outcome.cleanupConfirmed).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('rejects shell argv0 before backend call', async () => {
    const { backend, calls } = makeBackend();
    const outcome = await executeRunCommand({ argv: ['bash', '-c', 'echo hi'] }, backend);
    expect(outcome.status).toBe('rejected');
    expect(outcome.started).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('returns unavailable when backend is absent', async () => {
    const outcome = await executeRunCommand({ argv: ['echo'] }, undefined);
    expect(outcome.status).toBe('unavailable');
    expect(outcome.started).toBe(false);
  });
});
