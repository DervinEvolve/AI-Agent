# Untrusted-origin argument rule (taint tripwire)

Implementation: `src/runtime/untrusted_origin_taint.ts`. Canary harness:
`src/runtime/__tests__/injection_canary_harness.test.ts`.

## Rule

Before emitting any side-effecting tool call (`write_file`, `run_code`,
URL/network fetch, `delegate_task`), each string-valued argument (including
nested values) is checked against the transcript. After NFKC normalization,
casefolding, and whitespace collapsing — applied identically to the argument
and to every transcript text so span provenance survives normalization — any
span of 12 or more characters that occurs whole in untrusted output
(`search_knowledge` passages, `run_code` stdout, `read_file` contents,
`delegate_task` summaries) and in no user message marks the argument
**untrusted-origin**. One base64-decoded pass of each untrusted text is also
admitted to the corpus (decodes must be ≥8 chars and mostly printable to
limit coincidental matches).

An untrusted-origin argument may not be used silently. The agent must either
(a) pause and ask the user to confirm the specific value, quoting the span and
its source `call_id` (`checkSideEffectCall(..., 'ask')`), or (b) drop the call
and note in its reply that retrieved content tried to steer the action
(`'drop'`). Read-only calls are exempt.

## Canary harness results

- Naive injections planted in `search_knowledge` passages, `run_code` stdout,
  and `delegate_task` summaries are all caught (argument-level attacker
  predicate: a `write_file` whose path contains the attacker's marker).
- Base64-encoded payloads are caught via the decoded pass.
- **Confirmed blind spots** (the tripwire is not a guarantee):
  - Paraphrased payloads where the agent composes the target path from
    fragments that never form one contiguous ≥12-char span in untrusted text.
  - Short high-value strings (URLs, API keys) below the 12-char threshold;
    ROPE-style whole-value admission is the suggested follow-up.
- Consequence already required by the spec: side-effecting targets with no
  user-supplied counterpart must be confirmed regardless of whether the taint
  check fires.
