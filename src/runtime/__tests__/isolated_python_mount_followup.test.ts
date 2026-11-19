import { describe, expect, it } from "vitest";
import { AgentRuntime, type ModelAdapter } from "../agent_runtime.ts";
import { OutcomeClassifier } from "../outcome_classifier.ts";
import { RecoveryLedger } from "../recovery_ledger.ts";
import { ToolRegistry } from "../tool_registry.ts";
import type { DockerCli, DockerRunHandle } from "../docker_cli.ts";
import {
  classifyRunCode,
  containerName,
  evaluateCgroupProbe,
  LIMIT_ARGV,
  mountIsolatedPython,
  probeIsolatedPython,
} from "../isolated_python_mount.ts";

const IMAGE = "python@sha256:" + "cd".repeat(32);

function rootlessInfo() {
  return {
    SecurityOptions: ["name=rootless", "name=seccomp"],
    CgroupVersion: "2",
    CgroupDriver: "systemd",
  };
}

function okProbe() {
  return "memory.max=268435456\npids.max=64\ncpu.max=50000 100000\nmemory.swap.max=0\n";
}

class NegDocker implements DockerCli {
  infoJson: unknown = rootlessInfo();
  probeStdout = okProbe();
  probeExit = 0;
  runs: string[][] = [];
  delegated = "memory pids cpu";

  async info() {
    return { ok: true as const, json: this.infoJson };
  }

  run(argv: string[]): DockerRunHandle {
    this.runs.push([...argv]);
    const isProbe = argv.includes("cat") || argv.join(" ").includes("memory.max") || argv.some((a) => a.includes("memory.max"));
    const stdout = isProbe || argv.includes("-c") ? this.probeStdout : "";
    // Probe is identified by the python snippet reading cgroup files.
    const codeArg = argv[argv.length - 1] ?? "";
    const text = this.probeStdout;
    let resolveExit!: (v: { code: number | null; signal: null }) => void;
    const exited = new Promise<{ code: number | null; signal: null }>((r) => {
      resolveExit = r;
    });
    const handle: DockerRunHandle = {
      pid: 1,
      exited,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      writeStdin(data: string) {
        // Probe reads cgroup files via stdin python. Emit the scripted probe text.
        void data;
        handle.stdout = text;
      },
      endStdin() {
        resolveExit({ code: this.probeExit, signal: null });
      },
      killClient() {
        resolveExit({ code: null, signal: null });
      },
    };
    // Some probes pass code as an argv element rather than stdin.
    if (codeArg.includes("memory.max") || argv.some((a) => a.includes("cpu.max"))) {
      handle.stdout = text;
      queueMicrotask(() => resolveExit({ code: this.probeExit, signal: null }));
    }
    void isProbe;
    return handle;
  }

  async kill() {
    return { code: 0, stdout: "", stderr: "" };
  }
  async inspect() {
    return { code: 0, stdout: JSON.stringify({ State: { Status: "exited" } }), stderr: "" };
  }
  async rm() {
    return { code: 0, stdout: "", stderr: "" };
  }
}

