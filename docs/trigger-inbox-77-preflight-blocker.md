# Host-triggered event activation: blocked at integration preflight

Requested PR title: **Add host-triggered event activation**

Capability: `cap_trigger_inbox_77`

## Status

Not implemented. No scheduler, listener, runtime registration, or public trigger API is introduced. Existing runtime behavior is unchanged.

The supplied repository tree establishes candidate paths, but this execution environment provides neither file-reading nor shell tools. Consequently, shared campaign/activation admission and authoritative settlement cannot be verified or safely extended here. This is an access and verification blocker, not a finding that the repository's admission mechanism is inadequate.

The specification explicitly requires reporting blocked rather than implementing disconnected scheduler accounting. Adding a standalone reservation ledger, an assumed factory interface, or a mock runtime would not satisfy that requirement.

## Required evidence still unavailable

- Main commit SHA and the actual `package.json` test script.
- `AgentRuntime` construction, fresh-run execution, cancellation, and cleanup signatures.
- Shared admission reservation, attempt charging, settlement, and unknown-usage contracts, including delegated and auxiliary inference.
- ContextManager byte admission and typed untrusted IFC event-origin integration.
- Approval policy, exact-byte disclosure authorization, inference destination pinning, and service authorization contracts.
- Baseline installation and test results.

Neither `npm ci` nor baseline, targeted, or full-suite tests were executed. No green CI or implementation-readiness claim is made.

## First implementation gate

Inspect `src/runtime/agent_runtime.ts`, `src/runtime/deliberation/admission.ts`, and their callers before introducing scheduling. Establish whether the existing shared authority can atomically reserve a campaign parent's steps, inference attempts, tokens, and cost for an activation child before factory construction. Trace every inference path rather than assuming the main adapter covers delegation, review, verification, and auxiliary work.

The reservation handle must reach the actual runtime factory. Each attempt must charge exactly once; confirmed unused allowances must release exactly once. Unknown usage and unresolved required cleanup must retain their reservations and suspend further starts. Cancellation alone is not settlement authority. If the existing mechanism needs an extension, implement it there and test it before adding the inbox; do not substitute scheduler-local counters.

Also verify that a principal slot remains held through unresolved construction or cleanup. A stop racing asynchronous construction must fence late starts without falsely classifying ambiguous execution as a proven pre-start failure.

## Remaining integration gates

1. Trace ContextManager and IFC ingestion so event bytes remain measured, typed untrusted data, separate from the unchanged host task and runtime-owned unattended metadata. Require exact-byte disclosure authorization before inference.
2. Verify default-deny unattended approval, named host-pinned allow-tier tools, and noninteractive denial of ask-tier calls while preserving hooks, IFC, service authorizers, recovery, and completion gates.
3. Inspect `src/capabilities/trigger_registry_24.ts`, `webhook_gateway_24.ts`, and `background_lease_24.ts` for reusable contracts; their presence alone does not establish compatibility.
4. Only after these gates pass, implement the bounded inbox, canonical authenticated webhook protocol, epoch-derived scheduling, retained deduplication, lifecycle dispositions, and one bounded timer against the real runtime.

## Validation required before claiming delivery

Record the inspected SHA and test script. Run installation and baseline tests with pipeline exit status preserved, then execute the requested real-runtime/manual-clock and localhost webhook tests, followed by the entire repository suite. Include shared-budget exhaustion, delegated and auxiliary charging, exactly-once settlement, unknown reservation retention, concurrent claims, stop during factory construction, and principal-slot retention. Production activation must remain unavailable until these integration and safety requirements are implemented and verified.
