/**
 * Repository-backed mount of isolated Python onto AgentRuntime.
 * Host-configured run_code executes only in a fresh rootless container after
 * preflight proves the daemon is rootless, cgroup v2 is active, and memory,
 * pids and cpu limits are enforced. No host Python, subprocess backend, or
 * simulated execution.
 */
import type { DockerCli } from "./docker_cli.ts";
import type { ToolResult } from "./tool_registry.ts";
import type { OutcomeClass } from "./outcome_classifier.ts";

export const OUTPUT_CAP = 256 * 1024;
export const MEMORY_CAP_BYTES = 268435456;
export const PIDS_CAP = 64;
export const DEFAULT_WALL_S = 8;
export const MAX_WALL_S = 20;
export const CLEANUP_BUDGET_S = 15;

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const DIGEST_RE = /@sha256:[a-f0-9]{64}$/;

export const LIMIT_ARGV: readonly string[] = [
  "--network",
  "none",
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--user",
  "65534:65534",
  "--memory",
  "256m",
  "--memory-swap",
  "256m",
  "--cpus",
  "0.5",
  "--pids-limit",
  "64",
  "--tmpfs",
  "/tmp:rw,noexec,nosuid,nodev,size=32m",
];

export interface PreflightReport {
  ok: boolean;
  code?: string;
  detail?: string;
}

export interface MountResult {
  mounted: true;
  image: string;
  docker: DockerCli;
  tool: {
    name: "run_code";
    description: string;
    schema: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: false;
    };
    idempotent: false;
    timeoutS: number;
    handler: (args: unknown, callId: string) => Promise<Partial<ToolResult> & { output?: unknown }>;
  };
}

export interface MountFailure {
  mounted: false;
  code: string;
}

export interface ToolResultLike {
  status?: string;
  output?: unknown;
  termination_confirmed?: boolean;
  error?: { code?: string; message?: string; retryable?: boolean } | null;
}

export function containerName(callId: string): string {
  const raw = `rc${String(callId).replace(/[^a-zA-Z0-9_.-]/g, "")}`;
  const trimmed = raw.slice(0, 63);
  if (!NAME_RE.test(trimmed)) {
    return "rc0";
  }
  return trimmed;
}

export function assertDigestPin(image: string): void {
  if (!image || image.includes(":latest") || !DIGEST_RE.test(image) || image.startsWith("sha256:")) {
    throw new Error("image_not_digest_pinned");
  }
  const name = image.slice(0, image.indexOf("@"));
  if (!name || name.includes(" ") || name.startsWith("-") || name.includes(":")) {
    throw new Error("image_not_digest_pinned");
  }
}

function securityOptionsText(info: Record<string, unknown>): string {
  const opts = info.SecurityOptions ?? info.securityOptions;
  if (Array.isArray(opts)) return opts.map((o) => String(o)).join("\n");
  if (typeof opts === "string") return opts;
  return "";
}

function delegatedControllers(info: Record<string, unknown>): string[] {
  const raw =
    info.CgroupControllers ??
    info.cgroupControllers ??
    (info as { DelegatedControllers?: unknown }).DelegatedControllers ??
    nested(info, ["Runtimes"]) ??
    info.CgroupDriver;
  // Docker info JSON: look at common fields. Rootless cgroup v2 exposes
  // controllers via SecurityOptions or a dedicated list the host supplies
  // on the info object as `DelegatedControllers` or `CgroupControllers`.
  const list: unknown =
    (info as { delegatedControllers?: unknown }).delegatedControllers ??
    info.CgroupControllers ??
    (info as { Controllers?: unknown }).Controllers;
  if (Array.isArray(list)) return list.map((c) => String(c).toLowerCase());
  if (typeof list === "string") return list.split(/[,\s]+/).map((s) => s.toLowerCase()).filter(Boolean);
  void raw;
  return [];
}

function nested(_info: Record<string, unknown>, _path: string[]): undefined {
  return undefined;
}

function isRootless(info: Record<string, unknown>): boolean {
  const text = securityOptionsText(info).toLowerCase();
  return text.split(/[\s,;=]+/).includes("rootless") || text.includes("name=rootless") || text.includes("rootless");
}

