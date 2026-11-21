# Durable runs mount (cap_durable_runs_mount_41)

Stage A file-backed slice beside `run_workspace_mount.ts` and `isolated_python_mount.ts`. It is not a second runtime loop.

## Ownership

`node:fs` does not provide `FileHandle.lock` or `flock` (nodejs/node#54446, closed not-planned). This mount does not claim a process-lifetime kernel lock. Initial ownership is exclusive-create (`O_EXCL` / `wx` equivalent). A leftover `owner.lock` blocks resume. Lock age, mtime, and PID are never treated as cessation.

Crash takeover requires a supervisor attestation bound to the run id, principal, and the exact previous generation, plus a non-empty attestation token. Concurrent takeover uses an exclusive-create taking file so both requests cannot succeed. A dishonest host attestation is outside the guarantee.

Death of the runtime owner does not prove tool, container, or descendant cleanup. Those operations stay `unknown` and quarantined.

## Journal

Append-only RFC 8785 canonical JSONL, hash-chained, bound to run, principal, and owner generation. Immutable digest-named blobs hold arguments, tool results, and transition payloads. Checkpoints use a unique temp file, fsync, atomic rename, and directory fsync where the platform supports it.

Torn tails, chain breaks, symlink paths, and missing settlement blobs fail closed. No silent truncation and no rewrite of a post-effect failure into `started=false`.

## Production mount

If directory fsync is unsupported, or ownership cannot be enforced, executable production resume stays unavailable. Storage helpers may still be used by tests with `requireDirectoryFsync: false`.

## Stage B

`ask_user` is not registered in this slice. Naming it for delegation is out of scope until a trusted `ClarificationChannel` exists.

## Replay

Completed dispatches are never replayed. Unsettled `dispatch_intent` and `inference_intent` records become unknown. With an active usage cap, unsettled inference admits no further adapter call. Restoration is the same logical run only.
