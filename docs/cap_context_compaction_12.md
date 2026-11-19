# cap_context_compaction_12

Runtime-owned context compaction is an opt-in mount on `AgentRuntime`. Unconfigured runs (no `summarizer`) keep the previous loop: no summary, no compaction pass, identical overflow handling.

## Published return unions

### `ContextManager.evaluateFit`

```ts
type ContextFit =
  | { outcome: "already_fits"; serializedChars: number; budgetChars: number }
  | {
      outcome: "fits_after_compaction";
      prefixOrdinals: number[];
      serializedChars: number;
      budgetChars: number;
    }
  | {
      outcome: "unfit";
      reason:
        | "tail_alone_cannot_fit"
        | "eligible_prefix_empty"
        | "eligible_prefix_insufficient"
        | "summarizer_absent";
      serializedChars: number;
      budgetChars: number;
    };
```

### `AgentRuntime.run` compaction fields (additive)

When a summarizer is mounted, a terminal result may include:

```ts
type CompactionOutcome =
  | { kind: "already_fits" }
  | { kind: "fits_after_compaction"; compactedOrdinals: number[] }
  | {
      kind: "unfit";
      reason:
        | "tail_alone_cannot_fit"
        | "eligible_prefix_empty"
        | "eligible_prefix_insufficient"
        | "summarizer_absent"
        | "shared_cap";
      status: "incomplete";
    };
```

Only `kind: "unfit"` is bounded incomplete. Summary and transcript are unchanged on unfit and on shared-cap halt.

Shared-cap reasons reuse the runtime usage strings:

- `model_call_cap_exhausted`
- `model_call_usage_unknown`

Usage halt precedes decode-reject counting. No ToolResult or ObservationStore rollback.

## Prefix selection

Atomic groups are an assistant tool-call message plus all of its ToolResults (never a single `call_id`). The selector takes the shortest oldest contiguous prefix of eligible groups whose removal, after substituting a ≤4000-character untrusted summary and re-rendering the previous summary inside the measured request, makes the next serialized request fit including response and compaction headroom.

Stop at the first ineligible or unresolved/unknown-outcome group. Never skip it. Never compact the newest group. Successive successes cover disjoint, strictly increasing ordinals.

## Recall

Rendered `recall_refs` stay within 16 metadata-only entries (`call_id`, status, truncation flag). ObservationStore is not deleted. Recall of a compacted `call_id` still returns stored output.
