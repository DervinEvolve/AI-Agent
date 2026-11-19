import { randomUUID } from "node:crypto";

export const WORKSPACE_MAX_FILE_BYTES = 256 * 1024;
export const WORKSPACE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const WORKSPACE_MAX_READ_BYTES = 64 * 1024;
export const WORKSPACE_MAX_PATH_LENGTH = 512;
export const WORKSPACE_MAX_DEPTH = 32;
export const WORKSPACE_MAX_ENTRIES = 10_000;
export const WORKSPACE_MAX_REQUEST_BYTES = 512 * 1024;
export const WORKSPACE_MAX_LIST_LIMIT = 500;
export const WORKSPACE_UID_GID = "65534:65534";

export const WORKSPACE_REQUIRED_DOCKER_FLAGS: readonly string[] = [
  "--network",
  "none",
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--user",
  WORKSPACE_UID_GID,
  "--memory",
  "256m",
  "--memory-swap",
  "256m",
  "--cpus",
  "0.5",
  "--pids-limit",
  "64",
];

export type WorkspaceBlockerCode =
  | "WORKSPACE_IMAGE_NOT_DIGEST_PINNED"
  | "WORKSPACE_ISOLATION_PREFLIGHT_FAILED"
  | "WORKSPACE_VOLUME_COLLISION"
  | "WORKSPACE_VOLUME_INIT_FAILED"
  | "WORKSPACE_OWNERSHIP_MISMATCH"
  | "WORKSPACE_UNAVAILABLE";

export interface DockerCliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface DockerCli {
  run(argv: string[], stdin?: string): Promise<DockerCliResult>;
}

export interface WorkspaceHostConfig {
  image: string;
  dockerCli: DockerCli;
  runId?: string;
  timeoutMs?: number;
  isolationPreflight?: () => Promise<{ ok: boolean; reason?: string }>;
}

export interface WorkspaceOwnership {
  runId: string;
  ownerToken: string;
  volumeName: string;
  labels: Record<string, string>;
}

export interface WorkspacePreflightResult {
  ok: boolean;
  blockerCode?: WorkspaceBlockerCode;
  reason?: string;
}

export interface WorkspaceCleanupResult {
  cleanup_confirmed: boolean;
  unresolvedContainers: string[];
  volumeRemoved: boolean;
  volumeAbsentConfirmed: boolean;
  errors: string[];
}

export type WorkspaceToolName = "list_files" | "read_file" | "write_file" | "edit_file";

export interface WorkspaceToolMetadata {
  name: WorkspaceToolName;
  idempotent: boolean;
  mount_mode: "readonly" | "readwrite";
}

export const WORKSPACE_TOOLS: readonly WorkspaceToolMetadata[] = [
  { name: "list_files", idempotent: true, mount_mode: "readonly" },
  { name: "read_file", idempotent: true, mount_mode: "readonly" },
  { name: "write_file", idempotent: false, mount_mode: "readwrite" },
  { name: "edit_file", idempotent: false, mount_mode: "readwrite" },
];

export interface WorkspaceToolExecutionResult {
  status: "ok" | "error";
  started?: boolean;
  termination_confirmed: boolean;
  cleanup_confirmed?: boolean;
  output?: {
    ok: boolean;
    [key: string]: unknown;
  };
  error?: string;
}

export type WorkspaceClassification =
  | "ok"
  | "known_failure"
  | "unknown"
  | "pre_execution_rejected";

export function classifyWorkspaceTool(
  result: WorkspaceToolExecutionResult
): WorkspaceClassification {
  if (result.started === false) {
    return "pre_execution_rejected";
  }
  if (!result.termination_confirmed) {
    return "unknown";
  }
  if (result.status === "ok" && result.output?.ok === true) {
    return "ok";
  }
  return "known_failure";
}

export class WorkspaceQuarantineLedger {
  private unknownMutatorActive = false;
  private readonly readRetryCounts = new Map<string, number>();
  private readonly maxReadRetries: number;

  constructor(maxReadRetries = 2) {
    this.maxReadRetries = maxReadRetries;
  }

  isMutatorQuarantined(): boolean {
    return this.unknownMutatorActive;
  }

  recordOutcome(tool: WorkspaceToolName | "run_code", classification: WorkspaceClassification): void {
    const isMutator = tool === "write_file" || tool === "edit_file";
    if (isMutator && classification === "unknown") {
      this.unknownMutatorActive = true;
    }
  }

  admit(tool: WorkspaceToolName | "run_code", retryKey?: string): { allowed: boolean; reason?: string } {
    if (this.unknownMutatorActive) {
      if (tool === "write_file" || tool === "edit_file" || tool === "run_code") {
        return {
          allowed: false,
          reason: "workspace_mutator_unknown_quarantined",
        };
      }
    }
    if (retryKey && (tool === "list_files" || tool === "read_file")) {
      const count = this.readRetryCounts.get(retryKey) ?? 0;
      if (count >= this.maxReadRetries) {
        return {
          allowed: false,
          reason: "read_retry_budget_exhausted",
        };
      }
      this.readRetryCounts.set(retryKey, count + 1);
    }
    return { allowed: true };
  }
}

