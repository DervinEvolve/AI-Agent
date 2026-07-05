import { describe, it, expect } from "vitest";
import {
  PRIORITY_CLASSES,
  NON_STARTABLE_STATES,
  getReadySet,
  selectNextTask,
  type PortfolioTask,
  type TaskLifecycleState,
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

describe("priority class semantics (documented invariant)", () => {
  it("ranks interactive strictly above background (lower rank wins)", () => {
    // Documented: lower `rank` == higher scheduling precedence,
    // interactive preempts background.
    expect(PRIORITY_CLASSES.interactive).toBeLessThan(PRIORITY_CLASSES.background);
  });
});

describe("interactive preempts background for next work", () => {
  it("selects the interactive ready task over background ready tasks", () => {
    const tasks = [
      task({ id: "bg1", priority: "background", state: "ready" }),
      task({ id: "bg2", priority: "background", state: "ready" }),
      task({ id: "iact", priority: "interactive", state: "ready" }),
    ];
    const next = selectNextTask(tasks);
    expect(next).toBeDefined();
    // Interactive work must preempt background work; the only interactive
    // ready task is the one that should be chosen.
    expect(next?.id).toBe("iact");
    expect(next?.priority).toBe("interactive");
  });

  it("background work does not preempt an available interactive task", () => {
    const tasks = [
      task({ id: "iact", priority: "interactive", state: "ready" }),
      task({ id: "bg", priority: "background", state: "ready" }),
    ];
    // Both are startable, but the interactive one must never lose to background.
    expect(selectNextTask(tasks)?.priority).toBe("interactive");
  });
});

describe("ready set filtering honors NON_STARTABLE_STATES", () => {
  it("excludes every non-startable state from the ready set and from selection", () => {
    // Build one task per non-startable state plus a single genuinely-ready one.
    const nonStartable = NON_STARTABLE_STATES as readonly TaskLifecycleState[];
    const tasks: PortfolioTask[] = nonStartable.map((s, i) =>
      task({ id: `ns_${i}`, state: s, requiresApproval: s === "waiting_approval" }),
    );
    tasks.push(task({ id: "runnable", state: "ready" }));

    const readyIds = getReadySet(tasks).map((t) => t.id);
    // None of the non-startable tasks may appear in the ready set.
    for (const s of nonStartable) {
      expect(readyIds).not.toContain(
        tasks.find((t) => t.state === s && t.id.startsWith("ns_"))?.id,
      );
    }
    // The only genuinely-ready task is the sole selection candidate.
    expect(readyIds).toContain("runnable");
    expect(selectNextTask(tasks)?.id).toBe("runnable");
  });

  it("returns no startable work when the portfolio is entirely non-startable", () => {
    const tasks: PortfolioTask[] = (NON_STARTABLE_STATES as readonly TaskLifecycleState[]).map(
      (s, i) => task({ id: `blocked_${i}`, state: s, requiresApproval: s === "waiting_approval" }),
    );
    expect(getReadySet(tasks)).toHaveLength(0);
    expect(selectNextTask(tasks)).toBeUndefined();
  });
});
