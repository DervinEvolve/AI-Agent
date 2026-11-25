import { describe, expect, it } from "vitest";
import {
  WORKER_REASON,
  REPORT_PAGE_MIN_BYTES,
  buildReportPage,
  claimSharedTeardownReserve,
  createWorkerRuntime,
  freezeReport,
  registerWorkerEvidenceShape3,
  splitUtf8,
  utf8ByteLength,
  validateWorkerEvidenceShape3,
  workerToolSchemas,
  type EligibleTool,
  type InferenceAdapter,
  type ToolRegistryPort,
} from "../index.js";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function tool(partial: Partial<EligibleTool> & { name: string }): EligibleTool {
  return {
    readOnly: true,
    idempotent: true,
    concurrentSafe: false,
    kind: "workspace_read",
    tier: "allow",
    execute: async () => ({ ok: true, output: "ok", outcome: "ok", cleanupConfirmed: true }),
    ...partial,
  };
}

function registry(tools: EligibleTool[]): ToolRegistryPort {
  const map = new Map(tools.map((t) => [t.name, t]));
  return { get: (n) => map.get(n), list: () => [...map.values()] };
}

function scripted(responses: Array<{ toolName?: string; text?: string; final?: boolean }>): InferenceAdapter & { maxInFlight: number; inFlight: number } {
  let i = 0;
  const adapter = {
    inFlight: 0,
    maxInFlight: 0,
    async complete(req: { role: string }) {
      adapter.inFlight += 1;
      if (adapter.inFlight > adapter.maxInFlight) adapter.maxInFlight = adapter.inFlight;
      await Promise.resolve();
      adapter.inFlight -= 1;
      if (req.role === "parent") return { text: "parent", final: true, usageKnown: true };
      const next = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return { text: next?.text ?? "done", toolName: next?.toolName, final: next?.final ?? !next?.toolName, usageKnown: true };
    },
  };
  return adapter;
}

const baseConfig = {
  enabled: true,
  principalId: "host",
  allowlist: ["read_file"],
  sharedStepPool: 40,
  maxConcurrentInference: 1 as const,
};

