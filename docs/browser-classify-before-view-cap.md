# Browser classify-before-view-cap (cap_browser_interaction_13 amendment)

Status: **partial. Not a delta to `ToolRegistry.call`, and not a remount.**

## Preflight: not completed

The author of this change could see only the repository file listing, not file
contents or main's SHA. Therefore:

- main SHA: not recorded.
- Signatures of the shared classifier, `ToolResult`, `ObservationStore` and the
  existing view-cap function: not inspected, not published here.
- `browser_page_session.test.ts` and a `WebEgressAuthorizer` file: absent from
  the listing.
- Whether `tool_registry.ts` already classifies before capping (the listing
  shows `classify_before_truncate.ts` and
  `browser_classification_paged_recall.test.ts`): unknown.

## Root cause: no claim

No local FAIL-then-PASS was produced. Classifying from the truncated view
remains a suspected cause only.

## What this PR adds

`src/runtime/browser_view_cap_pipeline.ts`, a standalone module that imports
nothing from the runtime, plus tests:

- `classifyThenCap`: classify the full result with an injected classifier,
  then store the full output, then build the 24 KiB (bytes, UTF-8-safe) view.
  `call_id`, `status` and the truncation marker are outside the payload.
- `recallPage` / `recallAll`: byte-offset paging over the stored full output.

It defines no classifier of its own; the shared classifier stays authoritative.

## Not done

- Not wired into `ToolRegistry.call`; the primary guard through the public
  registry is therefore **not** covered by this PR. The tests here exercise the
  new module directly.
- docGeneration bump on click and type: not tested here.
- It may overlap `classify_before_truncate.ts` / `browser_snapshot_view.ts`.
  A follow-up with file access should either wire this in or delete it in
  favour of the existing modules.

All prior fields of cap_browser_interaction_13 remain in force.
