import { describe, it, expect } from "vitest";
import behPortfolioOrchestration26, {
  BEHAVIOR_ID,
  PRIORITY_CLASSES,
  NON_STARTABLE_STATES,
  getReadySet,
  selectNextTask,
  selectIndependentWork,
  detectDependencyCycle,
  buildCompensationPlan,
  checkpointPortfolio,
  resumeFromCheckpoint,
  evaluateDispatch,
  type PortfolioTask,
} from "../beh_portfolio_orchestration_26";

function task(overrides: Partial<PortfolioTask> & { id: string }): PortfolioTask {
  return {
    goal: overrides.id,
    priority: "background",
    state: "ready",
    dependsOn: [],
    requiresApproval: false,
    ...overrides,
  };
}

describe("beh_portfolio_orchestration_26 descriptor", () => {
  it("is an active behavior added at epoch 26", () => {
    expect(behPortfolioOrchestration26.id).toBe(BEHAVIOR_ID);
    expect(behPortfolioOrchestration26.status).toBe("active");
    expect(behPortfolioOrchestration26.added_epoch).toBe(26);
  });
});

describe("selects next work from get_ready_set, not ad hoc ordering", () => {
  it("registers concurrent goals and picks a runnable ready task", () => {
    const tasks = [
      task({ id: "a", state: "ready" }),
      task({ id: "b", state: "ready" }),
    ];
    const next = selectNextTask(tasks);
    expect(next).toBeDefined();
    expect(getReadySet(tasks).map((t) => t.id).sort()).toEqual(["a", "b"]);
  });
});

describe("never starts a blocked or waiting-approval task", () => {
  it("excludes blocked_on_dependency and waiting_approval from ready set", () => {
    const tasks = [
      task({ id: "blocked", state: "blocked_on_dependency" }),
      task({ id: "waiting", state: "waiting_approval", requiresApproval: true }),
      task({ id: "ok", state: "ready" }),
    ];
    const ready = getReadySet(tasks).map((t) => t.id);
    expect(ready).toEqual(["ok"]);
    expect(selectNextTask(tasks)?.id).toBe("ok");
    for (const s of ["blocked_on_dependency", "waiting_approval", "running", "done", "failed"]) {
      expect(NON_STARTABLE_STATES).toContain(s);
    }
  });

  it("does not treat a task with unsatisfied dependency as ready", () => {
    const tasks = [
      task({ id: "dep", state: "running" }),
      task({ id: "child", state: "ready", dependsOn: ["dep"] }),
    ];
    expect(getReadySet(tasks).map((t) => t.id)).toEqual([]);
  });
});

describe("priority classes and preemption", () => {
  it("interactive preempts background; background never preempts interactive", () => {
    expect(PRIORITY_CLASSES.interactive).toBeLessThan(PRIORITY_CLASSES.background);
    const tasks = [
      task({ id: "bg", priority: "background", state: "ready" }),
      task({ id: "ix", priority: "interactive", state: "ready" }),
    ];
    expect(selectNextTask(tasks)?.id).toBe("ix");
  });

  it("background work still runs when no interactive work is ready (no starvation)", () => {
    const tasks = [task({ id: "bg", priority: "background", state: "ready" })];
    expect(selectNextTask(tasks)?.id).toBe("bg");
  });
});

describe("switch to provably independent work while waiting", () => {
  it("picks an independent ready task and never advances the gated task", () => {
    const tasks = [
      task({ id: "gated", state: "waiting_approval", requiresApproval: true }),
      task({ id: "dependent", state: "ready", dependsOn: ["gated"] }),
      task({ id: "independent", state: "ready" }),
    ];
    const alt = selectIndependentWork(tasks, "gated");
    expect(alt?.id).toBe("independent");
    // The gated task is never selected as independent work.
    expect(alt?.id).not.toBe("gated");
    expect(alt?.id).not.toBe("dependent");
  });
});

