# Speculative edit alternatives (cap_edit_alternatives_67): blocked

Status: **blocked, contract slice only**. The capability is not mounted, no
tools are registered, and nothing in `AgentRuntime` changes.

## What landed

`src/runtime/alternatives/types.ts` (imports nothing) and its unit tests:

- Types: `AlternativesConfig`, `AlternativesPort`, `AttemptResult`,
  `AttemptRecord`, `PublicationRecord`, `AlternativeSetState`.
- `ALTERNATIVES_REASONS` and `ALTERNATIVES_CAPS` (inclusive ranges).
- `truncateUtf8Bytes`, `matchProtectedPath`, `classifyDiff`, `classifyScore`,
  `computeEligibility`, `rankAlternatives`.
- `boundAttemptResult`: the transcript view under a **total** 8 KiB budget.
  The per-field caps do not imply it (32 x 256 bytes is already 8192), so the
  serialized size is enforced. Drop order: last path first, then last
  citation. `elided_count` and `citation_elided_count` are updated.
- Publication helpers that read the record only: `reconcilePublication`,
  `isPublicationUnresolved`, `parentUnchanged`, `discardRefusal`.
- `resolveAlternativesCaps`, `planAttemptReservation`, `startupRejections`.

## Why the rest is blocked

The spec says to report the capability blocked, rather than write a second
loop or a name-list freeze, when main lacks either of these:

1. **A mounted child-loop factory.** `docs/subagent-delegation-mount-blocker.md`
   exists on main, which indicates that the real child loop is not mounted.
2. **A shared workspace admission and lock layer.** The freeze must refuse
   every parent-scoped mutation route, including host-registered mutators, at
   that layer. No such file appears in the repository listing.

An isolated check backend bound to a read-only sealed snapshot was also not
identified. `docs/isolated-python-mount.md` exists but was not read.

## Limits of this assessment

The author of this slice worked from a file listing only, and the listing was
cut off after `src/runtime/lesson_memory_mount.ts`. Therefore:

- The main SHA, the `package.json` test script, and the signatures of
  `AgentRuntime`, `ToolRegistry`, `EvidenceValidator`, `Finalizer`, `run_check`
  and any RecoveryLedger were **not recorded**. No file contents were
  available.
- The two blockers above are inferred from file names, not from reading the
  code. Files beyond the cut-off may change the picture.
- `npm ci` and a baseline vitest run were **not** performed before push. The
  new tests were written against the implementation by inspection, and CI is
  their first execution.
- `truncateUtf8Bytes` is a new helper. `sliceLogBytes` in
  `src/runtime/jobs/types.ts` may overlap, but its signature could not be
  checked, so it was not imported. It should be consolidated if equivalent.

## To unblock

1. Read the delegation blocker doc and confirm whether a child-loop factory
   can be mounted; reuse its supervision for the synchronous attempt loop.
2. Add or locate the workspace admission layer and put the freeze there.
3. Bind the pinned check to the existing isolated backend with a read-only
   snapshot mount.
4. Then wire the five tools, the EvidenceValidator scope rule and the
   Finalizer teardown, and add the AgentRuntime-driven acceptance tests from
   the spec against an in-memory port and an injected clock.

No claim is made that best-of-two improves task success.
