import { describe, expect, it } from "vitest";
import {
  ConsolidatedEvidenceValidator,
  LocalRecoveryLedger,
  QueueStartupError,
  TaskQueue,
  freezeQueuePolicy,
  rejectQueueToolsFromDelegation,
  type CitationHandler,
  type DurableRunService,
  type QueueJournalEntry,
  type QueueSnapshot,
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
      citation.startsWith("obs:") ? { ok: true as const } : { ok: false as const, reason: "shape" },
  };
}

function runtime(handlers: CitationHandler[] = [handlerOk()], extra: Record<string, unknown> = {}) {
  return TaskQueueRuntime.start({
    policy: policy(),
    runCaps: RUN_CAPS,
    hostTask: "host-goal",
    handlers,
    ...extra,
  });
}

class MemoryJournal implements DurableRunService {
  entries: QueueJournalEntry[] = [];
  snap: QueueSnapshot | null = null;
  failNextAppend = false;
  async journalAppend(entry: QueueJournalEntry) {
    if (this.failNextAppend) return { error: "io" };
    const fence = this.entries.length + 1;
    this.entries.push({ ...entry, fence });
    return { fence };
  }
  async journalRead() {
    return this.entries;
  }
  async checkpointWrite(snapshot: QueueSnapshot) {
    this.snap = snapshot;
    return { ok: true as const };
  }
  async checkpointRead() {
    return this.snap;
  }
}

