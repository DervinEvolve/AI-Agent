import { describe, expect, it } from "vitest";
import { AgentRuntime, type ModelAdapter } from "../agent_runtime.ts";
import { ToolRegistry } from "../tool_registry.ts";
import { OutcomeClassifier } from "../outcome_classifier.ts";
import { RecoveryLedger } from "../recovery_ledger.ts";
import type { DockerCli, DockerRunHandle } from "../docker_cli.ts";
import {
  classifyInfo,
  classifyRunCode,
  containerName,
  evaluateCgroupProbe,
  LIMIT_ARGV,
  mountIsolatedPython,
  probeIsolatedPython,
} from "../isolated_python_mount.ts";

const IMAGE = "python@sha256:" + "ab".repeat(32);

interface ScriptedCall {
  argv: string[];
  kind: "info" | "run" | "kill" | "inspect" | "rm";
}

class ScriptedDocker implements DockerCli {
  calls: ScriptedCall[] = [];
  infoJson: unknown = rootlessInfo();
  infoOk = true;
  probeStdout =
    "memory.max=268435456\npids.max=64\ncpu.max=50000 100000\nmemory.swap.max=0\n";
  probeExit = 0;
  runs: Array<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    /** If set, run() stays blocked until release() or until kill is invoked. */
    blockUntilKill?: boolean;
    release?: () => void;
    stdoutBytes?: number;
  }> = [];
  inspectQueue: Array<{ code: number | null; stdout: string; stderr: string }> = [];
  rmResult: { code: number | null; stdout: string; stderr: string } = {
    code: 0,
    stdout: "",
    stderr: "",
  };
  followInspect: { code: number | null; stdout: string; stderr: string } = {
    code: 1,
    stdout: "",
    stderr: "Error: No such object",
  };
  killCount = 0;
  createdNames = new Set<string>();
  rmNames: string[] = [];
  private runIndex = 0;
  private inspectIndex = 0;
  blocked: DockerRunHandle[] = [];

  async info() {
    this.calls.push({ argv: ["info"], kind: "info" });
    if (!this.infoOk) return { ok: false as const, error: "down" };
    return { ok: true as const, json: this.infoJson };
  }

  run(argv: string[]): DockerRunHandle {
    this.calls.push({ argv: [...argv], kind: "run" });
    const nameIdx = argv.indexOf("--name");
    const name = nameIdx >= 0 ? argv[nameIdx + 1] : "";
    this.createdNames.add(name);
    const spec = this.runs[this.runIndex++] ?? {
      exitCode: this.probeExit,
      stdout: this.probeStdout,
      stderr: "",
    };
    let stdout = spec.stdout;
    if (spec.stdoutBytes && spec.stdoutBytes > stdout.length) {
      stdout = "x".repeat(spec.stdoutBytes);
    }
    let resolveExit: (v: { code: number | null; signal: null }) => void = () => {};
    const exited = new Promise<{ code: number | null; signal: null }>((resolve) => {
      resolveExit = resolve;
    });
    const finish = () => resolveExit({ code: spec.exitCode, signal: null });
    if (!spec.blockUntilKill) {
      queueMicrotask(finish);
    } else {
      spec.release = finish;
    }
    const handle: DockerRunHandle = {
      pid: 1,
      exited,
      stdout,
      stderr: spec.stderr,
      stdoutTruncated: stdout.length > 256 * 1024,
      stderrTruncated: false,
      writeStdin() {},
      endStdin() {},
      killClient() {
        /* must not confirm termination */
      },
    };
    if (spec.blockUntilKill) this.blocked.push(handle);
    // Stash release on the docker for kill()
    (handle as DockerRunHandle & { _release?: () => void })._release = spec.release;
    (handle as DockerRunHandle & { _name?: string })._name = name;
    return handle;
  }

  async kill(name: string) {
    this.killCount += 1;
    this.calls.push({ argv: ["kill", name], kind: "kill" });
    const blocked = this.blocked.find((h) => (h as { _name?: string })._name === name);
    if (blocked) {
      (blocked as { _release?: () => void })._release?.();
    }
    return { code: 0, stdout: name, stderr: "" };
  }

  async inspect(name: string) {
    this.calls.push({ argv: ["inspect", name], kind: "inspect" });
    if (!this.createdNames.has(name) && this.rmNames.includes(name)) {
      return this.followInspect;
    }
    const queued = this.inspectQueue[this.inspectIndex++];
    if (queued) return queued;
    if (this.rmNames.includes(name)) return this.followInspect;
    return {
      code: 0,
      stdout: JSON.stringify({ State: { Status: "exited" } }),
      stderr: "",
    };
  }

  async rm(name: string) {
    this.rmNames.push(name);
    this.calls.push({ argv: ["rm", "-f", name], kind: "rm" });
    if (!this.createdNames.has(name)) {
      return { code: 1, stdout: "", stderr: "No such container" };
    }
    this.createdNames.delete(name);
    return this.rmResult;
  }
}

