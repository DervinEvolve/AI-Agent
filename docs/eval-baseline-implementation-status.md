# Evaluation baseline: blocked-admission component only

This contribution does **not** implement the requested integrated evaluation runner and does not establish a live or scripted score. It adds a standalone, socket-free admission reporter with all six declared task entries, fixed diagnostic codes, unknown telemetry represented by null, credential exclusion and a 64 KiB serialized-byte guard.

## Published interfaces

`src/runtime/eval_baseline_blocked.ts` exports `BaselineAdmission`, `BlockedReason`, `BlockedTaskRecord`, `BlockedBaselineReport`, `BASELINE_TASK_IDS`, and these synchronous functions:

- `baselineAdmissionFailures(input: BaselineAdmission): BlockedReason[]`
- `createBlockedBaselineReport(input: BaselineAdmission): BlockedBaselineReport | null`
- `serializeBlockedBaselineReport(input: BaselineAdmission): string | null`

Capability booleans must come from host checks. They are not model assertions. A null return means only that these admission checks found no blocker, not that a trial ran or completion is allowed. The report uses a distinct blocked-only schema; suite identity fields remain null rather than hashing an invented manifest. Known aggregate attempted count is zero because admission was blocked; runtime telemetry is unknown.

## Remaining integration work

The actual AgentRuntime, ModelAdapter, ToolRegistry and Finalizer interfaces were not available for inspection in this editing context. No replacement runtime or guessed imports are introduced. Shared finalization contracts, canonical manifest hashing, runtime dispatch and recall-exposure telemetry, fixture registration, trial isolation, deadlines, usage admission, live transport preservation and the six executable contracts remain unimplemented. Ordinary runtime behavior is unchanged.

No filesystem or execution tools were available, so neither the required pre-change baseline nor the added tests were executed here; no exit code or successful CI result is claimed. The included Vitest tests cover only the blocked-report component, not runtime acceptance criteria. No independent test-subagent execution occurred.

An `npm run eval:baseline` script was not added: package-manifest edits are prohibited by the contribution boundary. A follow-up with inspected runtime sources and permission for the entrypoint wiring is required before this capability can be considered implemented. Until then, hosts using this component must set `harnessAvailable: false`.