describe("checkpoint + deterministic resume", () => {
  it("resumes the same ready set and dependency status", () => {
    const tasks = [
      task({ id: "root", state: "done" }),
      task({ id: "a", state: "ready", dependsOn: ["root"] }),
      task({ id: "b", state: "blocked_on_dependency", dependsOn: ["a"] }),
    ];
    const before = getReadySet(tasks).map((t) => t.id);
    const cp = checkpointPortfolio(tasks);
    const resumed = resumeFromCheckpoint(cp);
    expect(resumed.readySet.map((t) => t.id)).toEqual(before);
    expect(cp.readySetIds).toEqual(before);
  });

  it("resume never resurrects a stale approval token: fresh HITL still required", () => {
    const tasks = [
      task({ id: "approve_me", state: "ready", requiresApproval: true }),
    ];
    const cp = checkpointPortfolio(tasks);
    // Approval tokens are never part of the checkpoint payload.
    expect((cp as Record<string, unknown>).approvalTokens).toBeUndefined();
    const resumed = resumeFromCheckpoint(cp);
    expect(resumed.requiresFreshApproval).toContain("approve_me");
  });
});

describe("advisory compensation on partial failure (no auto rollback)", () => {
  it("surfaces an advisory plan and does not auto-execute", () => {
    const failed = task({
      id: "payment",
      state: "failed",
      committedSideEffects: [
        { id: "charge1", kind: "charge", irreversible: false },
        { id: "email1", kind: "email", irreversible: true },
      ],
    });
    const plan = buildCompensationPlan(failed);
    expect(plan.advisory).toBe(true);
    expect(plan.autoExecute).toBe(false);
    expect(plan.requiresUserReview).toBe(true);
    // reversible effect gets an idempotent step
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].forEffectId).toBe("charge1");
    expect(plan.steps[0].idempotencyCheck).toMatch(/already been compensated/i);
    // irreversible effect is surfaced, not undone
    expect(plan.irreversibleNotes.join(" ")).toMatch(/irreversible/i);
  });
});

describe("scheduling state never grants authority", () => {
  it("a ready/running task with met criteria still needs a fresh approval token", () => {
    const t = task({ id: "send", state: "running", requiresApproval: true });
    const noToken = evaluateDispatch(t, { successCriteriaMet: true });
    expect(noToken.allowed).toBe(false);
    expect(noToken.policy_blocked).toBe(true);
    expect(noToken.reason).toBe("fresh_hitl_approval_token_required");

    const withToken = evaluateDispatch(t, {
      successCriteriaMet: true,
      approvalToken: "tok-123",
    });
    expect(withToken.allowed).toBe(true);
  });

  it("lifecycle state never relaxes success-criteria validation", () => {
    const t = task({ id: "x", state: "running", requiresApproval: false });
    const d = evaluateDispatch(t, { successCriteriaMet: false });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("success_criteria_not_met");
  });
});

describe("non-interactive background HITL step => policy_blocked + redacted notice", () => {
  it("returns policy_blocked and emits a redacted notification", () => {
    const t = task({
      id: "bg_send",
      state: "running",
      requiresApproval: true,
      nonInteractive: true,
    });
    const d = evaluateDispatch(t, { successCriteriaMet: true });
    expect(d.allowed).toBe(false);
    expect(d.policy_blocked).toBe(true);
    expect(d.reason).toBe("hitl_required_in_non_interactive_context");
    expect(d.redactedNotification).toBeDefined();
    expect(d.redactedNotification).toMatch(/redacted/i);
    expect(d.redactedNotification).toMatch(/policy_blocked/);
  });
});

describe("deadlock / dependency cycle detection", () => {
  it("detects an unresolvable cycle rather than hanging", () => {
    const tasks = [
      task({ id: "a", state: "blocked_on_dependency", dependsOn: ["b"] }),
      task({ id: "b", state: "blocked_on_dependency", dependsOn: ["a"] }),
    ];
    const cycle = detectDependencyCycle(tasks);
    expect(cycle.sort()).toEqual(["a", "b"]);
  });

  it("reports no cycle for an acyclic portfolio", () => {
    const tasks = [
      task({ id: "root", state: "done" }),
      task({ id: "a", state: "ready", dependsOn: ["root"] }),
    ];
    expect(detectDependencyCycle(tasks)).toEqual([]);
  });
});

describe("compensation plan idempotency after resume", () => {
  it("re-running produces the same plan (no double-compensation)", () => {
    const failed = task({
      id: "pay",
      state: "failed",
      committedSideEffects: [{ id: "r1", kind: "refund", irreversible: false }],
    });
    const first = buildCompensationPlan(failed);
    const cp = checkpointPortfolio([failed]);
    const resumed = resumeFromCheckpoint(cp);
    const resumedFailed = resumed.tasks.find((t) => t.id === "pay")!;
    const second = buildCompensationPlan(resumedFailed);
    expect(second).toEqual(first);
    expect(second.steps[0].idempotencyCheck).toMatch(/already been compensated/i);
  });
});
