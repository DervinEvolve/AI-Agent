# Isolated Python Mount (`cap_isolated_python_mount_28`)

## 256 KiB Bounded `ToolResult` Boundary

Node.js `child_process.spawn` pipes have a small OS buffer (~64 KiB) that blocks the child process if unread. The isolated Python runner continuously drains `stdout` and `stderr` past the 256 KiB (`262144` bytes) cap, discarding excess bytes and setting `output_truncated = true`. `ObservationStore` stores only that bounded `ToolResult`; raw bytes beyond 256 KiB are never retained.

## `classifyRunCode` and `RecoveryLedger.admit`

`classifyRunCode(result)` returns `'unknown'` whenever `termination_confirmed !== true` or `cleanup_confirmed !== true`. It returns `'success'` only when `status === 'ok'`, `output.outcome === 'completed'`, `output.exit_code === 0`, and both confirmations are `true`. All other both-confirmed results return `'known_failure'`.
