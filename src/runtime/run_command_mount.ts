import { Buffer } from 'node:buffer';

/**
 * Repository-backed mount of fixed-argv command execution onto AgentRuntime.
 *
 * This module implements the pure orchestration and classification layer for
 * the `run_command` capability. It receives a trusted backend that owns the
 * container boundary (Docker/rootless container execution) and never constructs
 * a shell command line. argv entries are passed verbatim as structured data.
 */

export const RUN_COMMAND_TOOL_NAME = 'run_command';

export const RUN_COMMAND_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['argv'],
  properties: {
    argv: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      items: { type: 'string' },
      description:
        'Tokenized command arguments. argv[0] is the program to execute. ' +
        'Array entries are literal data; metacharacters are never parsed by the runtime.',
    },
    cwd: {
      type: 'string',
      description:
        'Relative path inside the workspace jail. Defaults to workspace root. ' +
        'Absolute paths, parent traversal, and NUL bytes are rejected.',
    },
  },
} as const;

export const RUN_COMMAND_TOOL = {
  id: 'cap_run_command_mount_35',
  name: RUN_COMMAND_TOOL_NAME,
  description:
    'Execute a tokenized argv inside a fresh, resource-limited rootless container ' +
    'with no network, against a writable mount of the run-scoped workspace volume.',
  idempotent: false,
  schema: RUN_COMMAND_TOOL_SCHEMA,
} as const;

const SHELL_BASENAMES = new Set(['sh', 'bash', 'dash', 'zsh', 'ash', 'busybox']);
export { SHELL_BASENAMES };

const MAX_ARGV_LENGTH = 64;
const MAX_ARGV0_BYTES = 2048;
const MAX_ARGV_OTHER_BYTES = 2048;
const MAX_CWD_BYTES = 1024;
const MAX_CWD_DEPTH = 16;

export interface RunCommandArgs {
  argv: string[];
  cwd?: string;
}

export type RunCommandValidationResult =
  | { ok: true; argv: string[]; cwd: string }
  | { ok: false; reason: 'invalid_args' | 'rejected' | 'unavailable'; detail?: string };

export interface RunCommandReport {
  started: boolean;
  exitCode?: number;
  signal?: string | null;
  spawnError?: string | null;
  stdout?: string;
  stderr?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  timedOut?: boolean;
  terminationConfirmed?: boolean;
  cleanupConfirmed?: boolean;
  containerName?: string;
  malformed?: boolean;
}

export interface ContainerInspection {
  state: 'running' | 'exited' | 'dead' | 'created' | 'unknown';
}

export interface RunCommandBackend {
  /**
   * Execute argv directly (execvp-style PATH lookup inside the container).
   * The backend must never construct a shell command line.
   */
  run(
    argv: string[],
    cwd: string,
    opts: { timeoutMs: number; maxOutputBytes: number; maxScratchBytes: number },
  ): Promise<RunCommandReport>;
  inspect(containerName: string): Promise<ContainerInspection>;
  remove(containerName: string): Promise<{ removed: boolean; error?: string }>;
}

export interface RunCommandConfig {
  timeoutMs: number;
  maxOutputBytes: number;
  maxScratchBytes: number;
}

export const DEFAULT_RUN_COMMAND_CONFIG: RunCommandConfig = {
  timeoutMs: 30_000,
  maxOutputBytes: 1_048_576,
  maxScratchBytes: 67_108_864,
};

export type RunCommandOutcome = {
  status:
    | 'success'
    | 'known_failure'
    | 'unknown'
    | 'invalid_args'
    | 'rejected'
    | 'unavailable';
  started: boolean;
  exitCode?: number;
  signal?: string;
  code?: 'spawn_enoent' | 'exit_nonzero' | 'signal_termination';
  terminationConfirmed: boolean;
  cleanupConfirmed: boolean;
  stdout?: string;
  stderr?: string;
  detail?: string;
};

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validateCwd(cwd: string): boolean {
  if (utf8ByteLength(cwd) > MAX_CWD_BYTES) return false;
  if (cwd.includes('\0')) return false;
  if (cwd.startsWith('/') || cwd.startsWith('\\')) return false;

  const parts = cwd.split('/');
  if (parts.length > MAX_CWD_DEPTH) return false;

  for (const part of parts) {
    if (part === '..') return false;
    if (part === '') return false;
    if (utf8ByteLength(part) > 255) return false;
  }

  return true;
}

export function validateRunCommandArgs(input: unknown): RunCommandValidationResult {
  if (!isRecord(input)) {
    return { ok: false, reason: 'invalid_args', detail: 'request body must be an object' };
  }

  const argv = input.argv;
  if (!Array.isArray(argv)) {
    return { ok: false, reason: 'invalid_args', detail: 'argv must be an array' };
  }

  if (argv.length < 1 || argv.length > MAX_ARGV_LENGTH) {
    return { ok: false, reason: 'invalid_args', detail: `argv length must be 1..${MAX_ARGV_LENGTH}` };
  }

  for (let i = 0; i < argv.length; i++) {
    const entry = argv[i];
    if (typeof entry !== 'string') {
      return { ok: false, reason: 'invalid_args', detail: `argv[${i}] must be a string` };
    }
    if (entry.includes('\0')) {
      return { ok: false, reason: 'invalid_args', detail: `argv[${i}] contains NUL` };
    }
    const maxBytes = i === 0 ? MAX_ARGV0_BYTES : MAX_ARGV_OTHER_BYTES;
    if (utf8ByteLength(entry) > maxBytes) {
      return {
        ok: false,
        reason: 'invalid_args',
        detail: `argv[${i}] exceeds ${maxBytes} UTF-8 bytes`,
      };
    }
  }

  let cwd = '.';
  if (input.cwd !== undefined) {
    if (typeof input.cwd !== 'string') {
      return { ok: false, reason: 'invalid_args', detail: 'cwd must be a string' };
    }
    if (!validateCwd(input.cwd)) {
      return {
        ok: false,
        reason: 'invalid_args',
        detail: 'cwd must be a bounded relative path without parent traversal or NUL',
      };
    }
    cwd = input.cwd;
  }

  const basename = argv[0].split('/').pop() ?? '';
  if (SHELL_BASENAMES.has(basename)) {
    return {
      ok: false,
      reason: 'rejected',
      detail: `shell argv[0] rejected by dispatcher heuristic: ${basename}`,
    };
  }

  return { ok: true, argv: argv as string[], cwd };
}