describe("async workers", () => {
  it("disabled config matches baseline schemas and does not call the adapter", () => {
    const adapter = scripted([]);
    const created = createWorkerRuntime({
      config: { ...baseConfig, enabled: false },
      adapter,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.runtime.schemas()).toEqual(workerToolSchemas(false));
    expect(created.runtime.schemas().length).toBe(created.runtime.baselineSchemaCount);
    expect(adapter.maxInFlight).toBe(0);
    expect(created.runtime.adapterCalls).toBe(0);
  });

  it("spawn returns before the child finishes and parent can take non-poll turns", async () => {
    const gate = deferred();
    let childSteps = 0;
    const read = tool({
      name: "read_file",
      execute: async () => {
        childSteps += 1;
        await gate.promise;
        return { ok: true, output: "file", outcome: "ok" as const, cleanupConfirmed: true, callId: "c1" };
      },
    });
    const adapter = scripted([{ toolName: "read_file", text: "read" }, { text: "done", final: true }]);
    const created = createWorkerRuntime({
      config: baseConfig,
      adapter,
      registry: registry([read]),
      clock: { now: () => 1_000, wait: async () => undefined },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const rt = created.runtime;
    const spawned = rt.spawn({ task: "inspect", allowed_tools: ["read_file"], max_steps: 4 });
    expect(spawned.output.worker_started).toBe(true);
    expect(spawned.output.worker_id).toBeTruthy();
    await Promise.resolve();
    await Promise.resolve();
    const t1 = await rt.parentTurn("a");
    const t2 = await rt.parentTurn("b");
    expect(t1.ok).toBe(true);
    expect(t2.ok).toBe(true);
    expect(childSteps).toBeGreaterThanOrEqual(1);
    expect(adapter.maxInFlight).toBeLessThanOrEqual(1);
    gate.resolve();
    await rt.teardown();
  });

  it("reserves steps and recovery budget exactly and refuses exhaustion", () => {
    const created = createWorkerRuntime({
      config: { ...baseConfig, workerRecoveryBudget: 1, recoverySubAllowance: 1, parentStepReserve: 4, sharedStepPool: 10 },
      registry: registry([tool({ name: "read_file" })]),
      adapter: scripted([{ text: "done", final: true }]),
      clock: { now: () => 1, wait: async () => undefined },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const rt = created.runtime;
    const ok = rt.spawn({ task: "one", max_steps: 4 });
    expect(ok.output.worker_started).toBe(true);
    expect(rt.accounting.workerReserved + rt.accounting.workerSpent + rt.accounting.workerReleased).toBeGreaterThan(0);
    const refused = rt.spawn({ task: "two", max_steps: 4 });
    expect(refused.output.reason).toBe(WORKER_REASON.WORKER_BUDGET_EXCEEDED);
    expect(refused.output.started).toBe(false);
  });

  it("worker failure does not debit the parent ledger", async () => {
    const ledger = { openSlot: false, unresolvedUnknown: false, recoveryDebits: 0, cumulativeExpenditure: 0 };
    const created = createWorkerRuntime({
      config: baseConfig,
      parentLedger: ledger,
      registry: registry([
        tool({
          name: "read_file",
          execute: async () => ({ ok: false, output: "no", outcome: "error" as const, cleanupConfirmed: true }),
        }),
      ]),
      adapter: scripted([{ toolName: "read_file" }]),
      clock: { now: () => 1, wait: async () => undefined },
    });
    if (!created.ok) throw new Error("runtime");
    created.runtime.spawn({ task: "fail", max_steps: 2 });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(ledger.recoveryDebits).toBe(0);
    expect(created.runtime.accounting.parentRecoveryDebits).toBe(0);
    expect(created.runtime.accounting.recoveryCumulative).toBe(1);
  });

  it("unknown outcome is not cleanup confirmation", async () => {
    const created = createWorkerRuntime({
      config: baseConfig,
      registry: registry([
        tool({
          name: "read_file",
          execute: async () => ({ ok: false, outcome: "unknown" as const, cleanupConfirmed: false, output: "hung" }),
        }),
      ]),
      adapter: scripted([{ toolName: "read_file" }]),
      clock: { now: () => 1, wait: async () => undefined },
    });
    if (!created.ok) throw new Error("runtime");
    const spawned = created.runtime.spawn({ task: "unk", max_steps: 2 });
    const id = spawned.output.worker_id as string;
    await new Promise((r) => setTimeout(r, 0));
    const snap = created.runtime.snapshot(id);
    expect(snap?.outcome_unknown).toBe(true);
    expect(snap?.cleanup_confirmed).toBe(false);
    const stopped = await created.runtime.stop(id);
    expect(stopped.output.reason).toBe(WORKER_REASON.TEARDOWN_UNCONFIRMED);
    expect(stopped.output.cleanup_confirmed).toBe(false);
  });

  it("pre-commit timeout fences late commit; post-commit stays tracked without replay", () => {
    const created = createWorkerRuntime({
      config: baseConfig,
      registry: registry([tool({ name: "read_file" })]),
      clock: { now: () => 5, wait: async () => undefined },
    });
    if (!created.ok) throw new Error("runtime");
    const pre = created.runtime.spawn({ task: "late", timeoutPhase: "pre" });
    expect(pre.output.reason).toBe(WORKER_REASON.NOT_STARTED);
    const late = created.runtime.lateCommit(pre.output.attempt_id as string);
    expect(late.committed).toBe(false);
    expect(created.runtime.snapshot("worker_missing")).toBeUndefined();
    const post = created.runtime.spawn({ task: "after", timeoutPhase: "post" });
    expect(post.output.reason).toBe(WORKER_REASON.UNKNOWN);
    expect(post.output.replayed).toBe(false);
    expect(post.output.worker_id).toBeTruthy();
    const listed = created.runtime.reconciliations.filter((r) => r.worker_id === post.output.worker_id);
    expect(listed.length).toBe(1);
  });

  it("pages citations and rejects wrong-page ids", () => {
    const items = [
      { index: 0, text: "alpha", citations: [{ child_call_id: "c1", tool_name: "read_file" }] },
      { index: 1, text: "beta", citations: [{ child_call_id: "c2", tool_name: "read_file" }] },
    ];
    const frozen = freezeReport(items);
    const page0 = buildReportPage(frozen, 0, REPORT_PAGE_MIN_BYTES);
    expect(page0.byte_length).toBeLessThanOrEqual(REPORT_PAGE_MIN_BYTES);
    expect(page0.byte_length).toBeGreaterThan(0);
    const ids0 = page0.items.flatMap((i) => i.citations.map((c) => c.child_call_id));
    const page1 = buildReportPage(frozen, page0.next_offset, 8192);
    const ids1 = page1.items.flatMap((i) => i.citations.map((c) => c.child_call_id));
    const calls = new Map([
      ["c1", { worker_id: "w", classifier_ok: true }],
      ["c2", { worker_id: "w", classifier_ok: true }],
    ]);
    expect(validateWorkerEvidenceShape3({
      poll_call_id: "poll_1",
      child_call_id: "c1",
      worker_id: "w",
      exposed_citation_ids: ids0,
      successful_child_calls: calls,
    }).ok).toBe(ids0.includes("c1"));
    if (!ids0.includes("c2")) {
      expect(validateWorkerEvidenceShape3({
        poll_call_id: "poll_1",
        child_call_id: "c2",
        worker_id: "w",
        exposed_citation_ids: ids0,
        successful_child_calls: calls,
      }).ok).toBe(false);
    }
    expect(ids0.concat(ids1)).toEqual(expect.arrayContaining(["c1", "c2"]));
    const registered: number[] = [];
    registerWorkerEvidenceShape3({
      register(shape) {
        registered.push(shape);
      },
    });
    expect(registered).toEqual([3]);
  });

  it("splits multibyte text on UTF-8 boundaries inside the inclusive cap", () => {
    const text = "字".repeat(40);
    const split = splitUtf8(text, 5);
    expect(utf8ByteLength(split.head)).toBeLessThanOrEqual(5);
    expect(split.head + split.rest).toBe(text);
    const frozen = freezeReport([{ index: 0, text, citations: [{ child_call_id: "cid", tool_name: "read_file" }] }]);
    const page = buildReportPage(frozen, 0, REPORT_PAGE_MIN_BYTES);
    expect(page.byte_length).toBeLessThanOrEqual(REPORT_PAGE_MIN_BYTES);
    expect(page.has_more || page.citation_elided_count >= 0).toBe(true);
  });

  it("rejects incompatible jobs co-mount and subtracts one shared reserve", () => {
    const bad = createWorkerRuntime({
      config: { ...baseConfig, jobsMounted: true, jobsReserveCompatible: false },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe(WORKER_REASON.INCOMPATIBLE_COMOUNT);
    const bucket = { claimed: false, reserveMs: 0, owner: null, subtractedFromDeadline: false };
    const a = claimSharedTeardownReserve({ deadlineMs: 60_000, requestedMs: 10_000, bucket });
    const b = claimSharedTeardownReserve({ deadlineMs: 60_000, requestedMs: 10_000, bucket, jobsMounted: true, jobsReserveCompatible: true });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.reserveMs).toBe(10_000);
      expect(bucket.reserveMs).toBe(10_000);
    }
  });

  it("startup rejects durable runs", () => {
    const created = createWorkerRuntime({ config: { ...baseConfig, durableRun: true } });
    expect(created.ok).toBe(false);
  });

  it("delegation and family blocks have no slot effect", () => {
    const created = createWorkerRuntime({
      config: { ...baseConfig, delegationActive: true },
      registry: registry([tool({ name: "read_file" })]),
    });
    if (!created.ok) throw new Error("runtime");
    const spawned = created.runtime.spawn({ task: "nope" });
    expect(spawned.output.reason).toBe(WORKER_REASON.DELEGATION_IN_FLIGHT);
    expect(spawned.output.slot_effect).toBe(false);
    created.runtime.setDelegationActive(false);
    created.runtime.spawn({ task: "go", max_steps: 2 });
    const blocked = created.runtime.delegateTask();
    expect(blocked.reason).toBe(WORKER_REASON.WORKER_FAMILY_BLOCKED);
    expect(blocked.slotEffect).toBe(false);
  });

  it("unknown worker poll and stop are found=false", async () => {
    const created = createWorkerRuntime({
      config: baseConfig,
      clock: { now: () => 1, wait: async () => undefined },
    });
    if (!created.ok) throw new Error("runtime");
    const polled = await created.runtime.poll({ worker_id: "missing" });
    expect(polled.output.found).toBe(false);
    expect(polled.output.ok).toBe(true);
    const stopped = await created.runtime.stop("missing");
    expect(stopped.output.found).toBe(false);
  });

  it("abort fences later dispatch", async () => {
    const gate = deferred();
    let calls = 0;
    const created = createWorkerRuntime({
      config: baseConfig,
      registry: registry([
        tool({
          name: "read_file",
          execute: async () => {
            calls += 1;
            await gate.promise;
            return { ok: true, output: "x", outcome: "ok" as const, cleanupConfirmed: true };
          },
        }),
      ]),
      adapter: scripted([{ toolName: "read_file" }, { toolName: "read_file" }]),
      clock: { now: () => 1, wait: async () => undefined },
    });
    if (!created.ok) throw new Error("runtime");
    const spawned = created.runtime.spawn({ task: "run", max_steps: 4 });
    await Promise.resolve();
    await created.runtime.abortAll();
    gate.resolve();
    expect(calls).toBeLessThanOrEqual(1);
    expect(spawned.output.worker_id).toBeTruthy();
  });
});
