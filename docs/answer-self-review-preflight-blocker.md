# Answer self-review: preflight blocked

Capability: `cap_answer_self_review_33`

Delivery: **Specified — implementation blocked pending source inspection.**

No runtime integration or improvement claim is made. This document does not enable self-review or change existing runtime behavior.

## Missing inspection access

The supplied repository listing establishes file paths, but not their contents, exports, or current main commit SHA. This contribution environment provides no repository-reading or command-execution tool. Consequently, the required pre-coding inspection cannot be completed safely.

In particular, these facts remain unverified:

- Main SHA and the full `HostConfig` definition.
- `ModelAdapter.complete` input/output types and whether content-only critique responses can traverse the adapter without action decoding.
- `AgentRuntime.run` orchestration, inference admission, usage accounting, deadline handling, reject accounting, and terminal-state precedence.
- `ActionDecoder` accepted final-answer envelope and multiple-action rejection behavior.
- Ordinary transcript rendering and `ContextManager` request-size admission, including protected runtime state.
- `Finalizer` entry point and consolidated evidence, contract, lifecycle, recovery, and cleanup gates.
- Transport behavior for omitted `tools` and `tool_choice`, and unexpected response `tool_calls`.
- Evaluation report and trial-trace types, plus actual public interfaces used by the existing runtime and localhost fixtures.

Publishing signatures, method bodies, a main SHA, or a symbol-to-test map without that inspection would fabricate repository facts. Adding a standalone review loop would not satisfy the required real-runtime mount.

## Required unblock

Provide a repository checkout with read and command-execution access, or provide the current main SHA and source contents for:

- `src/runtime/agent_runtime.ts`
- `src/runtime/action_decoder.ts`
- `src/runtime/finalizer.ts`
- `src/runtime/runtime_context.ts`
- `src/runtime/live_chat_wire.ts`
- `src/runtime/live_model_transport.ts`
- `src/context/context_manager.ts`
- `src/runtime/evidence_validator.ts`
- `src/runtime/eval_baseline_blocked.ts`
- Their existing runtime, transport, context, and evaluation tests.

Follow imports as needed to locate the actual adapter, host configuration, admission, and evaluation trace definitions. Publish the inspected signatures and relevant method bodies before implementation or test delegation. If content-text critique responses require an adapter extension, document the additive types before implementing that boundary.

## Implementation constraints after inspection

Keep orchestration in the real runtime: retain the first decoded final-answer candidate; admit at most one critique and one revision through existing inference/context/deadline accounting; dispatch no tools during either phase; and finalize exactly one selected candidate. A well-formed revision remains selected even if consolidated completion gates reject it. Review-local failures may fall back to the original, but independently terminal conditions retain precedence.

Implement the specified strict `parseCritique` contract only after preflight. Keep review records separate from evidence. Preserve disabled-path call counts and ordinary rejection accounting. Add optional evaluation trace metadata through the actual inspected harness type, without editing the frozen evaluation suite.

## Validation status

No implementation tests or complete-suite execution were performed in this environment. No passing CI result, endpoint evaluation, or inspected symbol-to-test map is asserted.

After implementation, exercise the specified public-runtime and localhost acceptance cases, including UTF-8 byte boundaries, tool-call rejection without dispatch, irreversible revised-candidate selection, and terminal-condition precedence. Run the entire existing suite in a shell with `set -o pipefail`, preserving the real `npm test` exit code. Delivery remains Specified until the implementation merges with green CI.

Acceptance and revision statuses describe candidate selection only; neither constitutes correctness, independent verification, or demonstrated improvement.
