/**
 * Argv-only Docker client. Never builds a shell string.
 * run() does not return a container id; kill/inspect/rm are separate processes
 * and may run while run() is still blocked.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface DockerRunHandle {
  readonly pid: number | undefined;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout: string;
  stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  writeStdin(data: string): void;
  endStdin(): void;
  /** Kill the docker CLI process only. Does not stop the container. */
  killClient(): void;
}

export interface DockerCli {
  info(): Promise<{ ok: true; json: unknown } | { ok: false; error: string }>;
  /**
   * Spawn `docker` with an argument array. Does not return a container id.
   * Caller owns stdin (code) and must not pass -d if it needs an attached run.
   */
  run(argv: string[]): DockerRunHandle;
  kill(name: string): Promise<{ code: number | null; stdout: string; stderr: string }>;
  inspect(name: string): Promise<{ code: number | null; stdout: string; stderr: string }>;
  rm(name: string): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

const CAP = 256 * 1024;

function attachCapped(
  stream: NodeJS.ReadableStream,
  onChunk: (text: string, truncated: boolean) => void,
): void {
  let kept = 0;
  let truncated = false;
  stream.on("data", (chunk: Buffer | string) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (kept >= CAP) {
      truncated = true;
      return;
    }
    const room = CAP - kept;
    if (buf.length <= room) {
      kept += buf.length;
      onChunk(buf.toString("utf8"), truncated);
    } else {
      kept = CAP;
      truncated = true;
      onChunk(buf.subarray(0, room).toString("utf8"), true);
    }
  });
}

function spawnDocker(argv: string[], opts?: { capture?: boolean }): ChildProcessWithoutNullStreams {
  return spawn("docker", argv, {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: process.env,
  });
}

function collect(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export function createDockerCli(): DockerCli {
  return {
    async info() {
      try {
        const child = spawnDocker(["info", "--format", "{{json .}}"]);
        const { code, stdout, stderr } = await collect(child);
        if (code !== 0) return { ok: false, error: stderr || `docker info exit ${code}` };
        return { ok: true, json: JSON.parse(stdout) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    run(argv: string[]): DockerRunHandle {
      const child = spawnDocker(argv);
      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      attachCapped(child.stdout, (text, truncated) => {
        stdout += text;
        if (truncated) stdoutTruncated = true;
      });
      attachCapped(child.stderr, (text, truncated) => {
        stderr += text;
        if (truncated) stderrTruncated = true;
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code, signal }));
      });
      const handle: DockerRunHandle = {
        pid: child.pid,
        exited,
        get stdout() {
          return stdout;
        },
        get stderr() {
          return stderr;
        },
        get stdoutTruncated() {
          return stdoutTruncated;
        },
        get stderrTruncated() {
          return stderrTruncated;
        },
        writeStdin(data: string) {
          child.stdin.write(data);
        },
        endStdin() {
          child.stdin.end();
        },
        killClient() {
          try {
            child.kill("SIGKILL");
          } catch {
            /* client already gone */
          }
        },
      };
      // Drop the initial write rejection if stdin closes early.
      child.stdin.on("error", () => {
        /* EPIPE after kill */
      });
      return handle;
    },
    async kill(name: string) {
      const child = spawnDocker(["kill", name]);
      return collect(child);
    },
    async inspect(name: string) {
      const child = spawnDocker(["inspect", "--format", "{{json .}}", name]);
      return collect(child);
    },
    async rm(name: string) {
      const child = spawnDocker(["rm", "-f", name]);
      return collect(child);
    },
  };
}
