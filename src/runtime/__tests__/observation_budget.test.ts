import { describe, it, expect } from "vitest";

import {
  ObservationStore,
  budgetObservation,
  insertRecallStep,
  processStepResult,
  readOffloaded,
  READ_OFFLOADED_MAX_LINES,
  READ_OFFLOADED_MAX_CHARS,
  DEFAULT_OBSERVATION_BUDGET_CHARS,
} from "../observation_budget";

function makeLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line-${i}`).join("\n");
}

function failingStore(): ObservationStore {
  const store = new ObservationStore();
  (store as unknown as { put: () => string }).put = () => {
    throw new Error("disk full");
  };
  return store;
}

describe("budgetObservation", () => {
  it("passes through small outputs unchanged", () => {
    const store = new ObservationStore();
    const out = budgetObservation("short", { store, budget: 100 });
    expect(out.observation).toBe("short");
    expect(out.offloaded).toBe(false);
    expect(store.size).toBe(0);
  });

  it("offloads oversized output with a head+tail preview under budget", () => {
    const store = new ObservationStore();
    const big = makeLines(2000);
    const out = budgetObservation(big, { store, budget: 1000, toolName: "grep" });
    expect(out.offloaded).toBe(true);
    expect(out.handle).toBeDefined();
    expect(out.observation.length).toBeLessThanOrEqual(1000);
    expect(out.observation).toContain("line-0");
    expect(out.observation).toContain("line-1999");
    expect(out.observation).not.toContain("line-1000");
    expect(out.observation).toContain(`handle=${out.handle}`);
    expect(out.totalChars).toBe(big.length);
    expect(out.totalLines).toBe(2000);
    expect(store.get(out.handle!)?.content).toBe(big);
  });

  it("uses the default budget when none is given", () => {
    const store = new ObservationStore();
    const big = "x".repeat(DEFAULT_OBSERVATION_BUDGET_CHARS + 1);
    const out = budgetObservation(big, { store });
    expect(out.offloaded).toBe(true);
    expect(out.observation.length).toBeLessThanOrEqual(
      DEFAULT_OBSERVATION_BUDGET_CHARS,
    );
  });

  it("falls back to lossy truncation when the store write fails", () => {
    const store = failingStore();
    const big = makeLines(2000);
    const out = budgetObservation(big, { store, budget: 1000 });
    expect(out.offloaded).toBe(false);
    expect(out.handle).toBeUndefined();
    expect(out.observation.length).toBeLessThanOrEqual(1000);
    expect(out.observation).toContain("line-0");
    expect(out.observation).toContain("line-1999");
  });
});

describe("insertRecallStep", () => {
  it("inserts a read_offloaded step referencing the handle", () => {
    const store = new ObservationStore();
    const out = budgetObservation(makeLines(2000), { store, budget: 1000 });
    const plan = [{ tool: "grep", args: { q: "x" } }];
    const revised = insertRecallStep(plan, out.handle!, out.totalLines);
    expect(revised).not.toBe(plan);
    expect(revised.length).toBe(2);
    const recall = revised[1];
    expect(recall.tool).toBe("read_offloaded");
    expect(recall.args.handle).toBe(out.handle);
  });

  it("is idempotent — no duplicate recall step for the same handle", () => {
    const store = new ObservationStore();
    const out = budgetObservation(makeLines(2000), { store, budget: 1000 });
    const plan = [{ tool: "grep", args: { q: "x" } }];
    const once = insertRecallStep(plan, out.handle!, out.totalLines);
    const twice = insertRecallStep(once, out.handle!, out.totalLines);
    expect(twice).toEqual(once);
  });
});

describe("readOffloaded", () => {
  it("pages back the omitted tail within hard caps", () => {
    const store = new ObservationStore();
    const big = makeLines(2000);
    const out = budgetObservation(big, { store, budget: 1000 });
    const page = readOffloaded(store, out.handle!, { offsetLine: 1500 });
    expect(page.totalLines).toBe(2000);
    expect(page.lines.length).toBeGreaterThan(0);
    expect(page.lines.length).toBeLessThanOrEqual(READ_OFFLOADED_MAX_LINES);
    expect(page.content.length).toBeLessThanOrEqual(READ_OFFLOADED_MAX_CHARS);
    expect(page.lines).toContain("line-1999");
  });

  it("returns the full content when it fits within the caps", () => {
    const store = new ObservationStore();
    const content = makeLines(100);
    const handle = store.put(content);
    const page = readOffloaded(store, handle, {});
    expect(page.lines.length).toBe(100);
    expect(page.lines[0]).toBe("line-0");
    expect(page.lines[99]).toBe("line-99");
  });

  it("throws or errors for an unknown handle", () => {
    const store = new ObservationStore();
    expect(() => readOffloaded(store, "deadbeef", {})).toThrow();
  });
});

describe("processStepResult (end-to-end budget + recall)", () => {
  it("truncates, offloads, and inserts a recall step for oversized output", () => {
    const store = new ObservationStore();
    const plan = [
      { tool: "grep", args: { q: "needle" } },
      { tool: "finish", args: {} },
    ];
    const big = makeLines(3000);
    const result = processStepResult(big, {
      store,
      budget: 1000,
      plan,
      toolName: "grep",
    });
    expect(result.observation.length).toBeLessThanOrEqual(1000);
    expect(result.handle).toBeDefined();
    expect(store.get(result.handle!)?.content).toBe(big);
    expect(result.plan.length).toBe(3);
    const recall = result.plan[2];
    expect(recall.tool).toBe("read_offloaded");
    expect(recall.args.handle).toBe(result.handle);
    // The recall must actually be able to retrieve the tail.
    const page = readOffloaded(store, result.handle!, {
      offsetLine: result.totalLines - 100,
    });
    expect(page.lines).toContain("line-2999");
  });

  it("leaves the plan and observation untouched when under budget", () => {
    const store = new ObservationStore();
    const plan = [{ tool: "finish", args: {} }];
    const result = processStepResult("tiny", {
      store,
      budget: 1000,
      plan,
      toolName: "grep",
    });
    expect(result.observation).toBe("tiny");
    expect(result.plan).toBe(plan);
    expect(result.plan.length).toBe(1);
  });

  it("does not insert a recall step when the store write fails", () => {
    const store = failingStore();
    const plan = [{ tool: "finish", args: {} }];
    const result = processStepResult(makeLines(2000), {
      store,
      budget: 1000,
      plan,
      toolName: "grep",
    });
    expect(result.handle).toBeUndefined();
    expect(result.plan.length).toBe(1);
  });

  it("exempts read_offloaded's own output from budgeting (no recall loops)", () => {
    const store = new ObservationStore();
    const plan = [{ tool: "finish", args: {} }];
    const big = "x".repeat(5000);
    const result = processStepResult(big, {
      store,
      budget: 1000,
      plan,
      toolName: "read_offloaded",
    });
    expect(result.offloaded).toBe(false);
    expect(result.observation).toBe(big);
    expect(result.plan.length).toBe(1);
  });
});
