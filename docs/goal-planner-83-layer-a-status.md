# cap_goal_planner_83 - Layer A status (capability NOT delivered)

**Status: `cap_goal_planner_83` stays `specified`. This PR does not deliver the capability.**

The redelivery contract requires two layers in one PR and says Layer A alone
must not merge *as the capability*. This change contains Layer A only. It is
offered as an additive, unmounted library so that Layer B can be written
against published signatures. A reviewer who reads the contract strictly
should close it rather than count it as the e84 redelivery.

## What is here

`src/runtime/planning/` (pure, no runtime imports):

| Export | Signature | Returns |
| --- | --- | --- |
| `resolveGoalPlannerConfig` | `(input?: Partial<GoalPlannerConfig>)` | frozen `GoalPlannerConfig`; throws `RangeError`/`TypeError` |
| `validateProposal` | `(raw: unknown, limits: GraphLimits)` | `{ok:true, nodes}` or `{ok:false, code, detail}` |
| `createGraph` | `(nodes, rootTaskDigest: string)` | `GoalGraph` at revision 1 |
| `selectReady` | `(graph)` | `{graph, active_goal}` |
| `applyReport` | `(graph, report: unknown, ctx: ReportContext)` | `{ok:true, started:true, graph, record}` or `{ok:false, started:false, reason, graph}` |
| `applyReplan` | `(graph, raw: unknown, limits)` | `{ok:true, graph, abandoned, reopened}` or `{ok:false, code, detail, graph}` |
| `markPossiblyStale` | `(graph, currentGeneration: number)` | `GoalGraph` |
| `suspendScheduling` | `(graph, reason)` | `GoalGraph` |
| `buildPlanningStatus` | `(graph)` | `PlanningStatus` |

Rejections return the same graph reference; successes return a new frozen graph.

## What is NOT here (Layer B)

None of the following exists yet:

- no `AgentRuntime` wiring: no initial planner call, no `report_goal` tool
  registration, no active-goal binding in call metadata, no replan trigger,
  no `planning_status` in the terminal envelope
- no co-mount startup rejects, no `planning_skipped` / `planning_unavailable`
  records, no budget reservation for planner calls
- no recovery-slot interaction, no legacy `plan_revision` handling
- no IFC ingestion of planner text (objectives are **not** taint-indexed)
- no test imports `AgentRuntime`, so the collection-proof requirement is unmet
- the optional paired orchestration eval is not included

The must-pass traces are exercised only at the pure-graph level. The recovery
trace, the Finalizer / EvidenceValidator trace, the disabled-mode baseline
trace and the stray-`plan_revision` trace are **not covered at all**, because
they are properties of the runtime.

## Why Layer B was not written

The author of this change had only the repository file listing, not the
contents of `src/runtime/agent_runtime.ts` or its test harness. Wiring against
unseen signatures is exactly how the e83 PR failed. For the same reason:

- main's SHA was not recorded and branch `epoch-83-capabilities-0` was not
  inspected, so its transform error is not named here
- `tsc --noEmit` and the vitest suite were not run by the author before push;
  the CI and sandbox output for this commit are the only evidence
- whether the workspace-generation, recovery-slot and typed-origin IFC seams
  exist on main is unknown

## Notes for whoever writes Layer B

- `ObservationFacts` must be filled in by the runtime from its own records,
  never from model-supplied arguments.
- `applyReport` reports `replan_trigger`; coalescing by call_id, waiting for
  the recovery slot to close and spending a planner call are the runtime's job.
- A contradicted goal is stored as `blocked` (the disposition set has no
  `contradicted`); the contradiction lives in the report record.
- `buildPlanningStatus` output is envelope metadata, not evidence and not a
  completion predicate.
