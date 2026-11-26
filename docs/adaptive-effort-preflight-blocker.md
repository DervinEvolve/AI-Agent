# Adaptive effort (cap_adaptive_effort_72): preflight blocker

The spec requires a finite host-frozen run-wide inference-attempt limit enforced by shared atomic admission, with whole-draw reservation (k attempts plus token/cost allowances plus one elevated-turn slot) and exactly-once release of unused reservations.

This PR did not inspect the runtime's admission, ContextManager, ActionDecoder or Finalizer signatures in enough depth to confirm that shared atomic attempt reservation exists. The spec says to report blocked rather than introduce a second ledger, so no runtime code is added here.

## Required before implementation

1. Record main SHA, package.json test script, and the actual ContextManager, ActionDecoder, ModelAdapter, admission and Finalizer signatures.
2. Confirm shared admission supports reserving k attempts atomically, committing on first start, and releasing unused reservations exactly once.
3. Confirm ActionDecoder can decode a candidate without committing state (decoder counters and transcript); if not, add that separation first.

## Design constraints preserved for the follow-up

- Votes are RFC 8785 JCS of tool_name plus arguments only.
- A win needs more than configured k/2 votes, and only for registered idempotent tools in the host-frozen consensusReadTools allowlist.
- The earliest matching sample is the representative.
- A sample-1 write is base_fallback, never agreement.
- Decoder counters move once per draw.
- Unknown usage, abort or deadline select nothing and retain started admissions.
- Startup rejects durable, interactive, composition, claim and model-router mounts.
- Scripted tests establish orchestration only. They are not evidence of improved performance.
