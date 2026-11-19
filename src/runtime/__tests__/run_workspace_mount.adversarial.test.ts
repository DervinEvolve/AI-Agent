import {
  buildRunCodeWorkspaceMountArgs,
  createWorkspaceOwnership,
  isDigestPinnedImage,
  RunWorkspaceManager,
  WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_MAX_READ_BYTES,
  WORKSPACE_MAX_TOTAL_BYTES,
  WORKSPACE_REQUIRED_DOCKER_FLAGS,
  WORKSPACE_UID_GID,
  type DockerCli,
  type DockerCliResult,
} from "../run_workspace_mount";

function makeScriptedDocker(
  handler: (argv: string[], stdin?: string) => DockerCliResult,
): DockerCli {
  return {
    async run(argv: string[], stdin?: string): Promise<DockerCliResult> {
      return handler(argv, stdin);
    },
  };
}

const VALID_DIGEST_IMAGE = `ghcr.io/example/py@sha256:${"a".repeat(64)}`;

describe("run_workspace_mount negative and boundary checks", () => {
  it("rejects non-digest-pinned and malformed digest images", () => {
    expect(isDigestPinnedImage("")).toBe(false);
    expect(isDigestPinnedImage("python:3.12-slim")).toBe(false);
    expect(isDigestPinnedImage("ghcr.io/example/py:latest")).toBe(false);
    expect(isDigestPinnedImage("ghcr.io/example/py@sha256:deadbeef")).toBe(false);
    expect(isDigestPinnedImage(VALID_DIGEST_IMAGE)).toBe(true);
  });

  it("creates unique ownership tokens and volume names for the same runId", () => {
    const first = createWorkspaceOwnership("shared-run");
    const second = createWorkspaceOwnership("shared-run");

    expect(first.runId).toBe("shared-run");
    expect(second.runId).toBe("shared-run");
    expect(first.ownerToken).not.toBe(second.ownerToken);
    expect(first.volumeName).not.toBe(second.volumeName);
    expect(Object.values(first.labels)).toContain(first.ownerToken);
    expect(Object.values(first.labels)).toContain("shared-run");
  });

  it("builds readonly /workspace volume mount args without bind mounts", () => {
    const args = buildRunCodeWorkspaceMountArgs("ws-vol-42");
    expect(args).toEqual([
      "--mount",
      "type=volume,src=ws-vol-42,dst=/workspace,readonly",
    ]);
    expect(args).not.toContain("-v");
    expect(args.join(" ")).not.toContain("type=bind");
  });

  it("fails closed in preflight when isolationPreflight fails", async () => {
    const mgr = new RunWorkspaceManager({
      image: VALID_DIGEST_IMAGE,
      dockerCli: makeScriptedDocker(() => ({ exitCode: 0, stdout: "", stderr: "" })),
      isolationPreflight: async () => ({ ok: false, reason: "cgroup v2 missing" }),
    });

    const res = await mgr.preflight();
    expect(res.ok).toBe(false);
    expect(res.blockerCode).toBe("WORKSPACE_ISOLATION_PREFLIGHT_FAILED");
  });

  it("fails closed in preflight on probe volume collision", async () => {
    const mgr = new RunWorkspaceManager({
      image: VALID_DIGEST_IMAGE,
      dockerCli: makeScriptedDocker((argv) => {
        if (argv[0] === "volume" && argv[1] === "inspect") {
          return { exitCode: 0, stdout: "[{}]", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
      isolationPreflight: async () => ({ ok: true }),
    });

    const res = await mgr.preflight();
    expect(res.ok).toBe(false);
    expect(res.blockerCode).toBe("WORKSPACE_VOLUME_COLLISION");
  });

  it("exports expected resource bounds and required docker flags", () => {
    expect(WORKSPACE_MAX_READ_BYTES).toBe(64 * 1024);
    expect(WORKSPACE_MAX_FILE_BYTES).toBe(256 * 1024);
    expect(WORKSPACE_MAX_TOTAL_BYTES).toBe(16 * 1024 * 1024);
    expect(WORKSPACE_UID_GID).toBe("65534:65534");
    expect(WORKSPACE_REQUIRED_DOCKER_FLAGS).toEqual([
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
    ]);
  });
});