export function classifyInfo(info: unknown): PreflightReport {
  if (!info || typeof info !== "object") {
    return { ok: false, code: "docker_info_unavailable" };
  }
  const obj = info as Record<string, unknown>;
  if (!isRootless(obj)) {
    return { ok: false, code: "rootless_unavailable" };
  }
  const version = String(obj.CgroupVersion ?? obj.cgroupVersion ?? "");
  if (version !== "2") {
    return { ok: false, code: "cgroup_v2_unavailable" };
  }
  const controllers = delegatedControllers(obj);
  for (const need of ["memory", "pids", "cpu"]) {
    if (!controllers.includes(need)) {
      return { ok: false, code: need === "cpu" ? "cpu_controller_not_delegated" : "cpu_controller_not_delegated" };
    }
  }
  if (!controllers.includes("cpu")) {
    return { ok: false, code: "cpu_controller_not_delegated" };
  }
  return { ok: true };
}

/** Parse cgroup files the probe printed as KEY=VALUE lines. */
export function evaluateCgroupProbe(stdout: string): PreflightReport {
  const map = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    map.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  const mem = map.get("memory.max");
  const pids = map.get("pids.max");
  const cpu = map.get("cpu.max");
  const swap = map.get("memory.swap.max");

  if (mem === undefined || pids === undefined || cpu === undefined || swap === undefined) {
    return { ok: false, code: "limits_not_enforced", detail: "missing_file" };
  }
  if (mem === "max" || pids === "max" || cpu === "max" || swap === "max") {
    return { ok: false, code: "limits_not_enforced", detail: "max" };
  }
  if (mem === "" || pids === "" || cpu === "" || mem === "unreadable" || pids === "unreadable" || cpu === "unreadable") {
    return { ok: false, code: "limits_not_enforced", detail: "unreadable" };
  }
  const memN = Number(mem);
  const pidsN = Number(pids);
  if (!Number.isFinite(memN) || !Number.isFinite(pidsN) || memN > MEMORY_CAP_BYTES || pidsN > PIDS_CAP) {
    return { ok: false, code: "limits_not_enforced" };
  }
  const parts = cpu.split(/\s+/);
  if (parts.length < 2) return { ok: false, code: "limits_not_enforced" };
  const quota = Number(parts[0]);
  const period = Number(parts[1]);
  if (!Number.isFinite(quota) || !Number.isFinite(period) || period === 0) {
    return { ok: false, code: "limits_not_enforced", detail: "period_0" };
  }
  if (parts[0] === "max" || quota * 2 > period) {
    return { ok: false, code: "limits_not_enforced", detail: "ratio" };
  }
  const swapN = Number(swap);
  if (!Number.isFinite(swapN)) {
    return { ok: false, code: "limits_not_enforced" };
  }
  return { ok: true };
}

const PROBE_CODE = [
  "import pathlib",
  "root = pathlib.Path('/sys/fs/cgroup')",
  "def read(name):",
  "    p = root / name",
  "    try:",
  "        if not p.exists():",
  "            print(f'{name}=missing')",
  "            return",
  "        print(f'{name}={p.read_text().strip()}')",
  "    except Exception:",
  "        print(f'{name}=unreadable')",
  "for n in ('memory.max','pids.max','cpu.max','memory.swap.max'):",
  "    read(n)",
  "",
].join("\n");

export async function probeIsolatedPython(docker: DockerCli, image?: string): Promise<PreflightReport> {
  let infoJson: unknown;
  try {
    const info = await docker.info();
    if (!info.ok) return { ok: false, code: "docker_info_unavailable", detail: info.error };
    infoJson = info.json;
  } catch (err) {
    return { ok: false, code: "docker_info_unavailable", detail: err instanceof Error ? err.message : String(err) };
  }
  const classified = classifyInfo(infoJson);
  if (!classified.ok) return classified;

  if (!image) {
    return { ok: false, code: "image_not_digest_pinned" };
  }
  try {
    assertDigestPin(image);
  } catch {
    return { ok: false, code: "image_not_digest_pinned" };
  }

  const name = containerName(`probe${Date.now().toString(36)}`);
  const argv = [
    "run",
    "--name",
    name,
    ...LIMIT_ARGV,
    "-i",
    "--rm",
    image,
    "python",
    "-I",
    "-",
  ];
  let handle;
  try {
    handle = docker.run(argv);
    handle.writeStdin(PROBE_CODE);
    handle.endStdin();
  } catch (err) {
    return { ok: false, code: "limits_not_enforced", detail: err instanceof Error ? err.message : String(err) };
  }
  let exitCode: number | null = null;
  try {
    const exited = await Promise.race([
      handle.exited,
      new Promise<{ code: number | null; signal: null }>((resolve) =>
        setTimeout(() => resolve({ code: null, signal: null }), 20_000),
      ),
    ]);
    exitCode = exited.code;
  } catch (err) {
    return { ok: false, code: "limits_not_enforced", detail: err instanceof Error ? err.message : String(err) };
  }
  if (exitCode !== 0) {
    return { ok: false, code: "limits_not_enforced", detail: `probe_exit_${exitCode}` };
  }
  return evaluateCgroupProbe(handle.stdout);
}