export function isDigestPinnedImage(image: string): boolean {
  return /^[^\s@]+@sha256:[a-f0-9]{64}$/i.test(image.trim());
}

export function buildRunCodeWorkspaceMountArgs(volumeName: string): string[] {
  return ["--mount", `type=volume,src=${volumeName},dst=/workspace,readonly`];
}

export function buildWorkspaceMountArgs(
  volumeName: string,
  mode: "readonly" | "readwrite"
): string[] {
  const suffix = mode === "readonly" ? ",readonly" : "";
  return ["--mount", `type=volume,src=${volumeName},dst=/workspace${suffix}`];
}

export function createWorkspaceOwnership(runId?: string): WorkspaceOwnership {
  const safeRunId = (runId ?? randomUUID()).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 32);
  const ownerToken = randomUUID().replace(/-/g, "");
  const volumeName = `ai-agent-ws-${safeRunId}-${ownerToken.slice(0, 16)}`;
  return {
    runId: safeRunId,
    ownerToken,
    volumeName,
    labels: {
      "ai_agent.workspace_run_id": safeRunId,
      "ai_agent.workspace_owner_token": ownerToken,
    },
  };
}

export class WorkspaceLock {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export const TRUSTED_WORKSPACE_HELPER_PY = `import json, os, stat, sys

MAX_FILE_BYTES = ${WORKSPACE_MAX_FILE_BYTES}
MAX_TOTAL_BYTES = ${WORKSPACE_MAX_TOTAL_BYTES}
MAX_READ_BYTES = ${WORKSPACE_MAX_READ_BYTES}
MAX_PATH_LENGTH = ${WORKSPACE_MAX_PATH_LENGTH}
MAX_DEPTH = ${WORKSPACE_MAX_DEPTH}
MAX_ENTRIES = ${WORKSPACE_MAX_ENTRIES}
MAX_LIST_LIMIT = ${WORKSPACE_MAX_LIST_LIMIT}

def validate_rel_path(path):
    if not isinstance(path, str) or not path or len(path) > MAX_PATH_LENGTH:
        raise ValueError("invalid_path_length")
    if "\\x00" in path or path.startswith("/"):
        raise ValueError("invalid_path_absolute_or_nul")
    parts = [p for p in path.split("/") if p != ""]
    if not parts or len(parts) > MAX_DEPTH:
        raise ValueError("invalid_path_depth")
    for p in parts:
        if p in (".", ".."):
            raise ValueError("invalid_path_traversal")
    return parts

def open_dir_chain(root_fd, parts, create=False):
    cur_fd = root_fd
    opened = []
    try:
        for p in parts:
            try:
                nxt = os.open(p, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=cur_fd)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(p, 0o755, dir_fd=cur_fd)
                nxt = os.open(p, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=cur_fd)
            opened.append(nxt)
            cur_fd = nxt
        return cur_fd, opened
    except Exception:
        for fd in reversed(opened):
            os.close(fd)
        raise

def logical_size_and_count(root_fd):
    total = 0
    count = 0
    stack = [root_fd]
    while stack:
        dfd = stack.pop()
        with os.scandir(dfd) as it:
            for entry in it:
                count += 1
                if count > MAX_ENTRIES:
                    raise ValueError("entry_limit_exceeded")
                st = os.stat(entry.name, dir_fd=dfd, follow_symlinks=False)
                if stat.S_ISLNK(st.st_mode):
                    raise ValueError("symlink_forbidden")
                if stat.S_ISDIR(st.st_mode):
                    sub = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dfd)
                    stack.append(sub)
                elif stat.S_ISREG(st.st_mode):
                    total += st.st_size
        if dfd != root_fd:
            os.close(dfd)
    return total, count
`;

export class RunWorkspaceManager {
  readonly ownership: WorkspaceOwnership;
  readonly lock = new WorkspaceLock();
  readonly ledger = new WorkspaceQuarantineLedger();
  private readonly ownedContainers = new Set<string>();
  private volumeCreated = false;

  constructor(private readonly config: WorkspaceHostConfig) {
    this.ownership = createWorkspaceOwnership(config.runId);
  }