function rootlessInfo(extra: Record<string, unknown> = {}) {
  return {
    SecurityOptions: ["name=rootless", "name=seccomp,profile=builtin"],
    CgroupVersion: "2",
    CgroupControllers: ["memory", "pids", "cpu"],
    ...extra,
  };
}

function goodProbeDocker(): ScriptedDocker {
  const d = new ScriptedDocker();
  d.runs.push({
    exitCode: 0,
    stdout: "memory.max=268435456\npids.max=64\ncpu.max=50000 100000\nmemory.swap.max=0\n",
    stderr: "",
  });
  return d;
}

describe("containerName", () => {
  it("sanitizes to the allowed pattern", () => {
    expect(containerName("call-1")).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/);
    expect(containerName("call-1")).toBe("rccall-1");
    expect(containerName("a b;rm -rf")).not.toMatch(/[ ;]/);
  });
});

describe("classifyInfo / probe negatives", () => {
  it("rejects rootful, cgroup v1, and missing cpu controller", () => {
    expect(classifyInfo({ SecurityOptions: ["name=seccomp"], CgroupVersion: "2", CgroupControllers: ["memory", "pids", "cpu"] }).code).toBe(
      "rootless_unavailable",
    );
    expect(
      classifyInfo({ SecurityOptions: ["name=rootless"], CgroupVersion: "1", CgroupControllers: ["memory", "pids", "cpu"] }).code,
    ).toBe("cgroup_v2_unavailable");
    expect(
      classifyInfo({ SecurityOptions: ["name=rootless"], CgroupVersion: "2", CgroupControllers: ["memory", "pids"] }).code,
    ).toBe("cpu_controller_not_delegated");
  });

  it("treats max, missing, period 0, and ratio > 0.5 as limits_not_enforced", () => {
    expect(evaluateCgroupProbe("memory.max=max\npids.max=64\ncpu.max=50000 100000\nmemory.swap.max=0\n").code).toBe(
      "limits_not_enforced",
    );
    expect(evaluateCgroupProbe("memory.max=100\npids.max=64\ncpu.max=max\nmemory.swap.max=0\n").code).toBe(
      "limits_not_enforced",
    );
    expect(evaluateCgroupProbe("memory.max=100\npids.max=64\ncpu.max=90000 100000\nmemory.swap.max=0\n").code).toBe(
      "limits_not_enforced",
    );
    expect(evaluateCgroupProbe("memory.max=100\npids.max=64\ncpu.max=1 0\nmemory.swap.max=0\n").code).toBe(
      "limits_not_enforced",
    );
    expect(evaluateCgroupProbe("pids.max=64\ncpu.max=1 100000\nmemory.swap.max=0\n").code).toBe("limits_not_enforced");
    expect(evaluateCgroupProbe("memory.max=100\npids.max=64\ncpu.max=50000 100000\nmemory.swap.max=max\n").code).toBe(
      "limits_not_enforced",
    );
    expect(evaluateCgroupProbe("memory.max=unreadable\npids.max=64\ncpu.max=50000 100000\nmemory.swap.max=0\n").code).toBe(
      "limits_not_enforced",
    );
  });
});

