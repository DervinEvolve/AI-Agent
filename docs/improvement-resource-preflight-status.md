# Improvement cycle resource preflight — partial delivery

This contribution implements only pure request, spending, and wall-clock envelope validation. It does not land cap_improvement_cycle_51, a task suite, a live CLI, or a second inference loop. No provider connection is possible through this helper. A bounded result is not a cycle admission, reservation, score, or evaluation result.

The request formula is `2 * taskCount * perTrialModelCallCap + 1`. Four tasks at two calls require 17 requests; sixteen tasks at one call require 33 and therefore cannot fit a remaining allowance of 20. The helper also requires host-supplied pricing, rendered input bounds, completion bounds, capacity, and timing bounds. Integer arithmetic rounds per-request spending upward. Available daily spending, when supplied, tightens the cap. These numbers do not define suite membership or claim that any task is runnable.

## Verification and integration blockers

Only the supplied repository path listing was available in this contribution environment; no repository inspection or command execution facility was available. Main SHA, package root, baseline, npm ci, local tests, CI, and merge are unverified. No live requests were made. The new Vitest tests have been written but not executed.

The only implementation imports in this contribution are the test's Vitest import and the new helper. No existing runtime export or type signature was modified or assumed. Before further integration, inspect AgentRuntime, consolidated finalization, shared admission, the existing harness, and any recoverable e51 patch. Actual RecoveryLedger, ObservationStore, ToolRegistry, overlay rendering, holdout authorization, usage accounting, and localhost protocol tests remain necessary. The helper must be wired to shared admission and frozen manifests before it can protect a live cycle.

Before implementation continues, record the main SHA and package root, run npm ci without fallback, and capture baseline test logs and distinct exit statuses with pipefail. Repeat the full suite on the exact contribution commit. There is intentionally no purported live command: a safe runnable host entrypoint has not been inspected or implemented. Publish its actual command only after integration, default-off behavior, network isolation, and CI are verified.
