# Recovery slot: allowance exhaustion and unknown-outcome semantics

This document specifies the recovery slot runtime (capability 31,
`src/capabilities/cap_recovery_slot_31.ts`) and records the spec
clarifications surfaced by fuzzing the prose spec with random event
sequences.

## State machine

States: `open` (with remaining allowance and an optional pending-unknown
flag) and `exhausted` (terminal). Transitions:

- **dispatch** (repair / retry / alternative): admitted only while the
  slot is `open`, allowance > 0, and no pending-unknown outcome. Admission
  consumes one allowance and increments the attempt counter *on
  admission, not on success*. When allowance reaches 0 while the slot is
  open, the slot enters `exhausted` immediately.
- **refusal**: when allowance is 0 or an unknown outcome is pending, the
  dispatch is refused with a structured refusal
  (`reason=allowance_exhausted | unknown_outcome_pending`, `intent_id`,
  `original_call_id`). A refusal never consumes allowance, never mints a
  new slot, and is idempotent — only the first refusal per
  (reason, intent) is journaled so repeated refusals cannot be mistaken
  for attempts.
- **reconcile** (read-only) and **recall**: always allowed, even under
  exhaustion or a pending unknown. Recall costs a step but no allowance.
  Neither can close or reset the slot — a recall or reconcile result can
  never be used to launder closure.
- **policy reset**: only an authorized policy modification opens a new
  episode; the new episode inherits all telemetry (journal, cumulative
  attempt counter) and, unless explicitly settled, the pending-unknown
  flag.

## Unknown outcomes

A non-idempotent timeout leaves the outcome **unknown** and blocks all
dispatch on the slot (settlement before retry). An idempotent tool may
still run as reconciliation. Exhaustion does **not** downgrade an unknown
outcome to "failed": the final report says "outcome unknown", never "did
not happen". Only a reconcile that establishes evidence
(`established` / `established-absent`) may settle the report — and even
then the slot is not closed or reset.

## Child ledgers

A child sub-agent has its own recovery ledger, but it inherits the
parent's remaining allowance and the parent's pending-unknown flag for the
same `intent_id`. A child can pass limits down but cannot widen them, so
delegation cannot launder allowance: a child spawned under an exhausted
or unknown-outcome parent slot is refused on its first dispatch.

## Clarifications found by fuzzing

1. **Substitute-tool success does not close the slot.** A repair that
   returns `success=true` via a *different* tool than the failed intent
   consumes allowance and records a `workaround`, but the slot stays
   open. Only success via the original tool (or authorized policy)
   resolves the slot; otherwise a substitute success could launder
   closure of an unresolved failure.
2. **Recall can run under exhaustion but cannot close the slot.** Confirmed
   by invariant check: recall and reconcile change no allowance and never
   set `resolved`.
3. **Exhaustion + pending unknown coexist.** The slot may be terminal
   `exhausted` while still holding an unknown outcome; the report says
   "outcome unknown" and only a policy-authorized episode (with explicit
   settlement) can reopen work.