export function classifyRunCode(result: ToolResultLike): OutcomeClass {
  const output = (result.output ?? {}) as Record<string, unknown>;
  const termination = result.termination_confirmed === true || output.termination_confirmed === true;
  const cleanup = output.cleanup_confirmed === true;
  if (!termination || !cleanup) return "unknown";
  if (
    result.status === "ok" &&
    output.outcome === "completed" &&
    output.exit_code === 0
  ) {
    return "success";
  }
  return "known_failure";
}

function notFound(stderr: string, stdout: string, code: number | null): boolean {
  const blob = `${stderr}\n${stdout}`.toLowerCase();
  if (code === 0) return false;
  return (
    blob.includes("no such") ||
    blob.includes("not found") ||
    blob.includes("no such object") ||
    blob.includes("is not running") === false && blob.includes("no such container")
  );
}

function inspectGone(stderr: string, stdout: string, code: number | null): boolean {
  if (code === 0 && stdout.trim().length > 0) return false;
  const blob = `${stderr}\n${stdout}`.toLowerCase();
  return blob.includes("no such") || blob.includes("not found") || blob.includes("no such object");
}

function parseStatus(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { State?: { Status?: string }; state?: { status?: string } };
    const status = parsed.State?.Status ?? parsed.state?.status;
    if (typeof status === "string") return status.toLowerCase();
  } catch {
    const m = trimmed.match(/"Status"\s*:\s*"([a-zA-Z]+)"/);
    if (m) return m[1].toLowerCase();
  }
  return undefined;
}

async function confirmKill(docker: DockerCli, name: string): Promise<boolean> {
  try {
    await docker.kill(name);
  } catch {
    /* kill error is not termination */
  }
  try {
    const inspected = await docker.inspect(name);
    if (inspected.code !== 0) return false;
    const status = parseStatus(inspected.stdout);
    return status === "exited" || status === "dead";
  } catch {
    return false;
  }
}

async function confirmCleanup(docker: DockerCli, name: string, created: boolean): Promise<boolean> {
  if (!created) return false;
  try {
    const removed = await docker.rm(name);
    if (removed.code !== 0 && !notFound(removed.stderr, removed.stdout, removed.code)) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    const follow = await docker.inspect(name);
    return inspectGone(follow.stderr, follow.stdout, follow.code);
  } catch {
    return false;
  }
}

export interface RunCodeOutput {
  container_name: string;
  outcome: "completed" | "timeout" | "error" | "refused";
  exit_code: number | null;
  stdout: string;
  stderr: string;
  output_truncated: boolean;
  termination_confirmed: boolean;
  cleanup_confirmed: boolean;
  created: boolean;
}

function refuse(name: string, message: string): { status: "error"; output: RunCodeOutput; error: { code: string; message: string; retryable: boolean }; termination_confirmed: false } {
  return {
    status: "error",
    termination_confirmed: false,
    error: { code: "invalid_args", message, retryable: false },
    output: {
      container_name: name,
      outcome: "refused",
      exit_code: null,
      stdout: "",
      stderr: "",
      output_truncated: false,
      termination_confirmed: false,
      cleanup_confirmed: false,
      created: false,
    },
  };
}

