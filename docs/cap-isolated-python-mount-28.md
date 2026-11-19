# cap_isolated_python_mount_28

Repository-backed mount of isolated Python onto AgentRuntime. `run_code` executes only in a fresh rootless container after preflight proves the daemon is rootless, cgroup v2 is active, and memory, pids, and cpu limits are enforced inside the container's own cgroup (`memory.max`, `pids.max`, `cpu.max`, `memory.swap.max`).

Unconfigured runs keep `capabilities.run_code` as `unavailable`. There is no host Python, subprocess, or simulated backend. A client timeout, a docker-run error, or killing the attached CLI does not set `termination_confirmed`. That flag is true only when `docker inspect` shows `State.Status` of `exited` or `dead`. `cleanup_confirmed` is true only after `docker rm -f` and a follow-up inspect shows the name is gone. The recorded `container_name` is chosen before spawn; a name this attempt did not create is never removed.

Default Vitest does not start Docker. `npm run test:run-code-integration` runs the real-container file only when `RUN_CODE_INTEGRATION=1`. If that flag is set and preflight fails, the test fails with the blocker code and does not skip. A green default CI run does not prove isolation. Workspace files are not visible to `run_code`. This document is not a scored eval admission.