describe("cap_task_queue_47 runtime dispatch", () => {
  it("rejects durable mode when the mounted service is missing", () => {
    expect(() =>
      TaskQueueRuntime.start({
        policy: policy({ mode: "durable" }),
        runCaps: RUN_CAPS,
        hostTask: "host",
      }),
    ).toThrow(QueueStartupError);
  });

  it("rejects durable mode when required exports are missing", () => {
    expect(() =>
      TaskQueue.create({
        policy: freezeQueuePolicy(policy({ mode: "durable" }), RUN_CAPS)!,
        durableService: { journalAppend: async () => ({ fence: 1 }) } as unknown as DurableRunService,
      }),
    ).toThrow(/missing export/);
  });

  it("absent policy writes nothing and preserves adapter call counts", () => {
    const rt = TaskQueueRuntime.start({ policy: null, runCaps: RUN_CAPS, hostTask: "host" });
    const listed = rt.dispatch("list_tasks", {});
    const enq = rt.dispatch("enqueue_task", { title: "t", goal: "g" });
    expect(listed.ok).toBe(true);
    expect(listed.tasks).toEqual([]);
    expect(enq.ok).toBe(false);
    expect(enq.started).toBe(false);
    expect(rt.adapterCalls).toBe(2);
    expect(rt.snapshot()).toBeNull();
    expect(rt.trace()).toEqual(["absent:list_tasks", "absent:enqueue_task"]);
  });

  it("rejects cycles, missing deps, duplicates and self-deps before mutation", () => {
    const rt = runtime();
    const a = rt.dispatch("enqueue_task", { title: "A", goal: "do a" });
    expect(a.ok).toBe(true);
    const id = a.task!.task_id;
    const dup = rt.dispatch("enqueue_task", { title: "B", goal: "do b", depends_on: [id, id] });
    expect(dup.started).toBe(false);
    expect(dup.code).toBe("invalid_args");
    const missing = rt.dispatch("enqueue_task", { title: "B", goal: "do b", depends_on: ["nope"] });
    expect(missing.started).toBe(false);
    expect(rt.dispatch("list_tasks", {}).tasks).toHaveLength(1);
  });

  it("FIFO activation, complete_task only for active, explicit_none is not success evidence", () => {
    const rt = runtime();
    const a = rt.dispatch("enqueue_task", { title: "A", goal: "first" });
    const b = rt.dispatch("enqueue_task", { title: "B", goal: "second" });
    expect(a.task!.task_id < b.task!.task_id || a.task!.sequence <= b.task!.sequence).toBe(true);
    const notActive = rt.dispatch("complete_task", { task_id: a.task!.task_id, explicit_none: true });
    expect(notActive.started).toBe(false);
    expect(notActive.error).toBe("not_active_task");
    const activated = rt.activateNext();
    expect(activated.task!.task_id).toBe(a.task!.task_id);
    const done = rt.dispatch("complete_task", { task_id: a.task!.task_id, explicit_none: true });
    expect(done.ok).toBe(true);
    expect(done.task!.explicit_none).toBe(true);
    expect(done.task!.state).toBe("done");
    const again = rt.dispatch("complete_task", { task_id: a.task!.task_id, explicit_none: true });
    expect(again.started).toBe(false);
    expect(again.error).toBe("terminal_task");
    const status = rt.statusSection();
    expect(status).toContain("not citable proof");
    expect(status).toContain(a.task!.task_id);
  });

  it("same-turn complete_task does not equal final_answer; final_answer abandons the rest", () => {
    const rt = runtime();
    const a = rt.dispatch("enqueue_task", { title: "A", goal: "first" });
    rt.dispatch("enqueue_task", { title: "B", goal: "second" });
    rt.activateNext();
    rt.dispatch("complete_task", { task_id: a.task!.task_id, citations: ["obs:1"] });
    expect(rt.snapshot()!.finalized).toBe(false);
    const next = rt.activateNext();
    expect(next.ok).toBe(true);
    rt.onFinalAnswer();
    const tasks = rt.dispatch("list_tasks", {}).tasks!;
    expect(tasks.find((t) => t.task_id === a.task!.task_id)!.state).toBe("done");
    expect(tasks.find((t) => t.title === "B")!.state).toBe("abandoned");
    expect(tasks.find((t) => t.title === "B")!.reasons).toContain("run_finalized");
    expect(rt.snapshot()!.finalized).toBe(true);
    const after = rt.dispatch("enqueue_task", { title: "C", goal: "third" });
    expect(after.started).toBe(false);
  });

  it("abandoning the active task while a slot is open cannot authorize another segment", () => {
    const ledger = new LocalRecoveryLedger();
    const rt = TaskQueueRuntime.start({
      policy: policy(),
      runCaps: RUN_CAPS,
      hostTask: "host",
      handlers: [handlerOk()],
      ledger,
    });
    const a = rt.dispatch("enqueue_task", { title: "A", goal: "first goal" });
    rt.dispatch("enqueue_task", { title: "B", goal: "second goal" });
    rt.activateNext();
    expect(ledger.openSlot(a.task!.task_id).ok).toBe(true);
    const abandoned = rt.dispatch("update_task", {
      task_id: a.task!.task_id,
      abandon: true,
      reason: "user dropped it",
    });
    expect(abandoned.ok).toBe(true);
    expect(abandoned.task!.state).toBe("abandoned");
    const sneak = rt.activateNextAfterAbandon();
    expect(sneak.ok).toBe(false);
    expect(sneak.error).toBe("abandon_cannot_authorize_segment");
    const direct = rt.activateNext();
    expect(direct.ok).toBe(false);
    expect(direct.error).toBe("recovery_slot_open");
  });

  it("unknown outcome blocks continuation; list_tasks does not reconcile", () => {
    const rt = runtime();
    const a = rt.dispatch("enqueue_task", { title: "A", goal: "first" });
    rt.activateNext();
    rt.recordUnknownOutcome(a.task!.task_id);
    const listed = rt.dispatch("list_tasks", {});
    expect(listed.tasks![0].unknown_outcome).toBe(true);
    expect(listed.tasks![0].state).toBe("blocked");
    expect(rt.activateNext().error).toBe("unknown_outcome_open");
    const complete = rt.dispatch("complete_task", { task_id: a.task!.task_id, explicit_none: true });
    expect(complete.started).toBe(false);
  });

  it("cumulative recovery is not replenished by paraphrased re-enqueue or notes", () => {
    const ledger = new LocalRecoveryLedger();
    const rt = TaskQueueRuntime.start({
      policy: policy({ maxRecoveryDispatches: 1, perTaskStepCap: 1, maxTotalSteps: 10 }),
      runCaps: { ...RUN_CAPS, maxRecoveryDispatches: 1 },
      hostTask: "host",
      ledger,
      handlers: [handlerOk()],
    });
    const a = rt.dispatch("enqueue_task", { title: "A", goal: "ship the report" });
    rt.activateNext();
    rt.admitSharedStep();
    const failed = rt.admitSharedStep();
    expect(failed.ok).toBe(false);
    expect(failed.reason).toBe("per_task_step_cap");
    const retired = rt.retireKnownFailure(a.task!.task_id);
    expect(retired.ok).toBe(true);
    expect(rt.snapshot()!.recoveryDispatchesUsed).toBe(1);
    const note = rt.dispatch("update_task", { task_id: a.task!.task_id, note: "please reset budget" });
    expect(note.ok).toBe(false);
    const paraphrase = rt.dispatch("enqueue_task", { title: "A2", goal: "Ship   the REPORT" });
    expect(paraphrase.started).toBe(false);
    const other = rt.dispatch("enqueue_task", { title: "B", goal: "unrelated cleanup" });
    expect(other.ok).toBe(true);
    rt.activateNext();
    rt.admitSharedStep();
    rt.admitSharedStep();
    const second = rt.retireKnownFailure(other.task!.task_id);
    expect(second.ok).toBe(false);
    expect(second.code).toBe("budget");
    expect(rt.snapshot()!.recoveryDispatchesUsed).toBe(1);
  });

  it("citation handlers unavailable stay unavailable; passing citations do not verify the goal", () => {
    const rt = runtime([{ id: "obs", available: false, validate: () => ({ ok: true }) }]);
    const a = rt.dispatch("enqueue_task", { title: "A", goal: "prove it" });
    rt.activateNext();
    const denied = rt.dispatch("complete_task", { task_id: a.task!.task_id, citations: ["obs:1"] });
    expect(denied.code).toBe("unavailable");
    expect(denied.started).toBe(false);
    expect(rt.snapshot()!.tasks[0].state).toBe("active");
  });

  it("delegation allowlists that include queue tools are a configuration error", () => {
    const rt = runtime();
    expect(() => rt.assertDelegationAllowlist(["echo", "complete_task"])).toThrow(
      /queue_tools_excluded_from_delegation/,
    );
    expect(rejectQueueToolsFromDelegation(["echo"]).ok).toBe(true);
  });

  it("segment view keeps host task and does not erase unresolved operations", () => {
    const rt = runtime();
    rt.dispatch("enqueue_task", { title: "A", goal: "segment goal" });
    rt.activateNext();
    const view = rt.segment()!;
    expect(view.hostTask).toBe("host-goal");
    expect(view.currentGoal).toBe("segment goal");
    rt.recordUnknownOutcome(view.activeTaskId!);
    const after = rt.segment()!;
    expect(after.protectedState.unresolved).toBe(true);
    expect(after.protectedState.unknownOutcome).toBe(true);
    expect(after.hostTask).toBe("host-goal");
  });

  it("durable resume restores committed state without replay; interrupted fence stays unresolved", async () => {
    const journal = new MemoryJournal();
    const rt = TaskQueueRuntime.start({
      policy: policy({ mode: "durable" }),
      runCaps: RUN_CAPS,
      hostTask: "host",
      handlers: [handlerOk()],
      durableService: journal,
    });
    const enq = rt.dispatch("enqueue_task", { title: "A", goal: "persist me" });
    expect(enq.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    const restored = TaskQueueRuntime.start({
      policy: policy({ mode: "durable" }),
      runCaps: RUN_CAPS,
      hostTask: "host",
      handlers: [handlerOk()],
      durableService: journal,
    });
    const resume = await restored.resume();
    expect(resume).toEqual({ restored: true, replayed: false });
    const tasks = restored.dispatch("list_tasks", {}).tasks!;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].goal).toBe("persist me");
    journal.entries.push({
      fence: 99,
      kind: "complete",
      taskId: tasks[0].task_id,
      at: Date.now(),
      payload: { interrupted: true },
    });
    const crashed = TaskQueueRuntime.start({
      policy: policy({ mode: "durable" }),
      runCaps: RUN_CAPS,
      hostTask: "host",
      handlers: [handlerOk()],
      durableService: journal,
    });
    await crashed.resume();
    expect(crashed.trace().some((t) => t.includes("interrupted_transition_unresolved"))).toBe(true);
    expect(crashed.snapshot()!.tasks[0].state).not.toBe("done");
    const complete = crashed.dispatch("complete_task", {
      task_id: tasks[0].task_id,
      citations: ["obs:1"],
    });
    expect(complete.started).toBe(false);
  });

  it("queue caps only tighten run caps", () => {
    const frozen = freezeQueuePolicy(
      { maxTasks: 100, maxTotalSteps: 10_000, maxRecoveryDispatches: 50, wallClockDeadlineMs: 9_999_999, perTaskStepCap: 100 },
      RUN_CAPS,
    )!;
    expect(frozen.maxTasks).toBe(32);
    expect(frozen.maxTotalSteps).toBe(20);
    expect(frozen.maxRecoveryDispatches).toBe(2);
    expect(frozen.wallClockDeadlineMs).toBe(60_000);
    expect(frozen.perTaskStepCap).toBe(20);
  });

  it("failed dependency blocks descendants with a recorded reason", () => {
    const ledger = new LocalRecoveryLedger();
    const rt = TaskQueueRuntime.start({
      policy: policy({ perTaskStepCap: 1 }),
      runCaps: RUN_CAPS,
      hostTask: "host",
      ledger,
      handlers: [handlerOk()],
    });
    const a = rt.dispatch("enqueue_task", { title: "A", goal: "root" });
    rt.dispatch("enqueue_task", { title: "B", goal: "child", depends_on: [a.task!.task_id] });
    rt.activateNext();
    rt.admitSharedStep();
    rt.admitSharedStep();
    const tasks = rt.dispatch("list_tasks", {}).tasks!;
    expect(tasks[0].state).toBe("failed");
    expect(tasks[1].state).toBe("blocked");
    expect(tasks[1].reasons.some((r) => r.includes("dependency_failed"))).toBe(true);
  });

  it("evidence validator refuses empty citations and accepts mounted shapes", () => {
    const v = new ConsolidatedEvidenceValidator();
    expect(v.validateCitations([], [handlerOk()]).ok).toBe(false);
    expect(v.validateCitations(["obs:9"], [handlerOk()]).ok).toBe(true);
    expect(v.validateCitations(["nope"], [handlerOk()]).ok).toBe(false);
  });
});
