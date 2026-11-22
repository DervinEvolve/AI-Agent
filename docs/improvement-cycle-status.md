# Improvement cycle (cap_improvement_cycle_51): implementation status

`src/runtime/improvement_cycle.ts` exports `runImprovementCycle(config)`, which returns an `ImprovementReport`.

## Not wired in this PR

This change was written from the repository file listing only. The contents of `agent_runtime.ts`, `context_manager.ts`, `digest_compaction.ts`, `finalizer.ts` and the eval harness were not readable, so their signatures could not be published. The spec makes that a gate, and it is not met.

The module therefore imports nothing from the rest of the repo and edits no existing file. The following are still open:

- **No `TrialRunner` over the real harness and `AgentRuntime`.** The orchestrator calls an injected `runTrial(request)`. An adapter must run one harness execution and map the Finalizer's consolidated outcome onto `ConsolidatedOutcome`. `eval_baseline_blocked.ts` suggests the harness on main may itself be a blocked stub; check that first.
- **No admission hook in `agent_runtime.ts`.** `CycleAdmission` implements the atomic parent/child reservation, but the runtime does not call it yet. The runner must call `request.admission.reserve()` before every model send and `settle(ticket, usageUnits)` after.
- **No protected overlay section in `ContextManager` or digest compaction.** `renderStrategyGuidanceSection(overlay)` produces the labelled text. Rendering it below host instructions, counting it in context fit and excluding it from compaction input are not done.
- **No durable `OverlayStore`.** `InMemoryOverlayStore` is append-only and principal-bound, but it lasts only for the process. The cross-cycle holdout reuse count is only as durable as the store.
- **Scored-trial isolation is requested, not enforced.** Each request carries `memory: { writesDisabled: true, readSnapshotDigest }`, identical for every arm. Honouring it, and provisioning resources per trial, is the runner's job.
- **Spec acceptance tests that need the real runtime are not covered:** test 1 on the real harness, the compaction half of test 8, and "absent configuration: traces unchanged" in test 10. The last holds trivially today, because nothing imports this module.
- **The export preflight in the delivery clause was not run** (`npm ci`, baseline suite logs, main SHA).

## Implemented

- **Configuration.** Validation covers the principal, suite size and contracts, disjoint non-empty splits, numeric bounds, the incumbent overlay (digest checked against its bytes, or the explicit string `none`), digest opt-ins and the report bound. Any failure throws `ImprovementCycleConfigError` before a trial or proposer call.
- **Cycle.** Baseline on dev then holdout; a digest from baseline dev only; one admitted proposer call per candidate, each receiving the same deep-frozen request; the candidate replaces the incumbent overlay; holdout runs only after a dev gain; the first accepted candidate stops the cycle.
- **Scoring.** `scoreTrial` passes a trial only when finalization, evidence, verifier and lifecycle all pass. A result without a consolidated outcome is `infrastructure_error`.
- **Acceptance rule.** Strict dev gain and no holdout task lower. Ties reject. Any `infrastructure_error` or `not_run` trial gives `inconclusive` or `budget_exhausted`, and no comparison is computed.
- **Digest.** Values appear only if they belong to a runtime or host enum; anything else becomes `other`. Failed gates are derived from the outcome, not from runner-supplied strings. Other fields on a trial result are never read.
- **Overlay.** Host-minted digest, parent and generation. Malformed, empty, oversize, over-generation and identical-to-incumbent text is rejected, never truncated.
- **Admission.** `reserve()` is synchronous, so concurrent children stop exactly at the cap. A child charges the parent once. Unknown usage under a usage cap stops the cycle.
- **Persistence.** `kept` requires a store and a host authorizer that returns `true` for the exact text. Otherwise the result is `accepted_not_persisted`. Nothing is activated.
- **Report.** Per-task per-arm status counts, paired discordant counts per candidate (McNemar-ready), holdout touches this cycle, prior reuse read from the store, admission totals, and the statement that results are descriptive rather than proof.

## Behaviour to know about

- With `trialsPerTask > 1`, one flaky holdout trial rejects a candidate. Expect false rejects.
- A runner that lets a per-trial admission denial escape as an exception is scored `infrastructure_error`. Catch it and return a failed outcome if the trial budget running out should count as a task failure.
- A proposer that returns a bare string reports no usage. Under a usage cap that stops the cycle; return `{ text, usageUnits }` instead.
- The audit split, if set, runs both arms once after acceptance and draws on the same cycle caps.

The tests in `src/runtime/__tests__/improvement_cycle.test.ts` use a scripted runner and proposer. They are orchestration evidence only; no live cycle has been run.
