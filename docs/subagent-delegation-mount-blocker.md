# cap_subagent_delegation_mount_34 -- delivery status: BLOCKED (contract layer only)

## Status

**The `delegate_task` mount on `AgentRuntime` is not delivered.** Nothing in this
change registers a tool, runs a child loop, or alters any existing runtime file.
Delegation is not available to the agent after this merge.

## Why it is blocked

The spec's implementation preflight requires recording the main SHA, running the
full baseline, and publishing verbatim the signatures and bodies of `HostConfig`,
`AgentRuntime.run`, the loop entry, `ToolRegistry` registration,
`OutcomeClassifier`, `RecoveryLedger.admit`, `EvidenceValidator` and step/inference
admission, then landing a golden-trace test on unmodified main before extracting
the loop.

The authoring session had only the repository file listing. No file contents, no
SHA and no ability to run the baseline were available. Therefore:

- no symbol in `src/runtime/*` could be verified, so none is imported;
- a golden-trace test could not be written without guessing the scripted-adapter
  and trace APIs, and a guessed test would either fail CI or assert nothing;
- extracting the loop body of `agent_runtime.ts` unseen would risk breaking the
  existing suite, and wrapping `cap_subagent_orchestration_5.ts` would create the
  forked loop the spec forbids.

Per the spec ("Do not land a forked loop or import imagined symbols") the mount
is reported as blocked instead.

## What this change does contain

`src/runtime/delegation_contract.ts` -- real, pure, dependency-free
implementations of the semantics the spec pins before tests. It is not wired to
anything yet.

| Symbol | Pinned semantic | Test block (`src/runtime/__tests__/delegation_contract.test.ts`) |
| --- | --- | --- |
| `validateDelegationOption` | host option; ineligible/unmounted allowlist is a config error; malformed rejected whole | `validateDelegationOption` |
| `validateDelegateArgs` | strict args; `invalid_args` / `tool_not_allowed`, `started=false` | `validateDelegateArgs` |
| `admitDelegation` | `parent_slot_open`, `parent_unresolved`, `delegation_cap`, `insufficient_steps`, deadline; delegate_task-slot repair exception | `admitDelegation` |
| `childStepCap`, `BorrowedBudget`, `CancellationToken` | borrowed budget, parent keeps one step, counters frozen after cancellation | `borrowed budget` |
| `createChildCallIdMinter`, `buildChildInstructions` | disjoint child ids; untrusted task payload; 16-citation statement | `child call ids and instructions` |
| `checkChildFinalAnswerCitations` | 17 citations rejected, 16 accepted | `child final answer citation gate` |
| `buildDelegationReport`, `isDelegationReport` | report shape, summary truncation, termination/cleanup confirmation | `buildDelegationReport` |
| `classifyDelegateTask` | success / unknown / known_failure | `classifyDelegateTask` |
| `validateShape3Citation` | shape-3 provenance predicate, `shape_unavailable` for nested passage_id | `validateShape3Citation` |

These tests are unit evidence for the decision functions only. They are not
orchestration evidence and say nothing about whether delegation improves the agent.

## Decisions made here that the spec left open (review these)

- An enabled option with an empty `allowedTools` is a configuration error.
- A delegate_task-opened slot with no recovery allowance left refuses with
  `parent_slot_open` (no new code was invented).
- A repair delegation still counts against `maxDelegations`.
- The deadline refusal code is `deadline_passed`.
- `classifyDelegateTask` returns `unknown` for an output that is not a
  well-formed report. Pre-execution refusals (`started=false`) are expected to
  stay on the runtime's existing refusal path and not reach it.
- Admission order: deadline, unresolved/quarantine, slot, cap, steps.

## Acceptance tests NOT covered (all need the real runtime)

Disabled-path schema absence on the real registry; the scripted AgentRuntime +
DockerCli end-to-end run with exact shared counter assertions; recursion via the
child registry; lock-free-between-turns; parent ledger slot open/repair/close;
fake-timer deadline with a never-resolving child call through the real loop;
selfReview interaction; parent `recall` of report vs child ids; workspace volume
count and single cleanup; whether recovery slots record their originating tool.

## Next step to unblock

In a session with file contents: publish the preflight signatures, add the
golden-trace test on unmodified main, extract the loop behind it, then wire the
functions in `delegation_contract.ts` into the registry, classifier, ledger
admission and evidence validator.
