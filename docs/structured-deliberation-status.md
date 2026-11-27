# cap_structured_deliberation_76 - status: core landed, runtime mount BLOCKED

## What this PR contains

`src/runtime/deliberation/`:

- `types.ts` - `DeliberationConfig`, `DeliberationRecord`, `CritiqueVerdict`, reason codes
  (`DeliberationOutcome`, `CritiqueRejectReason`, config error codes), `DELIBERATION_CAPS`, and the
  structural ports the core needs from the runtime.
- `config.ts` - startup validation and freezing, hard caps, host tool allowlist checked against
  registered names, the finite attempt-limit requirement, co-mount rejection, the self-review
  conflict, and no deliberation for children.
- `critique.ts` - strict critique parser (no repair, no coercion).
- `admission.ts` - `InferenceAdmission`: all-or-nothing reservation of attempts, tokens and cost;
  release exactly once; unknown usage charged at the allowance and stops admission.
- `controller.ts` - the one-round state machine over a held, uncommitted candidate: trigger,
  abort/deadline rechecks, measurement of both requests before the critic, share cap
  `floor(B*share)`, whole-reservation refusal, critic, optional revision, records.

Tests use scripted adapters only (no network, no timers).

## What is NOT done (do not read this capability as active)

The authoring step for this PR could see only the repository file listing, not file contents. The
signatures of `AgentRuntime`, `ActionDecoder`, `ModelAdapter`, `ContextManager`, `Finalizer`, the
TaintIndex and any existing shared admission were therefore unverified, and no main SHA or baseline
test run was recorded. Rather than edit unseen files or guess their APIs, this PR does **not**:

- wire `DeliberationController` into `AgentRuntime` (no decode/commit split was added there);
- reuse or replace an existing run-wide ledger. `InferenceAdmission` implements the
  `SharedInferenceAdmission` port; if main already has shared admission, the mount must adapt that
  one instead so there is a single account;
- exercise the acceptance tests that need the real runtime: exact adapter-call counts on
  `AgentRuntime`, approval/hooks/ledger/finalization gates on the committed action, IFC
  `taint_denied` for a critique-invented URL (here only the ingest-on-reconsider-only seam is
  tested), and disabled-mode trace equality against baseline.

## Decisions beyond the spec text

- Startup rejects a configuration where `floor(B*share) < 2`, since no round could ever start.
- The critic response allowance is `ceil(maxCritiqueBytes / 2)` tokens, capped by the adapter limit.
- A thrown transport error is treated as unknown usage (stop inference, commit nothing).
- The revision request shows the canonical re-serialized critique, never the raw critic text.
- `resetDecoderRejects` is true for any deliberated turn that commits an action.

## Mount checklist for the follow-up

1. In the existing turn function, decode the primary response without committing it, then call
   `controller.deliberate(...)` with the frozen rendering and the held candidate.
2. `commit: 'original' | 'revision'`: commit `result.message` through the ordinary path (all gates
   apply at its actual start). `commit: 'none'`: follow the existing terminal path.
3. Map `DeliberationRequest` to the adapter: critic = `instruction` + `rendering` +
   `untrustedSection`, no tools, no provider continuation; revision = `rendering` with
   `untrustedSection` appended after the transcript.
4. Keep records out of ObservationStore, evidence, pins and board refs.

No improvement claim is made. Scripted tests establish orchestration only.