export function classifyRunCommandReport(report: RunCommandReport): RunCommandOutcome {
  if (report.malformed) {
    return {
      status: 'unknown',
      started: report.started,
      terminationConfirmed: report.terminationConfirmed ?? false,
      cleanupConfirmed: report.cleanupConfirmed ?? false,
      detail: 'malformed structured report',
    };
  }

  if (!report.started) {
    return {
      status: 'invalid_args',
      started: false,
      terminationConfirmed: false,
      cleanupConfirmed: false,
      detail: 'command did not start',
    };
  }

  if (report.timedOut) {
    return {
      status: 'unknown',
      started: true,
      terminationConfirmed: false,
      cleanupConfirmed: false,
      detail: 'client timeout; termination not confirmed',
    };
  }

  if (report.spawnError) {
    if (
      report.spawnError === 'ENOENT' &&
      report.terminationConfirmed === true &&
      report.cleanupConfirmed === true
    ) {
      return {
        status: 'known_failure',
        started: true,
        code: 'spawn_enoent',
        terminationConfirmed: true,
        cleanupConfirmed: true,
        detail: 'spawn failed: executable not found (ENOENT)',
      };
    }
    return {
      status: 'unknown',
      started: true,
      terminationConfirmed: report.terminationConfirmed ?? false,
      cleanupConfirmed: report.cleanupConfirmed ?? false,
      detail: `spawn failure without confirmed cleanup: ${report.spawnError}`,
    };
  }

  if (report.terminationConfirmed !== true) {
    return {
      status: 'unknown',
      started: true,
      terminationConfirmed: false,
      cleanupConfirmed: report.cleanupConfirmed ?? false,
      detail: 'termination not confirmed',
    };
  }

  if (report.cleanupConfirmed !== true) {
    return {
      status: 'unknown',
      started: true,
      terminationConfirmed: true,
      cleanupConfirmed: false,
      detail: 'cleanup not confirmed',
    };
  }

  if (report.signal) {
    return {
      status: 'known_failure',
      started: true,
      signal: report.signal,
      code: 'signal_termination',
      terminationConfirmed: true,
      cleanupConfirmed: true,
      detail: `terminated by signal ${report.signal}`,
    };
  }

  if (typeof report.exitCode === 'number' && report.exitCode === 0) {
    return {
      status: 'success',
      started: true,
      exitCode: 0,
      terminationConfirmed: true,
      cleanupConfirmed: true,
      stdout: report.stdout,
      stderr: report.stderr,
    };
  }

  if (typeof report.exitCode === 'number' && report.exitCode !== 0) {
    return {
      status: 'known_failure',
      started: true,
      exitCode: report.exitCode,
      code: 'exit_nonzero',
      terminationConfirmed: true,
      cleanupConfirmed: true,
      stdout: report.stdout,
      stderr: report.stderr,
      detail: `command exited with code ${report.exitCode}`,
    };
  }

  return {
    status: 'unknown',
    started: true,
    terminationConfirmed: true,
    cleanupConfirmed: true,
    detail: 'missing or malformed exit status',
  };
}

function generateContainerName(): string {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `run-command-${Date.now()}-${randomPart}`;
}

export async function executeRunCommand(
  input: unknown,
  backend: RunCommandBackend | undefined,
  config: RunCommandConfig = DEFAULT_RUN_COMMAND_CONFIG,
): Promise<RunCommandOutcome> {
  const validation = validateRunCommandArgs(input);
  if (!validation.ok) {
    return {
      status: validation.reason,
      started: false,
      terminationConfirmed: false,
      cleanupConfirmed: false,
      detail: validation.detail,
    };
  }

  if (!backend) {
    return {
      status: 'unavailable',
      started: false,
      terminationConfirmed: false,
      cleanupConfirmed: false,
      detail: 'run_command backend is not available',
    };
  }

  const containerName = generateContainerName();

  try {
    const report = await backend.run(validation.argv, validation.cwd, {
      timeoutMs: config.timeoutMs,
      maxOutputBytes: config.maxOutputBytes,
      maxScratchBytes: config.maxScratchBytes,
    });

    // The backend owns the container lifecycle. The report is supervisor-derived
    // and must never be influenced by command stdout/stderr.
    const outcome = classifyRunCommandReport({ ...report, containerName });
    return outcome;
  } catch (error) {
    return {
      status: 'unknown',
      started: true,
      terminationConfirmed: false,
      cleanupConfirmed: false,
      detail: `backend execution threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
