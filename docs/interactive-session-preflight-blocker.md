# Interactive session capability: preflight blocked

Status: **not implemented; not advertised as supported**.

The supplied repository listing identifies integration targets but does not expose their contents. This contribution environment provides no repository inspection, command execution, or Docker tools. Consequently, the required main-SHA inspection and baseline test execution could not be performed. No baseline logs or exit codes are available; no CI or container-continuity success is claimed.

## Required preflight before implementation

Inspect the actual implementations and their callers:

- `src/runtime/agent_runtime.ts`: run ownership, inference admission, delegation, cancellation, accounting and turn-loop lifecycle.
- `src/runtime/finalizer.ts`: gated publication, task-contract verification and cleanup ownership.
- `src/runtime/observation_store.ts` and `src/runtime/evidence_validator.ts`: observation identity, exposure, recall and citation scope.
- `src/runtime/recovery_ledger.ts`: cumulative recovery expenditure, unresolved operations and authoritative reconciliation.
- `src/runtime/run_workspace_mount.ts`: volume ownership, operation-container termination and cleanup gates.
- `src/context/context_manager.ts` and `src/context/digest_compaction.ts`: mandatory-state fit checks and permitted history reduction.
- Existing runtime and workspace tests, plus actual package scripts and test configuration.

Record the checked-out SHA and baseline full-suite output with its original exit code before changing runtime behavior or delegating tests. Separately record Docker availability. Publish concrete exported session signatures only after checking these interfaces.

## Integration constraints

Do not implement sessions by repeatedly invoking independent runs. That could reset accounting and recovery restrictions, lose unresolved-operation ownership, and release a workspace at the wrong boundary.

The implementation needs one session-owned logical run with explicit turn lifecycle hooks. Turn finalization must preserve session accounting, protected operation state and workspace ownership while resetting turn-local task, citation and exposure state. Existing non-session execution must retain its schemas, traces, adapter-call counts and cleanup timing.

Authenticated submission admission must be synchronous before asynchronous work. Deduplication must use RFC 8785 canonical identity, including host-pinned verifier identity rather than serialized callbacks. Authentication must precede registry lookup. A duplicate must return the original handle before the busy check; rejected new submissions must not reserve identifiers or consume turns.

Historical gated answers are untrusted, provenance-labelled data, not current evidence or instructions. Exact user instructions and unresolved-operation state must remain separately protected and counted during context admission. No rejected final candidate may become published history.

Expiry requires both bounded timer chunks and deadline checks at admission and dispatch. Session close must stop admissions, signal real runtime cancellation and retain cleanup responsibility whenever potentially live work prevents safe volume deletion.

## Verification still required

All requested acceptance tests remain outstanding, including real two-turn AgentRuntime execution, cumulative parent/child accounting, cross-turn evidence isolation, supervisor reconciliation, contract enforcement, history-injection boundaries, deduplication races, context overflow, expiry and cancellation.

Lease-management tests cannot establish real workspace continuity. Production container continuity and cancellation tests require a separate Docker-backed run; if unavailable, report them as blocked rather than substituting a mock.

This document intentionally adds no speculative SessionController, replacement agent loop or capability registration. Shipping such an interface without the required ownership inspection would misrepresent the capability and risk weakening existing isolation.
