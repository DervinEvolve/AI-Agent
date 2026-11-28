# Dependency-aware goal planning: partial implementation

This change provides real, additive pure graph primitives, not the mounted cap_goal_planner_83 capability. No runtime files are changed and no planner inference or report_goal tool is registered. Disabled runtime behavior is consequently unchanged.

## Exported interfaces

`src/runtime/planning/index.ts` exports GoalNode, GoalProgress, GoalGraph, GoalPlannerConfig, PlanningRecord, PlanningReasonCode, planningReasonCodes and PlanningResult<T>.

- `validateGoalProposal(json, config?)` returns `PlanningResult<readonly GoalNode[]>`.
- `createGoalGraph(rootTaskDigest, json, config?)` returns `PlanningResult<GoalGraph>`.
- `reviseGoalGraph(graph, json, {reopen, abandon}, config?)` returns `PlanningResult<GoalGraph>`.
- `readyGoals(graph)` returns IDs in proposal order.
- `selectGoal(graph, recoveryHold)` returns an ID or null, preserving existing active focus during a hold.
- `activateGoal(graph, activationIndex, recoveryHold)` returns immutable state, unchanged during a hold.
- `planningStatus(graph)` returns revision, reported achievement count, abandoned/unresolved IDs and counts. This is not yet the full runtime terminal envelope.

Results use `{ok:true,value}` or `{ok:false,reason}`. Invalid host limits throw RangeError. Graphs passed to transitions must originate from these helpers or trusted host state; they are not a wire ingestion interface. Proposal JSON accepts only `{nodes:[{id,objective,acceptance_hint,depends_on}]}`. Runtime progress cannot be supplied through proposals. Revisions preserve all lifetime IDs and evidence references; reopen propagation is transitive. No helper equates reported achievement with verified completion.

## Unverified integration prerequisites

Only a file listing was available in this contribution environment; no filesystem, repository URL, shell or test runner was exposed. Fresh-main inspection, SHA recording and test execution could not be performed. AgentRuntime, action decoder, ContextManager, task queue, shared admission, evidence resolution, workspace generation and typed-origin IFC signatures remain unverified. No integration or passing CI claim is made.

The config currently covers only structural limits, not the full runtime planner configuration. Runtime mounting still requires bounded shared inference admission, initial planning and fallback, recovery-neutral authorized reporting, authoritative evidence eligibility and reuse records, contradiction coalescing, measured projections, startup co-mount checks, workspace generation handling, legacy-plan suppression and terminal-envelope integration. A recovery hold supplied by the host must include an open zero-allowance slot; these helpers neither inspect nor modify a ledger. Objectives are not taint-indexed. No workspace clock or evidence resolver is fabricated. The supplied tests exercise pure graph behavior only, not real AgentRuntime acceptance traces. Do not advertise the capability as delivered until those integration seams and tests are implemented.
