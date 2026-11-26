# Recovery-slot fuzz findings and spec amendment

A deterministic, seeded fuzzer (`src/runtime/recovery_slot/fuzz.ts`) drives a
small executable model of the recovery-slot rules
(`src/runtime/recovery_slot/slot_model.ts`) with random event sequences and
replays each sequence under the strict reading of the spec plus two
alternative readings drawn from the mlsysbook vol3 ch.12 failure-recovery
chapter (Table 2: retry / new proposal / repair / compensation / escalate) and
the arXiv 2611.23353 fault-injection study ("Idempotency Is Not Recovery").

## Results

Under the strict oracle, no invariant violations were found across all seeded
runs: reconciliation never closes, resets, or re-mints the slot and never
consumes allowance; recall is a no-op on slot state; refused dispatches consume
no allowance; a dispatch of the marked tool `T` is always refused with
`outcome=blocked`; the mark clears only on recorded evidence; `run_code` real
success requires all four flags; allowance never goes negative.

Two genuine spec disagreements were surfaced, each with a minimal
reproducing event sequence:

### Ambiguity 1 — does reconciliation consume allowance?

- Sequence: `timeout(T)` → `reconcile(R, evidence)`.
- Strict reading: reconciliation costs a step and consumes **no** allowance.
- Table 2 reading: a reconciliation probe that returns evidence is a *retry of
  the same operation* and therefore spends allowance like any recovery
  dispatch.

**Amendment:** state explicitly that reconciliation is a *non-allowance*
classification step (observed-effect / observed-non-effect / unknown), not a
retry, and that only re-dispatch of the marked tool `T` after the mark clears
counts against the allowance. Without this, an implementer following the
Table 2 taxonomy will exhaust the allowance with probes and finalize honestly
before ever re-attempting the operation.

### Contradiction 2 — a child's final failure while the parent slot is marked

- Sequence: `timeout(T)` → `delegate(childFinalFailure=true)`.
- Strict reading: `delegate_task` is refused under the `unknown_outcome` mark,
 consuming nothing.
- Alternative reading: the "child's final failure result, returned to the
  parent, counts as one parent recovery dispatch" rule fires anyway, so the
  refused delegation still decrements the parent's allowance.

**Amendment:** the child-failure-counts rule applies only to delegations that
were *admitted* (i.e., no mark set and allowance remaining). A refused
`delegate_task` consumes no allowance and cannot be retroactively counted;
otherwise a refused operation has an effect, which violates the refusal
contract. Note this also interacts with allowance exhaustion: if the allowance
hits zero exactly when a child's final failure returns, the strict reading
refuses all further recovery dispatches and only honest-failure finalization
remains — the child's already-spent work is never retroactively uncounted.

### Noted but not divergent

`run_code` with `termination_confirmed=false` but `exit_code=0` is uniformly
classified as a failure (slot stays open, allowance consumed) under both
readings, including for read-only code runs — the spec's four-flag rule is
unambiguous here, though it means a read-only run with a flaky termination
signal burns allowance. If that is unintended, amend the rule to exempt
read-only runs from the termination/cleanup flags.
