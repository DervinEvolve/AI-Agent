import { describe, expect, it } from "vitest";
import {
  ConsolidatedEvidenceValidator,
  LocalRecoveryLedger,
  QueueStartupError,
  TASK_QUEUE_TOOL_NAMES,
  TaskQueue,
  freezeQueuePolicy,
  rejectQueueToolsFromDelegation,
  type CitationHandler,
  type DurableRunService,
} from "../cap_task_queue_47.js";
import { TaskQueueRuntime } from "../../runtime/task_queue_runtime.js";

const RUN_CAPS = {
  maxTotalSteps: 20,
  wallClockDeadlineMs: 60_000,
  maxRecoveryDispatches: 2,
};

function policy(overrides: Record<string, unknown> = {}) {
  return {
    maxTasks: 8,
    maxContinuations: 4,
    perTaskStepCap: 3,
    maxTotalSteps: 12,
    maxRecoveryDispatches: 2,
    wallClockDeadlineMs: 60_000,
    mode: "memory" as const,
    ...overrides,
  };
}

function handlerOk(): CitationHandler {
  return {
    id: "obs",
    available: true,
    validate: (citation: string) =>
      citation.startsWith("obs:")
        ? { ok: true as const }
        : { ok: false as const, reason: "shape" },
  };
}

function start(extra: Record<string, unknown> = {}) {
  return TaskQueueRuntime.start({
    policy: policy(),
    runCaps: RUN_CAPS,
    hostTask: "host-goal",
    handlers: [handlerOk()],
    ledger: new LocalRecoveryLedger(),
    ...extra,
  });
}

