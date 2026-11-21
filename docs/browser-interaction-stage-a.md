# cap_browser_interaction_13 - Stage A status

**Orchestration substrate, no real browsing.** No production `PageBackend` is exported. The
capability is not delivered until a Chromium backend passes fixture integration (Stage B).

## What this PR contains

`src/runtime/browser_page_session.ts` (imports only `node:crypto`):

- Published types: `PageBackend`, `BackendReport`, `PageState`, `BrowserAuthorizer`, `ActionArtifact`.
- `validateBrowserConfig` / `createBrowserSession`: absent or `enabled !== true` gives no session;
  unknown keys and out-of-range `maxActions` / `maxNodes` / `timeoutMs` are rejected.
- `BrowserSession.call(tool, args, { remainingMs, signal })` for `browser_open`, `browser_snapshot`,
  `browser_click`, `browser_type`: strict argument validation, https-only canonical URLs,
  fail-closed authorizers with a per-run SHA-256 denied set, `page_state_id` / ref binding,
  re-check after async approval, backend report validation (`malformed_state`), `maxActions`,
  a bound of min(timeoutMs, remaining deadline), late reports discarded, quarantine after an
  unknown action outcome.
- `classifyBrowserOutcome`: success / known_failure / unknown table from the spec.
- `renderBrowserView`: 24 KiB transcript view; `recall(call_id)` returns the full stored output.
- `validateCitation`: shape 8 `{ call_id, page_state_id, ref }` against current-run successful results.
- `close()`: `backend.close()` exactly once, bounded, returning `cleanup_confirmed`.
- `assertNoBrowserToolsDelegated`: helper for the delegation allowlist check.

Tests use an in-memory fixture defined in the test file only.

## What is NOT done (honest gaps)

This PR was written with only the repository file listing visible, not file contents. To avoid
importing imagined symbols, the module is standalone and **not wired** into:

- `HostConfig.browser` on `AgentRuntime.run` and `ToolRegistry.call` registration,
- the shared `OutcomeClassifier` and `EvidenceValidator` (shape 8) registries,
- `ObservationStore` (results are kept in the session's own map),
- runtime terminal-path cleanup hooks and the `cleanup_confirmed` completion gate,
- delegation allowlist validation / the `delegate_many` deny-list.

Consequently these acceptance tests are not covered yet: the end-to-end run on the real
`AgentRuntime` with Finalizer, unchanged adapter-call counts when disabled (trivially true, since
nothing is registered), and close-on-every-runtime-terminal-path. The `beh_export_preflight_26`
preflight (main SHA, baseline run, published host signatures) and the review of the stored e13
text were not performed. `cap_browser_automation_8.ts` and its tests are untouched.

Other notes:

- A backend throw or timeout during open/click/type is treated as `dispatched=true` (unknown),
  because the effect cannot be ruled out. Only an explicit `dispatched=false` report is a known failure.
- `expect` is `{ docGeneration, origin }` as specified. A same-document (SPA) mutation during
  authorization that changes a handle's role or name is not detected by the runtime; this risk,
  raised in exploration, remains open.
- Stored output adds a `settled` field next to the specified ones.
- Stage B (Chromium backend, network interception) is not attempted.
