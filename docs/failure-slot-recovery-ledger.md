# Failure-slot recovery ledger: adversarial model check and amendment

## What this is

The single failure-slot recovery rules were previously prose only. `src/runtime/failure_slot_ledger.ts` encodes them as an explicit state machine, and `src/runtime/__tests__/failure_slot_ledger.fuzz.test.ts` subjects it to seeded model-based fuzzing plus exhaustive small-state enumeration.

## The contradiction the fuzzing targets

Read naively ("every dispatch consumes allowance; finalize needs either success evidence or retry budget"), the prose rules reach a stuck state: allowance_remaining = 0, a non-idempotent call with an unknown outcome, no success evidence. In that state the evidence check is refused (no allowance), the true-success close is refused (no evidence), and the non-success finalize is refused (no retry budget). The slot can neither close nor finalize honestly — and reconciliation is simultaneously needed and refused. The fuzz test `demonstrates the pre-amendment contradiction` pins this reachable state under the naive reading.

## The amendment (as implemented)

1. **Reconciliation-exempt allowance.** Exactly one idempotent, read-only reconciliation call per unknown-outcome event, using a *different* tool from the one that timed out. It is not a recovery dispatch: it consumes no allowance, does not close the slot, and is permitted even when allowance_remaining is 0. It only produces evidence. Event identity is the recorded event id; re-declaring an id is a no-op, so a re-declared event cannot mint a second exemption.
2. **Honest-failure exit.** A non-success finalize is always legal while the slot is open and always closes it — including at allowance 0 with inconclusive evidence. This makes a stuck slot unreachable (invariant I1 in the fuzz harness).
3. **Child results are evidence only.** A delegate_task child's `claimed-complete` is not host-verified: it never closes or bypasses the parent slot and never creates success evidence. A failing child opens no new slot while the parent's is open; child failures are charged to the parent's allowance (floored at 0).
4. **Output-layer failure classification.** outer status=ok with output.ok=false is a failure, classified before any success is claimed.
5. **Recall polls** are capped at 2 while an unknown outcome is pending, never consume allowance, and never change the slot.

## Invariants the fuzzer checks

- I1: while the slot is open, honest non-success finalize is always permitted (no stuck slot).
- I2: reconciliation for an unreconciled event with a different read-only tool is permitted regardless of allowance, and is never both permitted and refused for the same (event, tool).
- I3/I4: reconciliation and recall polls never change allowance or slot state.
- I5: child results never close the slot or create success evidence.
- I6: allowance never goes negative; recall polls never exceed 2.

500 seeded random op sequences (60 ops each) plus an exhaustive enumeration of slot x allowance x event-state all hold. This matches the external evidence base: transport acks are not completion evidence, `uncertain` is a terminal honest state, and a read-only target-side evidence check is the only mechanism that distinguishes observed effect, observed non-effect, and unknown.