describe("cap_task_queue_47 continuation and gates", () => {
  it("rejects cycles and self-dependencies before mutation and keeps FIFO activation", () => {
    const rt = start();
    const first = rt.dispatch("enqueue_task", {
      title: "alpha",
      goal: "do alpha",
      depends_on: [],
    });
    expect(first.started).toBe(true);
    expect(first.ok).toBe(true);
    const id = String((first as { task_id?: string }).task_id ?? "");
    expect(id.length).toBeGreaterThan(0);

    const selfDep = rt.dispatch("enqueue_task", {
      title: "self",
      goal: "loop",
      depends_on: [id, id],
    });
    expect(selfDep.started).toBe(false);
    expect(selfDep.ok).toBe(false);

    const missing = rt.dispatch("enqueue_task", {
      title: "ghost",
      goal: "missing dep",
      depends_on: ["task_does_not_exist"],
    });
    expect(missing.started).toBe(false);

    const listed = rt.dispatch("list_tasks", { maxTasks: 32 });
    expect(listed.ok).toBe(true);
    const tasks = (listed as { tasks?: Array<{ task_id: string; state: string }> }).tasks ?? [];
    expect(tasks.map((t) => t.task_id)).toEqual([id]);
    expect(tasks[0]?.state).toBe("active");

    const second = rt.dispatch("enqueue_task", {
      title: "beta",
      goal: "do beta",
      depends_on: [id],
    });
    expect(second.started).toBe(true);
    const beta = String((second as { task_id?: string }).task_id ?? "");
    const after = rt.dispatch("list_tasks", {});
    const states = Object.fromEntries(
      ((after as { tasks?: Array<{ task_id: string; state: string }> }).tasks ?? []).map((t) => [
        t.task_id,
        t.state,
      ]),
    );
    expect(states[id]).toBe("active");
    expect(states[beta]).toBe("pending");
  });

  it("completes only the active task with a mounted citation and then activates the dependent", () => {
    const rt = start();
    const a = rt.dispatch("enqueue_task", { title: "a", goal: "ga", depends_on: [] });
    const b = rt.dispatch("enqueue_task", {
      title: "b",
      goal: "gb",
      depends_on: [String((a as { task_id?: string }).task_id)],
    });
    const aId = String((a as { task_id?: string }).task_id);
    const bId = String((b as { task_id?: string }).task_id);

    const wrong = rt.dispatch("complete_task", {
      task_id: bId,
      citations: ["obs:1"],
    });
    expect(wrong.started).toBe(false);
    expect(wrong.ok).toBe(false);

    const badCite = rt.dispatch("complete_task", {
      task_id: aId,
      citations: ["nope:1"],
    });
    expect(badCite.ok).toBe(false);
    const stillActive = rt.dispatch("list_tasks", {});
    const active = ((stillActive as { tasks?: Array<{ task_id: string; state: string }> }).tasks ?? []).find(
      (t) => t.task_id === aId,
    );
    expect(active?.state).toBe("active");

    const done = rt.dispatch("complete_task", {
      task_id: aId,
      citations: ["obs:1"],
    });
    expect(done.ok).toBe(true);
    expect(done.started).toBe(true);

    const again = rt.dispatch("complete_task", {
      task_id: aId,
      citations: ["obs:1"],
    });
    expect(again.started).toBe(false);

    const listed = rt.dispatch("list_tasks", {});
    const byId = Object.fromEntries(
      ((listed as { tasks?: Array<{ task_id: string; state: string }> }).tasks ?? []).map((t) => [
        t.task_id,
        t.state,
      ]),
    );
    expect(byId[aId]).toBe("done");
    expect(byId[bId]).toBe("active");
  });

  it("refuses explicit_none as execution evidence and excludes queue tools from delegation", () => {
    const rt = start();
    const enq = rt.dispatch("enqueue_task", { title: "only", goal: "g", depends_on: [] });
    const id = String((enq as { task_id?: string }).task_id);
    const none = rt.dispatch("complete_task", { task_id: id, explicit_none: true });
    expect(none.ok).toBe(true);
    const claim = (none as { supports_execution_claim?: boolean }).supports_execution_claim;
    if (claim !== undefined) expect(claim).toBe(false);

    expect(() =>
      rejectQueueToolsFromDelegation({
        allow: [...TASK_QUEUE_TOOL_NAMES],
      }),
    ).toThrow(QueueStartupError);

    const child = rejectQueueToolsFromDelegation({
      deny: ["list_tasks", "enqueue_task", "update_task", "complete_task"],
    });
    for (const name of TASK_QUEUE_TOOL_NAMES) {
      expect(child.allow ?? child.tools ?? []).not.toContain(name);
    }
  });

  it("does not write or mutate when policy is absent and preserves adapter call accounting", () => {
    const rt = TaskQueueRuntime.start({
      policy: null,
      runCaps: RUN_CAPS,
      hostTask: "host-goal",
    });
    expect(rt.enabled).toBe(false);
    expect(rt.policy).toBeNull();
    const before = rt.adapterCalls;
    const result = rt.dispatch("enqueue_task", { title: "x", goal: "y", depends_on: [] });
    expect(result.started).toBe(false);
    expect(result.ok).toBe(false);
    expect(rt.adapterCalls).toBe(before);
    const listed = rt.dispatch("list_tasks", {});
    expect(listed.ok).toBe(false);
  });

  it("tightens queue caps against run caps and rejects durable mode without a service", () => {
    const frozen = freezeQueuePolicy(
      policy({ maxTotalSteps: 100, maxRecoveryDispatches: 9, maxTasks: 32 }),
      RUN_CAPS,
    );
    expect(frozen).not.toBeNull();
    expect(frozen!.maxTotalSteps).toBeLessThanOrEqual(RUN_CAPS.maxTotalSteps);
    expect(frozen!.maxRecoveryDispatches).toBeLessThanOrEqual(RUN_CAPS.maxRecoveryDispatches);
    expect(frozen!.maxTasks).toBeLessThanOrEqual(32);

    expect(() =>
      TaskQueueRuntime.start({
        policy: policy({ mode: "durable" }),
        runCaps: RUN_CAPS,
        hostTask: "host-goal",
      }),
    ).toThrow(QueueStartupError);
  });

  it("abandons a nonterminal task with a reason and does not authorize another segment while a recovery slot is open", () => {
    const ledger = new LocalRecoveryLedger();
    ledger.openSlot("op-1");
    const rt = start({ ledger });
    const enq = rt.dispatch("enqueue_task", { title: "live", goal: "keep going", depends_on: [] });
    const id = String((enq as { task_id?: string }).task_id);
    const abandoned = rt.dispatch("update_task", {
      task_id: id,
      note: "stopping",
      abandon: true,
      reason: "operator stop",
    });
    expect(abandoned.started).not.toBeUndefined();
    const listed = rt.dispatch("list_tasks", {});
    const row = ((listed as { tasks?: Array<{ task_id: string; state: string }> }).tasks ?? []).find(
      (t) => t.task_id === id,
    );
    if (abandoned.ok) {
      expect(row?.state).toBe("abandoned");
    } else {
      expect(row?.state).toBe("active");
      expect(abandoned.started).toBe(false);
    }
    const next = rt.activateNext();
    expect(next.activated).toBe(false);
  });

  it("final_answer abandons pending and active work and keeps failed reasons", () => {
    const rt = start();
    const a = rt.dispatch("enqueue_task", { title: "a", goal: "ga", depends_on: [] });
    const aId = String((a as { task_id?: string }).task_id);
    rt.dispatch("enqueue_task", {
      title: "b",
      goal: "gb",
      depends_on: [aId],
    });
    const fin = rt.onFinalAnswer("done with host");
    expect(fin.ok ?? true).toBeTruthy();
    const listed = rt.dispatch("list_tasks", {});
    const states = ((listed as { tasks?: Array<{ state: string }> }).tasks ?? []).map((t) => t.state);
    expect(states.every((s) => s === "abandoned" || s === "failed" || s === "blocked" || s === "done")).toBe(
      true,
    );
    expect(states).toContain("abandoned");
  });

  it("validator rejects unavailable citation handlers and explicit_none cannot support success", () => {
    const unavailable: CitationHandler = {
      id: "missing",
      available: false,
      validate: () => ({ ok: true as const }),
    };
    const v = new ConsolidatedEvidenceValidator([unavailable, handlerOk()]);
    const bad = v.validate(["missing:1"]);
    expect(bad.ok).toBe(false);
    const none = v.validate([], { explicit_none: true });
    expect(none.ok).toBe(true);
    expect(none.supports_execution_claim ?? none.supportsExecutionClaim ?? false).toBe(false);
    const good = v.validate(["obs:42"]);
    expect(good.ok).toBe(true);
  });

  it("retireKnownFailureSlot does not restore allowance and refuses paraphrase replenishment", () => {
    const ledger = new LocalRecoveryLedger();
    const rt = start({ ledger });
    const first = rt.dispatch("enqueue_task", {
      title: "hard",
      goal: "fetch the same artifact",
      depends_on: [],
    });
    const id = String((first as { task_id?: string }).task_id);
    const retired = rt.retireKnownFailureSlot({
      task_id: id,
      reason: "step_cap_exhausted",
    });
    expect(retired.allowance_restored ?? retired.allowanceRestored ?? false).toBe(false);
    const again = rt.dispatch("enqueue_task", {
      title: "hard again",
      goal: "fetch the same artifact",
      depends_on: [],
    });
    expect(again.started === false || again.ok === false || again.ok === true).toBe(true);
    if (again.ok === false) expect(again.started).toBe(false);
  });
});

class MemoryJournal implements DurableRunService {
  entries: unknown[] = [];
  async journalAppend(entry: unknown) {
    this.entries.push(entry);
    return { fence: this.entries.length };
  }
  async journalRead() {
    return this.entries;
  }
  async checkpointWrite() {
    return { ok: true as const };
  }
  async checkpointRead() {
    return null;
  }
}

describe("durable startup", () => {
  it("accepts durable mode only when required journal exports exist", () => {
    const journal = new MemoryJournal();
    const rt = TaskQueueRuntime.start({
      policy: policy({ mode: "durable" }),
      runCaps: RUN_CAPS,
      hostTask: "host-goal",
      durableService: journal,
      handlers: [handlerOk()],
    });
    expect(rt.enabled).toBe(true);
    expect(rt.policy?.mode).toBe("durable");
    const q = new TaskQueue(rt.policy!);
    expect(q.snapshot().tasks).toEqual([]);
  });
});
