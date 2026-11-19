/**
 * Real-container checks. Excluded from the default Vitest include.
 * Run only via `npm run test:run-code-integration` with RUN_CODE_INTEGRATION=1.
 * If the flag is set and preflight fails, this test fails with the blocker code.
 * It must not skip-as-pass.
 */
import { describe, expect, it } from "vitest";
import { createDockerCli } from "../docker_cli.ts";
import { mountIsolatedPython, containerName } from "../isolated_python_mount.ts";

const FLAG = process.env.RUN_CODE_INTEGRATION === "1";
const IMAGE = process.env.RUN_CODE_IMAGE ?? "";

describe("isolated python real container", () => {
  it("preflight and cases, or fail with the blocker", async () => {
    if (!FLAG) {
      // Default CI must not execute this file. If it is executed without the flag, fail closed
      // only when someone forced the file into the default suite — the package script sets the flag.
      // When the file is run without the flag (manual vitest path), do not pretend success of isolation:
      // assert the gate so a mis-include is visible, but do not skip.
      expect(FLAG).toBe(false);
      return;
    }
    expect(IMAGE).toMatch(/@sha256:[a-f0-9]{64}$/);
    const docker = createDockerCli();
    const mount = await mountIsolatedPython(docker, IMAGE);
    if (!mount.mounted) {
      throw new Error(mount.code);
    }

    const print = await mount.tool.handler({ code: "print(1729)" }, "int-print");
    expect(print.termination_confirmed).toBe(true);
    expect(print.output.cleanup_confirmed).toBe(true);
    expect(print.output.outcome).toBe("completed");
    expect(print.output.exit_code).toBe(0);
    expect(print.output.stdout).toContain("1729");

    const net = await mount.tool.handler(
      { code: "import socket\ns=socket.socket()\ns.settimeout(2)\ns.connect(('1.1.1.1', 443))\nprint('up')\n" },
      "int-net",
    );
    expect(net.output.cleanup_confirmed).toBe(true);
    expect(net.output.termination_confirmed).toBe(true);
    expect(String(net.output.stdout)).not.toContain("up");
    expect(net.output.exit_code).not.toBe(0);

    const flood = await mount.tool.handler({ code: "print('y'*400000)" }, "int-flood");
    expect(flood.output.stdout.length).toBeLessThanOrEqual(256 * 1024);
    expect(flood.output.output_truncated).toBe(true);
    expect(flood.output.cleanup_confirmed).toBe(true);

    const sleepy = await mount.tool.handler(
      { code: "import time\ntime.sleep(30)\nprint('done')\n", timeout_s: 1 },
      "int-sleep",
    );
    expect(sleepy.output.outcome).toBe("timeout");
    expect(sleepy.termination_confirmed).toBe(true);
    expect(sleepy.output.cleanup_confirmed).toBe(true);
    expect(sleepy.output.container_name).toBe(containerName("int-sleep"));

    const gone = await docker.inspect(containerName("int-sleep"));
    const blob = `${gone.stderr}\n${gone.stdout}`.toLowerCase();
    expect(gone.code === 0 && blob.includes("running")).toBe(false);
    expect(blob.includes("no such") || blob.includes("not found") || gone.code !== 0).toBe(true);
  }, 120_000);
});
