# Recovery-slot budget: deterministic fuzzing findings

## What was built

`src/runtime/recovery_slot_fuzzer.ts` implements a deterministic, seeded
simulator of the recovery-slot budget model and a property-test fuzzer
(`src/runtime/__tests__/recovery_slot_fuzzer.test.ts`) that enumerates
adversarial interleavings of:

- tool outcomes: `success`, `invalid_args`, `rejected`, `timeout` on both
  idempotent and non-idempotent tools,
- `run_code` with outer ok / `exit_code != 0` (and outer-failure forms),
- `recall` calls,
- `replan` calls,
- `delegate_task` child runs, nested up to grandchild depth.

Parent and all children drive one shared ledger, so a child structurally
cannot mint its own slot or allowance.

## Invariants asserted after every event

1. Allowance never negative and never increases (no reset, no minting — by
   parent, child, or grandchild).
2. `recall` and `replan` leave the ledger byte-for-byte unchanged.
3. The slot closes only on a true-success repair of the tool that opened it
   (a different idempotent tool's success never closes it).
4. Total charged units never exceed the issued budget of 3 (issued-budget
   bound preserved across crash/retry/duplicate/partition schedules).

600 seeds x 40 steps found **no violations** — the shared-ledger design
satisfies all four invariants on every generated interleaving.

## Ambiguities the simulator had to resolve (spec counterexample candidates)

These are the points where the written spec was underspecified; the simulator
encodes one resolution each and the tests pin it:

1. **Child first failure, parent slot closed, parent allowance > 0.**
   The spec says the child "borrows the parent's single open slot, or the
   parent's exhausted state" but does not say what happens when the parent has
   *no* open slot and *positive* allowance. Resolution: the child's failure
   opens the *shared* slot and charges the parent's allowance — the child
   never gets a private slot. (The alternative — child failures are free
   while the parent has budget — would let a child burn unlimited failures
   through the parent's open budget, violating the issued-budget bound.)

2. **Who may close the slot.** A non-idempotent tool's timeout slot is not
   closable by a *different* idempotent tool's success; only a success of the
   same tool that opened the slot closes it, and closing never refunds the
   allowance.

3. **Charging on the opening failure.** The first failure both opens the slot
   and charges one unit (escrow charged at issue). When the allowance is
   already 0, the first failure is a terminal failure with no dispatch and no
   slot — this is exactly the child-after-parent-exhaustion trigger.

4. **run_code outer ok / exit_code != 0** is classified as a non-success
   (failure) outcome, and `run_code` is treated as non-idempotent.
