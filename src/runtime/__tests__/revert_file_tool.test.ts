import { describe, it, expect } from "vitest";
import { PreMutationSnapshotStore } from "../premutation_snapshot.ts";
import { createRevertFileTool, autoRevertExhaustedIntent } from "../revert_file_tool.ts";

function makeFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    files,
    fs: {
      readFile: async (p: string) => files.get(p)!,
      writeFile: async (p: string, c: string) => {
        files.set(p, c);
      },
      statMode: async () => null,
      exists: async (p: string) => files.has(p),
    },
  };
}

describe("revert_file tool", () => {
  it("is registered with the expected name and schema", () => {
    const { fs } = makeFs();
    const tool = createRevertFileTool(new PreMutationSnapshotStore(fs));
    expect(tool.name).toBe("revert_file");
    expect(tool.parameters.required).toEqual(["path"]);
    expect(tool.parameters.properties.path.type).toBe("string");
  });

  it("voluntarily reverts a snapshotted file in the caller's intent", async () => {
    const { fs, files } = makeFs({ "a.ts": "base" });
    const store = new PreMutationSnapshotStore(fs);
    const tool = createRevertFileTool(store);
    await store.capture("intent-1", "a.ts");
    files.set("a.ts", "mutated");
    const res = await tool.execute({ path: "a.ts" }, { intentId: "intent-1" });
    expect(res.reverted).toBe(true);
    expect(files.get("a.ts")).toBe("base");
  });

  it("is idempotent: no snapshot -> success no-op", async () => {
    const { fs, files } = makeFs({ "a.ts": "committed" });
    const store = new PreMutationSnapshotStore(fs);
    const tool = createRevertFileTool(store);
    const res = await tool.execute({ path: "a.ts" }, { intentId: "intent-x" });
    expect(res.reverted).toBe(false);
    expect(files.get("a.ts")).toBe("committed");
  });

  it("cannot revert another intent's snapshot", async () => {
    const { fs, files } = makeFs({ "a.ts": "base" });
    const store = new PreMutationSnapshotStore(fs);
    const tool = createRevertFileTool(store);
    await store.capture("intent-1", "a.ts");
    files.set("a.ts", "mutated");
    const res = await tool.execute({ path: "a.ts" }, { intentId: "intent-2" });
    expect(res.reverted).toBe(false);
    expect(files.get("a.ts")).toBe("mutated");
  });

  it("rejects a missing path without throwing", async () => {
    const { fs } = makeFs();
    const tool = createRevertFileTool(new PreMutationSnapshotStore(fs));
    const res = await tool.execute({} as { path: string }, { intentId: "i" });
    expect(res.reverted).toBe(false);
    expect(res.message).toContain("missing path");
  });
});

describe("autoRevertExhaustedIntent", () => {
  it("reverts the intent and returns a structured context note", async () => {
    const { fs, files } = makeFs({ "a.ts": "base" });
    const store = new PreMutationSnapshotStore(fs);
    await store.capture("intent-1", "a.ts");
    files.set("a.ts", "broken");
    store.recordAttempt("intent-1", "parse error");
    store.recordAttempt("intent-1", "still parse error");
    const { note } = await autoRevertExhaustedIntent(store, "intent-1");
    expect(note).toBeTruthy();
    expect(note).toContain("FAILED AND REVERTED");
    expect(note).toContain("Attempts: 2");
    expect(note).toContain("still parse error");
    expect(note).toContain("UNCHANGED");
    expect(files.get("a.ts")).toBe("base");
  });

  it("returns null note when there was nothing to revert", async () => {
    const { fs } = makeFs();
    const store = new PreMutationSnapshotStore(fs);
    const { note } = await autoRevertExhaustedIntent(store, "intent-none");
    expect(note).toBe(null);
  });
});
