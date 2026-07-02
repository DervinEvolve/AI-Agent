// cap_code_execution_1 — Sandboxed code execution
//
// This module defines a pluggable ExecutionBackend seam for running code in an
// isolated, ephemeral sandbox and returning a structured result contract.
//
// SECURITY NOTE (2026 consensus): Python CANNOT be safely sandboxed at the
// language level — deleting builtins is trivially bypassed via introspection
// (e.g. ().__class__.__bases__[0].__subclasses__()) and traceback frame
// walking. Isolation MUST live at the OS/VM boundary, never in-process.
//
// Therefore:
//   * MockExecutionBackend    — deterministic, in-process, for tests + dev of
//                               agent logic ONLY. It executes a tiny, explicitly
//                               enumerated instruction protocol, NOT arbitrary
//                               Python, and is NOT a security boundary.
//   * SubprocessReferenceBackend — runs real Python in a child process with
//                               wall-clock timeout, output capture, and cwd
//                               isolation. This is a DEV / TRUSTED-CODE backend
//                               (hardened-container equivalent) and is NOT
//                               production-safe for genuinely untrusted code.
//                               For untrusted workloads, swap in a
//                               Firecracker/gVisor microVM backend behind this
//                               same ExecutionBackend interface.

export interface ExecutionRequest {
  /** Python source to execute (reference backend) or mock protocol (mock backend). */
  code: string;
  /** Wall-clock timeout in seconds. Default 30, hard-capped at 300. */
  timeout_s?: number;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  /** Serialized return value, or null when none was produced. */
  return_value: string | null;
  exit_code: number;
  /** Relative file paths written into the sandbox workdir during the run. */
  artifacts: string[];
  duration_ms: number;
  timed_out: boolean;
}

/** The swappable seam. Every backend — mock, hardened-container, microVM — implements this. */
export interface ExecutionBackend {
  readonly id: string;
  /** True when this backend enforces an OS/VM isolation boundary suitable for untrusted code. */
  readonly isolatedForUntrustedCode: boolean;
  run(req: ExecutionRequest): Promise<ExecutionResult>;
}

export const DEFAULT_TIMEOUT_S = 30;
export const MAX_TIMEOUT_S = 300;

export function normalizeTimeout(timeout_s?: number): number {
  if (timeout_s === undefined || timeout_s === null || Number.isNaN(timeout_s)) {
    return DEFAULT_TIMEOUT_S;
  }
  if (timeout_s <= 0) return DEFAULT_TIMEOUT_S;
  return Math.min(Math.floor(timeout_s), MAX_TIMEOUT_S);
}

// ---------------------------------------------------------------------------
// MockExecutionBackend
//
// Executes a small, fully-specified instruction protocol so the contract tests
// can exercise every observable behavior (stdout/stderr separation, return
// values, exceptions surfaced without crashing the host, timeout, artifacts)
// deterministically and without any host dependency.
//
// Protocol: newline-separated instructions.
//   PRINT <text>            -> writes <text>+"\n" to stdout
//   EPRINT <text>           -> writes <text>+"\n" to stderr
//   RETURN <text>           -> sets return_value to <text>
//   ADD <a> <b>             -> writes (a+b) to stdout and sets return_value
//   RAISE <name> <message>  -> emits a traceback to stderr, exit_code=1
//   WRITE <path> <text>     -> records <path> as an artifact
//   SLEEP <seconds>         -> simulates wall-clock work (honors timeout)
// ---------------------------------------------------------------------------
export class MockExecutionBackend implements ExecutionBackend {
  readonly id = 'mock';
  readonly isolatedForUntrustedCode = false;

  async run(req: ExecutionRequest): Promise<ExecutionResult> {
    const timeout_s = normalizeTimeout(req.timeout_s);
    const start = Date.now();

    let stdout = '';
    let stderr = '';
    let return_value: string | null = null;
    let exit_code = 0;
    let timed_out = false;
    const artifacts: string[] = [];
    let simulatedElapsedMs = 0;
    const budgetMs = timeout_s * 1000;

    const lines = req.code.split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (line === '') continue;

      if (simulatedElapsedMs > budgetMs) {
        timed_out = true;
        exit_code = 124; // conventional timeout exit code
        stderr += 'Killed: wall-clock timeout exceeded\n';
        break;
      }

      const spaceIdx = line.indexOf(' ');
      const op = (spaceIdx === -1 ? line : line.slice(0, spaceIdx)).toUpperCase();
      const rest = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1);

      switch (op) {
        case 'PRINT':
          stdout += rest + '\n';
          break;
        case 'EPRINT':
          stderr += rest + '\n';
          break;
        case 'RETURN':
          return_value = rest;
          break;
        case 'ADD': {
          const parts = rest.split(/\s+/);
          const a = Number(parts[0]);
          const b = Number(parts[1]);
          const sum = a + b;
          stdout += String(sum) + '\n';
          return_value = String(sum);
          break;
        }
        case 'RAISE': {
          const parts = rest.split(' ');
          const name = parts[0] || 'Exception';
          const message = parts.slice(1).join(' ');
          stderr +=
            'Traceback (most recent call last):\n' +
            '  File "<mock>", line 1, in <module>\n' +
            `${name}: ${message}\n`;
          exit_code = 1;
          break;
        }
        case 'WRITE': {
          const parts = rest.split(/\s+/);
          const path = parts[0];
          if (path && !artifacts.includes(path)) artifacts.push(path);
          break;
        }
        case 'SLEEP': {
          const secs = Number(rest);
          if (!Number.isNaN(secs)) simulatedElapsedMs += secs * 1000;
          break;
        }
        default:
          // Unknown instruction: mimic a syntax error surfaced without crashing.
          stderr += `SyntaxError: unknown instruction '${op}'\n`;
          exit_code = 1;
          break;
      }

      if (timed_out) break;
    }

    // Final timeout check for trailing SLEEP that pushes us over budget.
    if (!timed_out && simulatedElapsedMs > budgetMs) {
      timed_out = true;
      exit_code = 124;
      stderr += 'Killed: wall-clock timeout exceeded\n';
    }

    return {
      stdout,
      stderr,
      return_value,
      exit_code,
      artifacts,
      duration_ms: Date.now() - start,
      timed_out,
    };
  }
}