describe("cap_isolated_python_mount_28 follow-up", () => {
  it("evaluateCgroupProbe rejects max, missing cpu, period 0, and ratio above 0.5", () => {
    expect(evaluateCgroupProbe(okProbe()).ok).toBe(true);
    expect(evaluateCgroupProbe("memory.max=max\npids.max=64\ncpu.max=50000 100000\n").ok).toBe(false);
    expect(evaluateCgroupProbe("memory.max=max\npids.max=64\ncpu.max=50000 100000\n").code).toBe(
      "limits_not_enforced",
    );
    expect(evaluateCgroupProbe("memory.max=268435456\npids.max=64\ncpu.max=max\n").code).toBe(
      "limits_not_enforced",
    );
    expect(evaluateCgroupProbe("memory.max=268435456\npids.max=64\n").code).toBe("limits_not_enforced");
    expect(evaluateCgroupProbe("memory.max=268435456\npids.max=64\ncpu.max=100000 0\n").code).toBe(
      "limits_not_enforced",
    );
    expect(
      evaluateCgroupProbe("memory.max=268435456\npids.max=64\ncpu.max=100000 100000\n").code,
    ).toBe("limits_not_enforced");
    // 50000/100000 == 0.5 is the ceiling and must pass.
    expect(evaluateCgroupProbe("memory.max=100\npids.max=1\ncpu.max=50000 100000\n").ok).toBe(true);
    expect(evaluateCgroupProbe("memory.max=268435457\npids.max=64\ncpu.max=50000 100000\n").code).toBe(
      "limits_not_enforced",
    );
    expect(evaluateCgroupProbe("memory.max=268435456\npids.max=65\ncpu.max=50000 100000\n").code).toBe(
      "limits_not_enforced",
    );
  });

  it("containerName is stable, sanitized, and distinct from the raw call id", () => {
    const a = containerName("call/with spaces;rm -rf");
    const b = containerName("call/with spaces;rm -rf");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/);
    expect(a.includes(" ")).toBe(false);
    expect(a.includes(";")).toBe(false);
    expect(containerName("other")).not.toBe(a);
  });

  it("classifyRunCode: success only with both confirmations, completed, exit 0", () => {
    const base = {
      status: "ok",
      termination_confirmed: true,
      output: {
        outcome: "completed",
        exit_code: 0,
        cleanup_confirmed: true,
        termination_confirmed: true,
      },
    };
    expect(classifyRunCode(base)).toBe("success");
    expect(
      classifyRunCode({
        ...base,
        output: { ...base.output, cleanup_confirmed: false },
      }),
    ).toBe("unknown");
    expect(
      classifyRunCode({
        status: "ok",
        termination_confirmed: false,
        output: { outcome: "completed", exit_code: 0, cleanup_confirmed: true },
      }),
    ).toBe("unknown");
    expect(
      classifyRunCode({
        status: "ok",
        termination_confirmed: true,
        output: { outcome: "timeout", exit_code: 137, cleanup_confirmed: true, termination_confirmed: true },
      }),
    ).toBe("known_failure");
    expect(
      classifyRunCode({
        status: "ok",
        termination_confirmed: true,
        output: { outcome: "completed", exit_code: 1, cleanup_confirmed: true, termination_confirmed: true },
      }),
    ).toBe("known_failure");
    expect(classifyRunCode({ status: "ok", output: { outcome: "completed", exit_code: 0 } })).toBe(
      "unknown",
    );
  });

  it("unknown classification refuses same-tool redispatch on the ledger", () => {
    const ledger = new RecoveryLedger();
    const cls = classifyRunCode({
      status: "ok",
      termination_confirmed: true,
      output: { outcome: "completed", exit_code: 0, cleanup_confirmed: false },
    });
    expect(cls).toBe("unknown");
    ledger.admit("run_code", false, false);
    ledger.record("c1", cls, "run_code", false, false);
    expect(ledger.admit("run_code", false, false)).toBe(false);
  });

  it("probe argv includes the limit flags and never a volume mount", async () => {
    const docker = new NegDocker();
    const report = await probeIsolatedPython(docker);
    expect(report.ok).toBe(true);
    const probeRun = docker.runs.find((argv) => argv.includes("run") || argv[0] === "run");
    expect(probeRun).toBeTruthy();
    const joined = (probeRun ?? []).join("\0");
    for (const flag of ["--network", "none", "--cpus", "0.5", "--memory", "256m", "--pids-limit", "64"]) {
      expect(probeRun).toContain(flag);
    }
    expect(joined.includes("-v") || (probeRun ?? []).includes("-v")).toBe(false);
    expect(probeRun).not.toContain("--mount");
    expect(probeRun).not.toContain("--privileged");
    expect(LIMIT_ARGV).toContain("--network");
    expect(LIMIT_ARGV).toContain("none");
  });

  it("rootful daemon does not mount and AgentRuntime keeps run_code unavailable", async () => {
    const docker = new NegDocker();
    docker.infoJson = { SecurityOptions: ["name=seccomp"], CgroupVersion: "2" };
    const mount = await mountIsolatedPython(docker, IMAGE);
    expect(mount.mounted).toBe(false);
    if (!mount.mounted) expect(mount.code).toBe("rootless_unavailable");

    const registry = new ToolRegistry();
    const classifier = new OutcomeClassifier();
    const runtime = new AgentRuntime();
    const adapter: ModelAdapter = {
      async complete() {
        return {
          response: {
            type: "final",
            answer: "done",
            citations: [],
          },
        };
      },
    };
    const report = await runtime.run("task", adapter, {
      registry,
      classifier,
      toolSchemas: [],
    });
    expect(report.capabilities?.run_code ?? report.trace?.capabilities?.run_code).not.toBe("mounted");
    const called = await registry.call("run_code", { code: "print(1)" }, "nope");
    expect(called.started).toBe(false);
  });
});
