# Run-Scoped Workspace Mount (`cap_run_workspace_mount_31`)

## Overview
Provides a run-scoped Docker named volume mounted at `/workspace` for `list_files`, `read_file`, `write_file`, `edit_file`, and read-only `run_code` (`cap_28_amendment`).

## Ownership & Cleanup
- Every runtime invocation generates a unique `ownerToken` and labels both the volume and any spawned containers with `ai_agent.workspace_run_id` and `ai_agent.workspace_owner_token`.
- On `SIGKILL` or daemon failure, host operators may clean up orphaned resources by filtering on verified `ai_agent.workspace_owner_token` labels rather than broad prefix-based garbage collection.
