# Context compaction, digest slice (cap_context_compaction_mount_38) - status

**Status: core shipped, NOT mounted on AgentRuntime. Compaction on the real loop is blocked.**

## What is in this change

`src/context/digest_compaction.ts`, a self-contained module with its own tests
(`src/context/__tests__/digest_compaction.test.ts`):

- `measureRequestBytes(request, headroom)` - one byte measure (UTF-8 bytes of
  the exact JSON serialization plus response headroom), intended to be shared
  by admission and compaction.
- `parseContextCompactionOption` - strict validation of the proposed
  `HostConfig.contextCompaction` value (unknown keys such as `summarizer` throw).
- `DigestCompactor` - render-time, sticky, oldest-first compaction of atomic
  turn groups into a runtime-authored metadata digest (max 4096 bytes), with
  pinned groups, `keepRecentGroups`, the 70% best-effort target, the terminal
  overflow rule and a bounded compaction record. No model call.
- `createListRecallsTool` - strict-args, read-only, metadata-only listing with
  the 4096-byte output bound, plus `isListRecallsSuccess`.

## What is not in this change

The author had only the repository file listing, not file bodies. The
signatures of `ContextManager`, the existing request-size admission,
`ObservationStore`, `ToolRegistry`, `OutcomeClassifier`, `HostConfig` and the
`AgentRuntime` loop were therefore unverified, and the spec forbids importing
imagined symbols. Consequently:

- `HostConfig.contextCompaction` is **not** read by `AgentRuntime`; behaviour of
  every existing run is unchanged (no existing file was edited).
- `list_recalls` is **not** registered in `ToolRegistry` or the shared
  `OutcomeClassifier`. The unknown-key rejection is tested on the tool's own
  `execute`, not through `ToolRegistry.call`.
- Existing admission was not inspected, so it is unknown whether it already
  measures the complete serialized request; no equality with the on-main
  admission is claimed.
- No golden-trace test, no real-runtime long-run test, no EvidenceValidator /
  Finalizer citation test, no wire-level (`live_chat_wire`) pairing test.
- Self-review and delegation interactions are omitted.

The tests here exercise the module with synthetic groups only. They are not
evidence that the runtime compacts, and nothing here supports an improvement
claim.

## Next step to mount

With file bodies available: adapt transcript groups to `TurnGroup`, pass the
runtime's real request builder to `DigestCompactor.render`, route admission
through `measureRequestBytes`, map `ObservationStore` entries to `RecallEntry`
for `createListRecallsTool`, and add the golden-trace and real-runtime tests
from the spec's acceptance list.
