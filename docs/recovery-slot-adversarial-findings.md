# Recovery-slot adversarial stress test: findings and spec amendment

We built a deterministic, seeded simulator of the runtime-owned recovery slot ledger
(`src/runtime/recovery_slot_simulator.ts`) and fuzzed it with randomized sequences of
tool results (success, `invalid_args`, timeout on idempotent/non-idempotent tools,
`run_code` outer-ok/nonzero-exit), recall calls, `delegate_task` child failures, plan
revisions, and supervisor reconciliations
(`src/runtime/__tests__/recovery_slot_simulator.adversarial.test.ts`, 400 seeds × 120
events, plus targeted edge tests).

## Invariants that held under fuzz

- At most one active slot; at most 2 open (suspended-or-active/exhausted) slots per turn.
- Allowance accounting is exact: `debits + remaining === 3`, debited only by dispatches
  declared repairs of that intent (or child failures mapped to it).
- A `new_intent` dispatch never consumes a suspended slot's allowance; the suspended
  slot's debits, remaining count, and `unknown_outcome` flag are preserved.
- Blocked tools are blocked for every intent until a supervisor reconciles them.
- Plan revisions and recall calls never mutate the ledger, never create a `new_intent`
  tag, and never reset or close a slot (a relabel attempt carried on a plan revision is
  ignored — there is no runtime path to relabel).
- A slot closes only on true success (a `run_code` outer-ok with nonzero exit does not
  close it) or on reconciliation with authoritative target-side evidence of success.

## Underspecified edges the fuzz surfaced (and the rules adopted)

1. **Unknown-outcome slots can never close by retry or recall (edges b/d).** A timeout
   on a non-idempotent tool leaves the outcome UNKNOWN; recall-based reconciliation is
   capped at 2 polls, after which recall is refused and the slot stays open. Amendment:
   an `unknown_outcome` slot is closed **only** by supervisor reconciliation with
   target-side evidence (success closes the slot; failure resolves UNKNOWN to a known
   failure and keeps the slot open with its remaining allowance). Retrying is never a
   resolution for an unknown outcome.
2. **Child bypass (edge c).** Without an explicit rule, a `delegate_task` child's
   separate recovery ledger could bypass an exhausted parent allowance. Amendment: a
   child's recovery failures debit the parent's slot for the delegated intent — even
   while that slot is suspended — and when the parent slot is exhausted the child's
   failure is refused with an honest-failure requirement. A child failure never creates
   a `new_intent` tag; if no parent slot exists, the runtime opens the parent's slot
   (subject to the 2-slot cap).
3. **Repairs of suspended slots.** A completed/suspended intent cannot start a fresh
   physical retry: `repair_of` a suspended slot is refused (fail-closed). Progress on
   that work requires either supervisor reconciliation or a `new_intent` dispatch that
   gets its own slot.
4. **Unrelated-intent failures while a slot is open (edge a).** Confirmed safe under the
   intent-tag rule: the unrelated failure gets its own slot and the old slot is merely
   suspended, so a legitimate new task is never starved by the old intent's allowance.
5. **Cap refusal.** When the 2-slot cap is hit, further `new_intent` work is refused and
   the final answer must be an honest partial-failure report listing every suspended or
   exhausted slot with its unknown-outcome tool.