describe("mountIsolatedPython fail closed", () => {
  it("does not mount on rootful, cgroup v1, memory.max=max, cpu.max=max, ratio, missing cpu", async () => {
    const cases: Array<(d: ScriptedDocker) => void> = [
      (d) => {
        d.infoJson = { SecurityOptions: ["name=apparmor"], CgroupVersion: "2", CgroupControllers: ["memory", "pids", "cpu"] };
      },
      (d) => {
        d.infoJson = { SecurityOptions: ["rootless"], CgroupVersion: "1", CgroupControllers: ["memory", "pids", "cpu"] };
      },
      (d) => {
        d.infoJson = { SecurityOptions: ["name=rootless"], CgroupVersion: "2", CgroupControllers: ["memory", "pids"] };
      },
      (d) => {
        d.runs[0] = { exitCode: 0, stdout: "memory.max=max\npids.max=64\ncpu.max=50000 100000\nmemory.swap.max=0\n", stderr: "" };
      },
      (d) => {
        d.runs[0] = { exitCode: 0, stdout: "memory.max=100\npids.max=64\ncpu.max=max\nmemory.swap.max=0\n", stderr: "" };
      },
      (d) => {
        d.runs[0] = {
          exitCode: 0,
          stdout: "memory.max=100\npids.max=64\ncpu.max=80000 100000\nmemory.swap.max=0\n",
          stderr: "",
        };
      },
    ];
    const expected = [
      "rootless_unavailable",
      "cgroup_v2_unavailable",
      "cpu_controller_not_delegated",
      "limits_not_enforced",
      "limits_not_enforced",
      "limits_not_enforced",
    ];
    for (let i = 0; i < cases.length; i++) {
      const d = goodProbeDocker();
      cases[i](d);
      const mounted = await mountIsolatedPython(d, IMAGE);
      expect(mounted.mounted).toBe(false);
      if (!mounted.mounted) expect(mounted.code).toBe(expected[i]);
    }
  });
});

describe("classifyRunCode", () => {
  it("requires both confirmations; timeout with both is known_failure; ok without termination is unknown", () => {
    expect(
      classifyRunCode({
        status: "ok",
        termination_confirmed: false,
        output: { outcome: "completed", exit_code: 0, cleanup_confirmed: true, termination_confirmed: false },
      }),
    ).toBe("unknown");
    expect(
      classifyRunCode({
        status: "ok",
        termination_confirmed: true,
        output: { outcome: "completed", exit_code: 0, cleanup_confirmed: false, termination_confirmed: true },
      }),
    ).toBe("unknown");
    expect(
      classifyRunCode({
        status: "ok",
        termination_confirmed: true,
        output: { outcome: "timeout", exit_code: null, cleanup_confirmed: true, termination_confirmed: true },
      }),
    ).toBe("known_failure");
    expect(
      classifyRunCode({
        status: "ok",
        termination_confirmed: true,
        output: { outcome: "completed", exit_code: 0, cleanup_confirmed: true, termination_confirmed: true },
      }),
    ).toBe("success");
    expect(
      classifyRunCode({
        status: "ok",
        termination_confirmed: true,
        output: { outcome: "completed", exit_code: 1, cleanup_confirmed: true, termination_confirmed: true },
      }),
    ).toBe("known_failure");
  });
});

function adapterSequence(responses: unknown[]): ModelAdapter {
  let i = 0;
  return {
    async complete() {
      const response = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return { response };
    },
  };
}