export function buildRunCodeHandler(docker: DockerCli, image: string) {
  return async function runCode(
    args: unknown,
    callId: string,
  ): Promise<{
    status: "ok" | "error" | "timeout";
    output: RunCodeOutput;
    error?: { code: string; message: string; retryable: boolean } | null;
    termination_confirmed: boolean;
  }> {
    const name = containerName(callId);
    const rec = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const code = rec.code;
    if (typeof code !== "string" || code.length < 1 || code.length > 8000) {
      return refuse(name, "code must be a string of length 1..8000");
    }
    let wall = DEFAULT_WALL_S;
    if (rec.timeout_s !== undefined) {
      const n = Number(rec.timeout_s);
      if (!Number.isFinite(n) || n <= 0) return refuse(name, "timeout_s invalid");
      wall = Math.min(MAX_WALL_S, n);
    }

    const argv = [
      "run",
      "--name",
      name,
      ...LIMIT_ARGV,
      "-i",
      image,
      "python",
      "-I",
      "-",
    ];
    if (argv.includes("-d") || argv.includes("-v") || argv.includes("--mount") || argv.includes("--privileged")) {
      return refuse(name, "forbidden argv");
    }

    let handle;
    let created = true;
    try {
      handle = docker.run(argv);
      handle.writeStdin(code);
      handle.endStdin();
    } catch (err) {
      created = false;
      return {
        status: "error",
        termination_confirmed: false,
        error: { code: "spawn_failed", message: err instanceof Error ? err.message : String(err), retryable: false },
        output: {
          container_name: name,
          outcome: "error",
          exit_code: null,
          stdout: "",
          stderr: "",
          output_truncated: false,
          termination_confirmed: false,
          cleanup_confirmed: false,
          created: false,
        },
      };
    }

    const wallMs = wall * 1000;
    let timedOut = false;
    let exitCode: number | null = null;
    let runError: string | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
    }, wallMs);

    const exitPromise = handle.exited.then(
      (e) => {
        exitCode = e.code;
      },
      (err: unknown) => {
        runError = err instanceof Error ? err.message : String(err);
      },
    );

    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, wallMs)),
    ]);
    clearTimeout(timer);

    let termination = false;
    if (timedOut || exitCode === null) {
      // Client timeout / still running: kill by recorded name. Killing the CLI is not termination.
      timedOut = exitCode === null;
      termination = await confirmKill(docker, name);
      // Give the attached CLI a brief chance to notice, but do not treat that as confirmation.
      await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 500))]);
    } else {
      // Process exited via docker run. Confirm with inspect; do not assume.
      try {
        const inspected = await docker.inspect(name);
        const status = inspected.code === 0 ? parseStatus(inspected.stdout) : undefined;
        termination = status === "exited" || status === "dead";
      } catch {
        termination = false;
      }
    }

    const cleanup = await confirmCleanup(docker, name, created);

    const stdout = handle.stdout.slice(0, OUTPUT_CAP);
    const stderr = handle.stderr.slice(0, OUTPUT_CAP);
    const truncated = handle.stdoutTruncated || handle.stderrTruncated || handle.stdout.length >= OUTPUT_CAP;

    if (runError && !termination) {
      return {
        status: "error",
        termination_confirmed: false,
        error: { code: "docker_run_error", message: runError, retryable: false },
        output: {
          container_name: name,
          outcome: "error",
          exit_code: exitCode,
          stdout,
          stderr,
          output_truncated: truncated,
          termination_confirmed: false,
          cleanup_confirmed: cleanup,
          created,
        },
      };
    }

    if (timedOut) {
      return {
        status: termination && cleanup ? "ok" : "timeout",
        termination_confirmed: termination,
        error: termination ? null : { code: "timeout", message: "wall clock exceeded; termination not confirmed", retryable: false },
        output: {
          container_name: name,
          outcome: "timeout",
          exit_code: exitCode,
          stdout,
          stderr,
          output_truncated: truncated,
          termination_confirmed: termination,
          cleanup_confirmed: cleanup,
          created,
        },
      };
    }

    return {
      status: "ok",
      termination_confirmed: termination,
      error: null,
      output: {
        container_name: name,
        outcome: "completed",
        exit_code: exitCode,
        stdout,
        stderr,
        output_truncated: truncated,
        termination_confirmed: termination,
        cleanup_confirmed: cleanup,
        created,
      },
    };
  };
}

export async function mountIsolatedPython(
  docker: DockerCli,
  image: string,
): Promise<MountResult | MountFailure> {
  try {
    assertDigestPin(image);
  } catch {
    return { mounted: false, code: "image_not_digest_pinned" };
  }
  const pre = await probeIsolatedPython(docker, image);
  if (!pre.ok) {
    return { mounted: false, code: pre.code ?? "limits_not_enforced" };
  }
  return {
    mounted: true,
    image,
    docker,
    tool: {
      name: "run_code",
      description:
        "Execute Python in a fresh rootless container with proven cgroup limits. Code is the only model input and is passed on stdin to python -I -.",
      schema: {
        type: "object",
        properties: {
          code: { type: "string", minLength: 1, maxLength: 8000 },
          timeout_s: { type: "number", minimum: 0.1, maximum: MAX_WALL_S },
        },
        required: ["code"],
        additionalProperties: false,
      },
      idempotent: false,
      timeoutS: MAX_WALL_S + CLEANUP_BUDGET_S,
      handler: buildRunCodeHandler(docker, image),
    },
  };
}

export const RUN_CODE_SCHEMA = {
  name: "run_code",
  description:
    "Execute Python in a fresh rootless container with proven cgroup limits. Code is the only model input and is passed on stdin to python -I -.",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", minLength: 1, maxLength: 8000 },
      timeout_s: { type: "number", minimum: 0.1, maximum: 20 },
    },
    required: ["code"],
    additionalProperties: false,
  },
};
