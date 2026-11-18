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
  // Make persistence fail to exercise the lossy fallback path.
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
    const big = makeLines(2000); // ~14k chars
    const out = budgetObservation(big, { store, budget: 1000, toolName: "grep" });
    expect(out.offloaded).toBe(true);
    expect(out.handle).toBeDefined();
    expect(out.observation.length).toBeLessThanOrEqual(1000);
    // Head and tail preserved, snapped to line boundaries.
    expect(out.observation).toContain("line-0");
    expect(out.observation).toContain("line-1999");
    // Omitted middle is gone from the preview.
    expect(out.observation).not.toContain("line-1000");
    // Marker records the handle and totals.
    expect(out.observation).toContain(`handle=${out.handle}`);
    expect(out.totalChars).toBe(big.length);
    expect(out.totalLines).toBe(2000);
    // Full output retrievable from the store.
    expect(store.get(out.handle!)?.content).toBe(big);
  });

  it("uses the default budget when none is given", () => {
    const store = new ObservationStore();
    const out = budgetObservation("x".repeat(DEFAULT_OBSERVATION_BUDGET_CHARS + 1), {
      store,
    });
    expect(out.offloaded).toBe(true);
    expect(out.observation.length).toBeLessThanOrEqual(
      DEFAULT_OBSERVATION_BUDGET_CHARS
    );
  });

  it("exempts error results from budgeting", () => {
    const store = new ObservationStore();
    const err = "Error: " + "x".repeat(5000);
    const out = budgetObservation(err, { store, budget: 100, isError: true });
    expect(out.offloaded).toBe(false);
    expect(out.observation).toBe(err);
  });

  it("exempts the read_offloaded tool's own output", () => {
    const store = new ObservationStore();
    const out = budgetObservation("x".repeat(5000), {
      store,
      budget: 100,
      toolName: "read_offloaded",
    });
    expect(out.offloaded).toBe(false);
  });

  it("falls back to lossy truncation when persistence fails", () => {
    const store = failingStore();
    const big = makeLines(1000);
    const out = budgetObservation(big, { store, budget: 500 });
    expect(out.offloaded).toBe(false);
    expect(out.lossyFallback).toBe(true);
    expect(out.handle).toBeUndefined();
    expect(out.observation).toContain("persistence failed");
    expect(out.observation.length).toBeLessThanOrEqual(500);
  });
});

describe("handle security contract", () => {
  it("issues unguessable, unenumerable handles (128-bit, unique)", () => {
    const store = new ObservationStore();
    const handles = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const h = store.put(`payload-${i}`);
      expect(h).toMatch(/^[0-9a-f]{32}$/);
      handles.add(h);
    }
    expect(handles.size).toBe(200);
  });

  it("rejects unknown handles without leaking content", () => {
    const store = new ObservationStore();
    store.put("secret-content");
    const res = readOffloaded(store, { handle: "deadbeef".repeat(4) });
    expect(res.ok).toBe(false);
  });
});

describe("readOffloaded", () => {
  it("pages through the full output with offsets", () => {
    const store = new ObservationStore();
    const handle = store.put(makeLines(1200));
    let offset = 0;
    const collected: string[] = []
    let pages = 0;
    while (true) {
      const res = readOffloaded(store, { handle, offset });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("unreachable");
      collected.push(...res.page.lines);
      pages++;
      if (!res.page.hasMore) break;
      offset = res.page.nextOffset;
      expect(pages).toBeLessThan(10);
    }
    expect(collected.length).toBe(1200);
    expect(collected[0]).toBe("line-0");
    expect(collected[1199]).toBe("line-1199");
  });

  it("hard-caps reads at 500 lines per call", () => {
    const store = new ObservationStore();
    const handle = store.put(makeLines(5000));
    const res = readOffloaded(store, { handle, limit: 100000 });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.page.lines.length).toBeLessThanOrEqual(READ_OFFLOADED_MAX_LINES);
    expect(res.page.hasMore).toBe(true);
  });

  it("hard-caps reads at 50k chars per call", () => {
    const store = new ObservationStore();
    const longLines = Array.from({ length: 2000 }, () => "x".repeat(100));
    const handle = store.put(longLines.join("\n"));
    const res = readOffloaded(store, { handle });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    const chars = res.page.lines.join("\n").length;
    expect(chars).toBeLessThanOrEqual(READ_OFFLOADED_MAX_CHARS);
    expect(res.page.truncatedByCharCap).toBe(true);
    expect(res.page.hasMore).toBe(true);
    // Continuing from nextOffset makes progress.
    const res2 = readOffloaded(store, { handle, offset: res.page.nextOffset });
    expect(res2.ok).toBe(true);
  });

  it("supports pattern filtering and still makes progress", () => {
    const store = new ObservationStore();
    const lines = Array.from({ length: 100 }, (_, i) =>
      i % 10 === 3 ? `MATCH-${i}` : `noise-${i}`
    );
    const handle = store.put(lines.join("\n"));
    const res = readOffloaded(store, { handle, pattern: "MATCH-" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.page.lines.length).toBe(10);
    expect(res.page.lines.every((l) => l.includes("MATCH-"))).toBe(true);
    expect(res.page.hasMore).toBe(false);
  });
});