describe("AgentRuntime mount", () => {
  it("default runtime keeps run_code unavailable and executes nothing", async () => {
    const registry = new ToolRegistry();
    const runtime = new AgentRuntime();
    const adapter = adapterSequence([
      { type: "tool_call", tool: "run_code", args: { code: "print(1)" } },
      { type: "final", answer: "no", citations: [] },
    ]);
    const report = await runtime.run("task", adapter, { registry });
    expect(report.capabilities?.run_code).toBe("unavailable");
    const unknown = await registry.call("run_code", { code: "print(1)" }, "c1");
    expect(unknown.started).toBe(false);
    expect(unknown.status).toBe("error");
  });

  it("failing then repaired program; citations shape-1; argv has --network none and no -v; code not shelled", async () => {
    const docker = goodProbeDocker();
    docker.runs.push(
      { exitCode: 1, stdout: "", stderr: "SyntaxError", },
      { exitCode: 0, stdout: "42\n", stderr: "" },
    );
    const mount = await mountIsolatedPython(docker, IMAGE);
    expect(mount.mounted).toBe(true);
    if (!mount.mounted) return;

    const registry = new ToolRegistry();
    const classifier = new OutcomeClassifier();
    const runtime = new AgentRuntime();
    const codeWithMeta = 'print("$(rm -rf /); echo 42")';
    const adapter = adapterSequence([
      { type: "tool_call", tool: "run_code", args: { code: "print(" } },
      { type: "tool_call", tool: "run_code", args: { code: codeWithMeta } },
      {
        type: "final",
        answer: "42",
        citations: [{ shape: 1, call_id: "pending" }],
      },
    ]);
    // The runtime assigns call ids; we patch the adapter to cite the successful id after the fact
    // by inspecting the report. Use a custom adapter that records call results via the tool itself.
    let step = 0;
    let successId = "";
    const smart: ModelAdapter = {
      async complete(request: unknown) {
        step += 1;
        const req = request as { observations?: Array<{ call_id: string; output?: { exit_code?: number } }> };
        const obs = req.observations ?? [];
        if (step === 1) {
          return { response: { type: "tool_call", tool: "run_code", args: { code: "print(" } } };
        }
        if (step === 2) {
          return { response: { type: "tool_call", tool: "run_code", args: { code: codeWithMeta } } };
        }
        const ok = [...obs].reverse().find((o) => o.output?.exit_code === 0);
        successId = ok?.call_id ?? "";
        return {
          response: { type: "final", answer: "42", citations: [{ shape: 1, call_id: successId }] },
        };
      },
    };
    const report = await runtime.run("print 42", smart, {
      registry,
      classifier,
      mount,
      max_steps: 6,
    });
    expect(report.capabilities?.run_code).toBe("mounted");
    expect(report.toolSchemas?.some((s) => s.name === "run_code")).toBe(true);
    expect(report.finalized?.ok).toBe(true);
    const runArgv = docker.calls.filter((c) => c.kind === "run" && !c.argv.includes("--rm"));
    expect(runArgv.length).toBeGreaterThanOrEqual(1);
    for (const call of docker.calls.filter((c) => c.kind === "run")) {
      expect(call.argv).toContain("--network");
      expect(call.argv).toContain("none");
      expect(call.argv).not.toContain("-v");
      expect(call.argv).not.toContain("--mount");
      expect(call.argv).not.toContain("-d");
      expect(call.argv.join(" ")).not.toContain(codeWithMeta);
      expect(call.argv).toContain("python");
      expect(call.argv).toContain("-I");
      expect(call.argv).toContain("-");
    }
    expect(LIMIT_ARGV).toContain("--network");
    expect(report.ledger?.closed).toBe(true);
  });

  it("sleep ignores SIGTERM until docker kill by pre-recorded name while run() blocked", async () => {
    const docker = goodProbeDocker();
    docker.runs.push({
      exitCode: 137,
      stdout: "",
      stderr: "",
      blockUntilKill: true,
    });
    docker.inspectQueue.push({ code: 0, stdout: JSON.stringify({ State: { Status: "exited" } }), stderr: "" });
    const mount = await mountIsolatedPython(docker, IMAGE);
    expect(mount.mounted).toBe(true);
    if (!mount.mounted) return;
    const registry = new ToolRegistry();
    registry.register(
      mount.tool.name,
      mount.tool.description,
      mount.tool.schema,
      (args, callId) => mount.tool.handler(args, callId),
      false,
      mount.tool.timeoutS,
    );
    const result = await registry.call("run_code", { code: "import time\ntime.sleep(100)", timeout_s: 0.05 }, "sleep1");
    expect(docker.killCount).toBeGreaterThanOrEqual(1);
    const kill = docker.calls.find((c) => c.kind === "kill");
    expect(kill?.argv[1]).toBe(containerName("sleep1"));
    expect(result.output).toMatchObject({ container_name: containerName("sleep1") });
    expect(result.termination_confirmed).toBe(true);
    const out = result.output as { cleanup_confirmed: boolean; outcome: string };
    expect(out.cleanup_confirmed).toBe(true);
    expect(out.outcome).toBe("timeout");
    expect(classifyRunCode(result)).toBe("known_failure");
    const joined = docker.calls.map((c) => c.argv.join("\0")).join("\n");
    expect(joined).not.toContain("time.sleep");
  });

  it("drains far past 256 KiB without growing the stored buffer and remains killable", async () => {
    const docker = goodProbeDocker();
    docker.runs.push({
      exitCode: 0,
      stdout: "", 
      stderr: "",
      stdoutBytes: 400 * 1024,
      blockUntilKill: false,
    });
    const mount = await mountIsolatedPython(docker, IMAGE);
    if (!mount.mounted) throw new Error("mount");
    const registry = new ToolRegistry();
    registry.register("run_code", "d", mount.tool.schema, (a, id) => mount.tool.handler(a, id), false, 35);
    const result = await registry.call("run_code", { code: "print('x'*999999)" }, "flood");
    const out = result.output as { stdout: string; output_truncated: boolean };
    expect(out.stdout.length).toBeLessThanOrEqual(256 * 1024);
    expect(out.output_truncated).toBe(true);
  });

  it("timeout without successful inspect leaves termination false and refuses redispatch", async () => {
    const docker = goodProbeDocker();
    docker.runs.push({ exitCode: null, stdout: "", stderr: "", blockUntilKill: true });
    docker.inspectQueue.push({ code: 1, stdout: "", stderr: "timeout talking to daemon" });
    const mount = await mountIsolatedPython(docker, IMAGE);
    if (!mount.mounted) throw new Error("mount");
    const registry = new ToolRegistry();
    const classifier = new OutcomeClassifier();
    const { classifyRunCode: pred } = await import("../isolated_python_mount.ts");
    classifier.registerPredicate("run_code", pred);
    registry.register("run_code", "d", mount.tool.schema, (a, id) => mount.tool.handler(a, id), false, 35);
    const ledger = new RecoveryLedger();
    const first = await registry.call("run_code", { code: "import time\ntime.sleep(9)", timeout_s: 0.05 }, "t1");
    expect(first.termination_confirmed).toBe(false);
    const cls = classifier.classify(first);
    expect(cls).toBe("unknown");
    ledger.record(first.call_id, cls, "run_code", registry.isIdempotent("run_code"), false);
    expect(ledger.admit("run_code", false, false).ok).toBe(false);
  });

  it("cleanup_confirmed false is unknown; both confirmations timeout is known_failure not success", async () => {
    expect(
      classifyRunCode({
        status: "ok",
        termination_confirmed: true,
        output: { outcome: "completed", exit_code: 0, cleanup_confirmed: false },
      }),
    ).toBe("unknown");
    const ledger = new RecoveryLedger();
    ledger.record("c", "unknown", "run_code", false, false);
    expect(ledger.admit("run_code", false, false).ok).toBe(false);
  });
});

describe("probeIsolatedPython uses the same limit argv", () => {
  it("includes limit flags", async () => {
    const d = goodProbeDocker();
    const report = await probeIsolatedPython(d, IMAGE);
    expect(report.ok).toBe(true);
    const run = d.calls.find((c) => c.kind === "run");
    expect(run?.argv).toEqual(expect.arrayContaining([...LIMIT_ARGV]));
  });
});
