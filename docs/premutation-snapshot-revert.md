# Pre-mutation snapshot + `revert_file`

## Mechanism

- **Snapshot-on-first-write**: before the first mutation of a file within an
  intent, `PreMutationSnapshotStore.capture(intentId, path)` copies the file's
  bytes (and mode) into a per-intent store keyed by `(intent_id, path)`.
  Subsequent repair attempts in the same intent share that one snapshot.
- **Gate-pass discard**: when the post-edit verification gate (parse/syntax,
  then lint/tests if configured) passes, the intent's snapshots are discarded —
  committed edits are never revertible.
- **Exhaustion auto-revert**: when the recovery allowance hits zero while the
  gate still fails, `autoRevertExhaustedIntent` reverts every snapshot in the
  intent (all-or-nothing: restore all files, then discard) and returns a
  structured note (path, attempts, last gate error, baseline confirmation)
  appended to the agent's context, instructing it to treat the file as
  unchanged and replan or report blocked.
- **Explicit `revert_file` tool**: lets the agent voluntarily abandon an edit.
  Idempotent (no snapshot → no-op), intent-scoped, and it never touches files
  outside the intent's snapshot set.

## Safety semantics

- Capture failures are contained and never break the tool call.
- Restore is overwrite-only: files created after the snapshot are left alone.
- Revert ordering is restore-then-discard, so a crash mid-revert leaves
  snapshots valid for a retry — the workspace never stays half-migrated.
- Permissions are restored alongside bytes.

## Integration seams

`src/runtime/premutation_snapshot.ts` exposes the store with an injected fs
surface (`SnapshotFs`) so hosts (`agent_runtime.ts`, `tool_registry.ts`,
`recovery_ledger.ts`) can wire real filesystem adapters; tests use in-memory
adapters. `src/runtime/revert_file_tool.ts` provides the tool descriptor and
the exhaustion auto-revert entry point.
