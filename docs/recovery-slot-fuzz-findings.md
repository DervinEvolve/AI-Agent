# Recovery slot: property-based fuzz findings

This note records the reference state machine and the seeded property-based
fuzzer for the single-recovery-slot specification (one open failure slot,
allowance 3, inherited `intent_id`), plus the spec gaps the fuzzer surfaced.

## Implementation

- `src/runtime/recovery_slot_spec.ts` — the reference state machine as a pure
  function over `(state, event)`. Events: dispatch (repair / retry /
  alternative / reconciliation / independent), outcome (success, failure codes,
  `truncated_success`, structured `run_code` results), external failure,
  termination report, recall, replan, delegate request, finalize.
- `src/runtime/recovery_slot_fuzzer.ts` — deterministic seeded generator
  (`mulberry32`, the `random.Random(seed)` equivalent), the six invariant
  checks, a Zeller-style delta-debugging shrinker, and the `fuzz()` driver
  (5000 traces across 5 seeds in the contribution run).
- Tests: `src/runtime/__tests__/recovery_slot_spec.test.ts` (rule-level unit
  tests) and `src/runtime/__tests__/recovery_slot_fuzzer.test.ts` (fuzz run,
  determinism, shrinker behavior against a deliberately broken machine).

## Invariants checked after every step

1. recall never changes allowance;
2. the slot never resets on replan;
3. after an exhausted allowance no recovery dispatch is admitted;
4. a non-idempotent timeout refuses same-tool redispatch;
5. run_code success requires completed, exit_code 0 and termination_confirmed;
6. delegate_task is refused while a slot is open or an outcome is unknown.

Across 5000 seeded traces the reference machine violates none of them; every
ambiguity the fuzzer hit is recorded below as a gap instead.

## Spec gaps surfaced (each needs an explicit rule)

### 1. `truncated_reconciliation_undecidable`

A `truncated_success` on a **reconciliation** call is neither a clean failure
nor a success: rule (4) says truncation is not true success and does not close
the slot, while rule (2) says a failed reconciliation is absorbed with no
extra allowance. Machine resolution (chosen conservatively): treat it as
absorbed into the same slot as an unsettled sub-failure — no extra allowance,
no nested slot, slot stays open — and flag the case. Suggested clarification:
"a truncated reconciliation output counts as a failed reconciliation for
absorption purposes, but its outcome remains unknown until a clean
reconciliation succeeds."

### 2. `subfailure_unknown_at_close`

When a repair succeeds and closes the slot while a sub-failure (second
independent failure, or an absorbed reconciliation failure) is still
**unknown**, rule (2) — slot closes on repair success — collides with the
liability rule that unknown outcomes block forward action. Machine resolution:
the slot closes, but the unknown-outcome flag for non-idempotent effects
survives (delegate_task stays refused until settlement or finalize), and the
case is flagged. Suggested clarification: "sub-failure status does not survive
slot closure, but any unknown *effect* (non-idempotent timeout) keeps its
liability reservation independently of the slot."

### 3. `success_claim_without_true_success`

A finalize carrying a success claim when no true success was ever recorded is
accepted by the machine but flagged; the spec should state that such a claim
must be rewritten as an explicit failure report.

## Notes on alignment with prior modules

The machine deliberately does not re-implement `recovery_ledger.ts` or
`outcome_classifier.ts`; it is a standalone pure model so the fuzzer can be
cross-checked against those modules in a follow-up without circularity. The
settlement semantics (unknown outcomes keep a liability reservation, blocking
delegation until a reconciliation succeeds or the episode finalizes) follow
the established-absent / unknown evidence-state discipline.
