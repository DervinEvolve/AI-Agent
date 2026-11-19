import {
  buildRunCodeWorkspaceMountArgs,
  classifyWorkspaceTool,
  createWorkspaceOwnership,
  isDigestPinnedImage,
  RunWorkspaceManager,
  WORKSPACE_REQUIRED_DOCKER_FLAGS,
  WorkspaceQuarantineLedger,
  type DockerCli,
  type DockerCliResult,
} from "../run_workspace_mount";

function makeScriptedDocker(handler: (argv: string[], stdin?: string) => DockerCliResult): DockerCli {
  return {
    async run(argv: string[], stdin?: string): Promise<DockerCliResult> {
      return handler(argv, stdin);
    },
  };
}

describe("run_workspace_mount", () => {
  it("requires digest-pinned image in preflight", async () => {
    const mgr = new RunWorkspaceManager({
      image: "python:3.12-slim",
      dockerCli: makeScriptedDocker(() => ({ exitCode: 0, stdout: "", stderr: "" })),
    });
    const res = await mgr.preflight();
    expect(res.ok).toBe(false);
    expect(res.blockerCode).toBe("WORKSPACE_IMAGE_NOT_DIGEST_PINNED");
  });

  it("fails closed on throwaway probe volume collision", async () => {
    const mgr = new RunWorkspaceManager({
      image: "ghcr.io/example/py@sha256:" + "a".repeat(64),
      dockerCli: makeScriptedDocker((argv) => {
        if (argv[0] === "volume" && argv[1] === "inspect") {
          return { exitCode: 0, stdout: "[{}]", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    });
    const res = await mgr.preflight();
    expect(res.ok).toBe(false);
    expect(res.blockerCode).toBe("WORKSPACE_VOLUME_COLLISION");
  });

  it("generates independent unguessable volumes for concurrent invocations", () => {
    const a = createWorkspaceOwnership("run-1");
    const b = createWorkspaceOwnership("run-1");
    expect(a.volumeName).not.toBe(b.volumeName);
    expect(a.ownerToken).not.toBe(b.ownerToken);
  });

  it("builds readonly mount args for run_code and enforces required flags", () => {
    expect(buildRunCodeWorkspaceMountArgs("ws-123")).toEqual([
      "--mount",
      "type=volume,src=ws-123,dst=/workspace,readonly",
    ]);
    expect(WORKSPACE_REQUIRED_DOCKER_FLAGS).toContain("--network");
    expect(WORKSPACE_REQUIRED_DOCKER_FLAGS).toContain("--read-only");
    expect(WORKSPACE_REQUIRED_DOCKER_FLAGS).toContain("65534:65534");
  });

  it("classifies workspace tools and enforces mutator quarantine without bypass", () => {
    expect(
      classifyWorkspaceTool({
        status: "ok",
        termination_confirmed: false,
        output: { ok: true },
      })
    ).toBe("unknown");

    expect(
      classifyWorkspaceTool({
        status: "error",
        started: false,
        termination_confirmed: false,
      })
    ).toBe("pre_execution_rejected");

    const ledger = new WorkspaceQuarantineLedger(2);
    ledger.recordOutcome("write_file", "unknown");
    expect(ledger.isMutatorQuarantined()).toBe(true);
    expect(ledger.admit("edit_file").allowed).toBe(false);
    expect(ledger.admit("run_code").allowed).toBe(false);
    expect(ledger.admit("read_file", "r1").allowed).toBe(true);
    expect(ledger.admit("read_file", "r1").allowed).toBe(true);
    expect(ledger.admit("read_file", "r1").allowed).toBe(false);
    expect(ledger.isMutatorQuarantined()).toBe(true);
  });

  it("reports failed volume removal explicitly during cleanup", async () => {
    const mgr = new RunWorkspaceManager({
      image: "ghcr.io/example/py@sha256:" + "b".repeat(64),
      dockerCli: makeScriptedDocker((argv) => {
        if (argv[0] === "volume" && argv[1] === "inspect") {
          return { exitCode: 1, stdout: "", stderr: "no such volume" };
        }
        if (argv[0] === "volume" && argv[1] === "rm") {
          return { exitCode: 1, stdout: "", stderr: "volume in use" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    });
    const alloc = await mgr.allocateVolume();
    expect(alloc.ok).toBe(true);
    const cleanup = await mgr.cleanup();
    expect(cleanup.cleanup_confirmed).toBe(false);
    expect(cleanup.volumeRemoved).toBe(false);
    expect(cleanup.errors.length).toBeGreaterThan(0);
  });

  it("validates digest-pinned image helper", () => {
    expect(isDigestPinnedImage("repo/img@sha256:" + "0".repeat(64))).toBe(true);
    expect(isDigestPinnedImage("repo/img:latest")).toBe(false);
  });
});
