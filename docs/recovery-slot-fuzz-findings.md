# Recovery slot: fuzz campaign findings and spec clarifications

This documents the reference implementation of the recovery-slot state machine
(`src/runtime/recovery_slot.ts`) and the seeded property-based fuzzer that drives
it (`src/runtime/__tests__/recovery_slot.fuzz.test.ts`). The fuzzer uses a
hand-rolled seeded PRNG (`mulberry32`) — no new dependency — generates random
event sequences (success, `invalid_args`, `tool_error`, timeout on
idempotent/non-idempotent tools, `run_code` outer-ok-but-exit-code!=0, recall
calls, replans, alternative tools, reconciliation, finalize), and checks ten
invariants after every event. Schedules are deterministic per seed, so any
failing schedule is replayable by re-running with the same seed.

## Invariants checked

- **I1/I2** — allowance never negative; total charge per slot never exceeds 3;
  while a slot is open, `allowance + chargedTotal === 3`.
- **I3** — at most one open slot; the intent id is stable while the slot is open
  (no identity replacement during recovery).
- **I4** — recall is free and never mutates slot state, including at allowance 0
  with `unknown_outcome` set.
- **I5** — replan never resets the slot, allowance, or unknown outcome.
- **I6** — unrelated/undeclared dispatches are never charged, and their failures
  are logged as `AMBIGUOUS_INTENT_MERGE`.
- **I7** — the slot closes only on true success (successful repair dispatch or
  reconciliation classified `confirmed_applied`) or on finalize.
- **I8** — once allowance hits 0 with unknown outcome, every non-recall dispatch
  is refused; the only legal move is finalize reporting an unknown outcome.
- **I9** — after an unknown-outcome finalize the machine is terminal: no new
  slot may be minted, and the claim is neither success nor failure.
- **I10** — every applied event is logged exactly once with an index
  (event-numbered injection schedule).

## Candidate holes and how they resolved

**(a) Non-idempotent timeout + idempotent reconciliation success leaves the slot
open with no close path (STUCK_SLOT_NO_CLOSE_PATH).** Confirmed as a real spec
gap in the original rules. Resolution now encoded: a reconciliation classified
`confirmed_applied` counts as true success of the intent and closes the slot;
`confirmed_not_applied` clears `unknown_outcome`, unblocks the timed-out tool,
and keeps the slot open with retry budget (the reconciliation itself costs one
allowance unit); `inconclusive` retains `unknown_outcome`, and once allowance is
exhausted the machine refuses further reconciliation calls — the agent must
finalize reporting an unknown outcome rather than keep draining allowance. A
reconciliation that itself times out is classified inconclusive (reconciliation
of the reconciliation).

**(b) New unrelated failure arriving while a slot is open.** Previously ambiguous
— it silently inherited the intent and drained allowance. Now every non-recall
dispatch while a slot is open must declare `repair_of=<intent_id>` or
`unrelated`. Unrelated dispatches never mint a slot and never consume the open
slot's allowance; their failures are logged `AMBIGUOUS_INTENT_MERGE` and never
charged. The machine also supports a stricter `unrelatedPolicy: 'block'` that
refuses unrelated work as `BLOCKED_BY_OPEN_RECOVERY` until the slot is finalized.

**(c) delegate_task child failures vs the parent slot.** The spec must require
child failures to declare intent like any other dispatch. A child failure
declared `unrelated` is uncharged (logged `AMBIGUOUS_INTENT_MERGE`); declared
`repair_of` it is charged against the parent slot's allowance. Both behaviors
are pinned by tests.

**(d) Allowance exhaustion with pending unknown outcome.** The machine enters
`mustFinalizeUnknown`: all non-recall dispatches are refused, recall remains
free, and finalize must claim `unknown` — neither success nor failure. After
that finalize the machine is terminal: no new slot may be minted (a fresh
identity cannot be used to recover an unknown outcome). A finalize with a known
outcome (`failure`) does permit a later slot to be minted.

## Campaign results

400 seeds × 60 events under the execute-unrelated policy, plus 100 seeds under
the block-unrelated policy, all pass with zero invariant violations, and the
machine is byte-for-byte deterministic under replay. The meta-check confirms the
generator actually exercises reconciliation events and unknown-outcome
exhaustion, so the pass is not vacuous.