  async preflight(): Promise<WorkspacePreflightResult> {
    if (!isDigestPinnedImage(this.config.image)) {
      return {
        ok: false,
        blockerCode: "WORKSPACE_IMAGE_NOT_DIGEST_PINNED",
        reason: "Workspace image must be digest-pinned (@sha256:...)",
      };
    }
    if (this.config.isolationPreflight) {
      const iso = await this.config.isolationPreflight();
      if (!iso.ok) {
        return {
          ok: false,
          blockerCode: "WORKSPACE_ISOLATION_PREFLIGHT_FAILED",
          reason: iso.reason ?? "Isolation preflight failed",
        };
      }
    }
    const probeOwnership = createWorkspaceOwnership(`${this.ownership.runId}-probe`);
    const inspectExisting = await this.config.dockerCli.run([
      "volume",
      "inspect",
      probeOwnership.volumeName,
    ]);
    if (inspectExisting.exitCode === 0) {
      return {
        ok: false,
        blockerCode: "WORKSPACE_VOLUME_COLLISION",
        reason: "Throwaway probe volume name already exists",
      };
    }
    const createProbe = await this.config.dockerCli.run([
      "volume",
      "create",
      "--label",
      `ai_agent.workspace_owner_token=${probeOwnership.ownerToken}`,
      probeOwnership.volumeName,
    ]);
    if (createProbe.exitCode !== 0) {
      return {
        ok: false,
        blockerCode: "WORKSPACE_VOLUME_INIT_FAILED",
        reason: createProbe.stderr || "Failed to create throwaway probe volume",
      };
    }
    try {
      const probeContainer = `ai-agent-ws-probe-${probeOwnership.ownerToken.slice(0, 12)}`;
      const probeRun = await this.config.dockerCli.run([
        "run",
        "--rm",
        "--name",
        probeContainer,
        "--label",
        `ai_agent.workspace_owner_token=${probeOwnership.ownerToken}`,
        ...WORKSPACE_REQUIRED_DOCKER_FLAGS,
        ...buildWorkspaceMountArgs(probeOwnership.volumeName, "readwrite"),
        this.config.image,
        "python3",
        "-c",
        "import os; p='/workspace/.probe'; open(p,'w').write('ok'); assert open(p).read()=='ok'; os.remove(p)",
      ]);
      if (probeRun.exitCode !== 0) {
        return {
          ok: false,
          blockerCode: "WORKSPACE_VOLUME_INIT_FAILED",
          reason: probeRun.stderr || "UID 65534:65534 write/read probe failed",
        };
      }
      return { ok: true };
    } finally {
      await this.config.dockerCli.run(["volume", "rm", probeOwnership.volumeName]);
      await this.config.dockerCli.run(["volume", "inspect", probeOwnership.volumeName]);
    }
  }

  async allocateVolume(): Promise<WorkspacePreflightResult> {
    const existing = await this.config.dockerCli.run([
      "volume",
      "inspect",
      this.ownership.volumeName,
    ]);
    if (existing.exitCode === 0) {
      return {
        ok: false,
        blockerCode: "WORKSPACE_VOLUME_COLLISION",
        reason: "Production volume name already exists",
      };
    }
    const createRes = await this.config.dockerCli.run([
      "volume",
      "create",
      "--label",
      `ai_agent.workspace_run_id=${this.ownership.runId}`,
      "--label",
      `ai_agent.workspace_owner_token=${this.ownership.ownerToken}`,
      this.ownership.volumeName,
    ]);
    if (createRes.exitCode !== 0) {
      return {
        ok: false,
        blockerCode: "WORKSPACE_VOLUME_INIT_FAILED",
        reason: createRes.stderr || "Failed to create workspace volume",
      };
    }
    this.volumeCreated = true;
    return { ok: true };
  }

  registerOwnedContainer(name: string): void {
    this.ownedContainers.add(name);
  }

  async cleanup(): Promise<WorkspaceCleanupResult> {
    const unresolvedContainers: string[] = [];
    const errors: string[] = [];

    for (const containerName of this.ownedContainers) {
      const inspectRes = await this.config.dockerCli.run([
        "inspect",
        "--format",
        "{{.Config.Labels}}",
        containerName,
      ]);
      if (inspectRes.exitCode === 0 && !inspectRes.stdout.includes(this.ownership.ownerToken)) {
        unresolvedContainers.push(containerName);
        errors.push(`ownership_mismatch:${containerName}`);
        continue;
      }
      const rmRes = await this.config.dockerCli.run(["rm", "-f", containerName]);
      const verifyAbsent = await this.config.dockerCli.run(["inspect", containerName]);
      if (rmRes.exitCode !== 0 || verifyAbsent.exitCode === 0) {
        unresolvedContainers.push(containerName);
        errors.push(`container_removal_failed:${containerName}`);
      }
    }

    let volumeRemoved = !this.volumeCreated;
    let volumeAbsentConfirmed = !this.volumeCreated;

    if (this.volumeCreated) {
      const rmVol = await this.config.dockerCli.run(["volume", "rm", this.ownership.volumeName]);
      const inspectVol = await this.config.dockerCli.run([
        "volume",
        "inspect",
        this.ownership.volumeName,
      ]);
      volumeRemoved = rmVol.exitCode === 0;
      volumeAbsentConfirmed = inspectVol.exitCode !== 0;
      if (!volumeRemoved || !volumeAbsentConfirmed) {
        errors.push(`volume_removal_failed:${this.ownership.volumeName}`);
      }
    }

    return {
      cleanup_confirmed:
        unresolvedContainers.length === 0 && volumeRemoved && volumeAbsentConfirmed,
      unresolvedContainers,
      volumeRemoved,
      volumeAbsentConfirmed,
      errors,
    };
  }
}
