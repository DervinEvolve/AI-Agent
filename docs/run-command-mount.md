# run_command mount (cap_run_command_mount_35)

Repository-backed mount of fixed-argv command execution onto AgentRuntime.

`run_command` executes a tokenized argv through a trusted container backend with
no network, a writable workspace mount, and bounded scratch. It is a workspace
mutator under the same serialization, quarantine, and lifecycle gates as
`write_file`/`edit_file`.

## Boundary

- The runtime never constructs a shell command line (`sh -c`, `bash -c`,
  `shell=True`, or string interpolation).
- argv entries are literal data; metacharacters are never parsed by the runtime.
- A dispatcher-level heuristic rejects argv[0] basenames that are shells
  (`sh`, `bash`, `dash`, `zsh`, `ash`, `busybox`). This is not a security
  boundary; transitive shell use inside the container is normal build behavior.
- The trusted backend forks and execs argv directly (execvp-style PATH lookup).
- Command stdout/stderr are untrusted fields and can never forge exit status or
  lifecycle evidence.

## Lifecycle and classification

- `started=false` (invalid_args, rejected, unknown tool) is a pre-execution
  rejection: repairable, no recovery slot.
- `exit_code=0` with `termination_confirmed=true` and `cleanup_confirmed=true`
  is success.
- Non-zero exit or signal termination with confirmed lifecycle is
  `known_failure` and enters the recovery ledger.
- ENOENT spawn failure with confirmed lifecycle is `known_failure` with a
  distinct code.
- Missing/malformed report, unconfirmed termination, or unconfirmed cleanup is
  `unknown`.
- A client timeout yields `unknown` with `termination_confirmed=false`; no
  automatic retry is permitted.