describe("insertRecallStep / processStepResult", () => {
  it("inserts a recall step after the overflowing step", () => {
    const store = new ObservationStore();
    const plan = [
      { tool: "grep", args: { q: "a" } },
      { tool: "summarize", args: {} },
    ];
    const res = processStepResult({
      result: makeLines(2000),
      toolName: "grep",
      plan,
      stepIndex: 0,
      store,
      budget: 1000,
    });
    expect(res.offloaded).toBe(true);
    expect(res.plan.length).toBe(3);
    const recall = res.plan[1];
    expect(recall.tool).toBe("read_offloaded");
    expect(recall.args.handle).toBe(res.handle);
    expect(recall.args.offset).toBeGreaterThan(0);
    expect(recall.args.limit).toBeLessThanOrEqual(READ_OFFLOADED_MAX_LINES);
    // Prior steps untouched.
    expect(res.plan[0]).toBe(plan[0]);
    expect(res.plan[2]).toBe(plan[1]);
  });

  it("is idempotent: no duplicate recall step for the same handle", () => {
    const store = new ObservationStore();
    const handle = store.put(makeLines(100));
    const plan = [
      { tool: "grep", args: {} },
      { tool: "read_offloaded", args: { handle, offset: 60, limit: 500 } },
      { tool: "summarize", args: {} },
    ];
    const revised = insertRecallStep(plan, handle, 0, { totalLines: 100 });
    expect(revised).toBe(plan); // unchanged, same reference
  });

  it("does not insert a recall step for non-overflowing results", () => {
    const store = new ObservationStore();
    const plan = [{ tool: "grep", args: {} }];
    const res = processStepResult({
      result: "tiny",
      toolName: "grep",
      plan,
      stepIndex: 0,
      store,
    });
    expect(res.offloaded).toBe(false);
    expect(res.plan).toBe(plan);
  });

  it("does not insert a recall step for error results", () => {
    const store = new ObservationStore();
    const plan = [{ tool: "grep", args: {} }];
    const res = processStepResult({
      result: "x".repeat(9999),
      toolName: "grep",
      plan,
      stepIndex: 0,
      store,
      isError: true,
    });
    expect(res.offloaded).toBe(false);
    expect(res.plan).toBe(plan);
  });

  it("does not insert a recall step when persistence fails", () => {
    const store = failingStore();
    const plan = [{ tool: "grep", args: {} }];
    const res = processStepResult({
      result: makeLines(2000),
      toolName: "grep",
      plan,
      stepIndex: 0,
      store,
      budget: 500,
    });
    expect(res.offloaded).toBe(false);
    expect(res.plan).toBe(plan);
  });

  it("recall step can actually retrieve the omitted tail", () => {
    const store = new ObservationStore();
    const big = makeLines(2000);
    const res = processStepResult({
      result: big,
      toolName: "grep",
      plan: [{ tool: "grep", args: {} }],
      stepIndex: 0,
      store,
      budget: 1000,
    });
    const recall = res.plan[1];
    const page = readOffloaded(store, recall.args as Record<string, unknown>);
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error("unreachable");
    // The page starts at or after the omitted region and is within caps.
    expect(page.page.offset).toBeGreaterThan(0);
    expect(page.page.lines.length).toBeLessThanOrEqual(READ_OFFLOADED_MAX_LINES);
    expect(page.page.lines[0]).toMatch(/^line-/);
  });
});
