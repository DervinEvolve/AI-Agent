import { describe, it, expect } from "vitest";
import { PreMutationSnapshotStore, renderRevertNote } from "../premutation_snapshot.ts";

function makeFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const modes = new Map<string, number>();
  const writes: Array<{ path: string; content: string; mode: number | null }> = [];
  return {
    files,
    writes,
    fs: {
      readFile: async (p: string) => {
        if (!files.has(p)) throw new Error("ENOENT");
        return files.get(p)!;
      },
      writeFile: async (p: string, c: string, mode?: number | null) => {
        files.set(p, c);
        if (mode != null) modes.set(p, mode);
        writes.push({ path: p, content: c, mode: mode ?? null });
      },
      statMode: async (p: string) => modes.get(p) ?? null,
      exists: async (p: string) => files.has(p),
    },
  };
}

describe("PreMutationSnapshotStore", () => {
  it("captures on first write only (snapshot-on-first-write)", async () => {
    const { fs } = makeFs({ "a.ts": "original" });
    const store = new PreMutationSnapshotStore(fs);
    const first = await store.capture("intent-1", "a.ts");
    expect(first.captured).toBe(true);
    const second = await store.capture("intent-1", "a.ts");
    expect(second.captured).toBe(false);
    expect(store.hasSnapshot("intent-1", "a.ts")).toBe(true);
  });

  it("restores byte-for-byte and preserves mode", async () => {
    const { fs, writes } = makeFs({ "a.ts": "let x = 1;\n" });
    const store = new PreMutationSnapshotStore(fs);
    await store.capture("intent-1", "a.ts");
    await fs.writeFile("a.ts", "let x = 2 broken", 0o644);
    const reverted = await store.revertIntent("intent-1");
    expect(reverted.reverted).toEqual(["a.ts"]);
    expect(await fs.readFile("a.ts")).toBe("let x = 1;\n");
    expect(writes[writes.length - 1].mode).toBe(null); // captured mode was null
  });

  it("revert is idempotent: second revert is a no-op", async () => {
    const { fs } = makeFs({ "a.ts": "base" });
    const store = new PreMutationSnapshotStore(fs);
    await store.capture("i", "a.ts");
    await fs.writeFile("a.ts", "mutated");
    expect(await store.revertFile("i", "a.ts")).toBe(true);
    expect(await fs.readFile("a.ts")).toBe("base");
    expect(await store.revertFile("i", "a.ts")).toBe(false);
    expect(await fs.readFile("a.ts")).toBe("base");
  });

  it("never deletes files created after the snapshot (overwrite-only)", async () => {
    const { fs } = makeFs({ "a.ts": "base" });
    const store = new PreMutationSnapshotStore(fs);
    await store.capture("i", "a.ts");
    await fs.writeFile("new-file.ts", "created during intent");
    const result = await store.revertIntent("i");
    expect(result.reverted).toEqual(["a.ts"]);
    expect(await fs.exists("new-file.ts")).toBe(true);
  });

  it("handles snapshot of a non-existent file: revert skips it", async () => {
    const { fs } = makeFs();
    const store = new PreMutationSnapshotStore(fs);
    await store.capture("i", "created.ts");
    await fs.writeFile("created.ts", "content");
    const result = await store.revertIntent("i");
    expect(result.reverted).toEqual([]);
    expect(result.skippedNonExistent).toEqual(["created.ts"]);
    expect(await fs.exists("created.ts")).toBe(true);
  });

  it("multi-file intents revert all-or-nothing", async () => {
    const { fs } = makeFs({ "a.ts": "A", "b.ts": "B" });
    const store = new PreMutationSnapshotStore(fs);
    await store.capture("i", "a.ts");
    await store.capture("i", "b.ts");
    await fs.writeFile("a.ts", "A2");
    await fs.writeFile("b.ts", "B2");
    const result = await store.revertIntent("i");
    expect(result.reverted.sort()).toEqual(["a.ts", "b.ts"]);
    expect(await fs.readFile("a.ts")).toBe("A");
    expect(await fs.readFile("b.ts")).toBe("B");
    // After revert, no snapshots remain; further reverts are no-ops.
    expect(store.snapshotPaths("i")).toEqual([]);
  });

  it("discard on gate pass means committed edits are never reverted", async () => {
    const { fs } = makeFs({ "a.ts": "base" });
    const store = new PreMutationSnapshotStore(fs);
    await store.capture("i", "a.ts");
    await fs.writeFile("a.ts", "good edit");
    store.discard("i");
    expect(await store.revertFile("i", "a.ts")).toBe(false);
    expect(await fs.readFile("a.ts")).toBe("good edit");
  });

  it("contains capture failures: never breaks the tool call", async () => {
    const failingFs = {
      readFile: async () => {
        throw new Error("EACCES");
      },
      writeFile: async () => {},
      statMode: async () => null,
      exists: async () => true,
    };
    const store = new PreMutationSnapshotStore(failingFs);
    const res = await store.capture("i", "locked.ts");
    expect(res.ok).toBe(false);
    expect(store.hasSnapshot("i", "locked.ts")).toBe(false);
  });

  it("tracks attempts and last gate error for the revert note", async () => {
    const { fs } = makeFs({ "a.ts": "base" });
    const store = new PreMutationSnapshotStore(fs);
    await store.capture("i", "a.ts");
    store.recordAttempt("i", "SyntaxError: unexpected token");
    store.recordAttempt("i", "parse failed again");
    await store.revertIntent("i");
    const note = store.buildRevertNote("i")!;
    expect(note.attempts).toBe(2);
    expect(note.lastGateError).toBe("parse failed again");
    expect(note.revertedAtBaseline).toBe(true);
    const text = renderRevertNote(note);
    expect(text).toContain("UNCHANGED");
    expect(text).toContain("a.ts");
    expect(text).toContain("parse failed again");
  });

  it("does not re-snapshot after an intent was reverted", async () => {
    const { fs } = makeFs({ "a.ts": "base" });
    const store = new PreMutationSnapshotStore(fs);
    await store.capture("i", "a.ts");
    await store.revertIntent("i");
    const res = await store.capture("i", "a.ts");
    expect(res.captured).toBe(false);
    expect(store.isReverted("i")).toBe(true);
  });

  it("isolates intents: one intent's revert never touches another's files", async () => {
    const { fs } = makeFs({ "a.ts": "A", "b.ts": "B" });
    const store = new PreMutationSnapshotStore(fs);
    await store.capture("i1", "a.ts");
    await store.capture("i2", "b.ts");
    await fs.writeFile("a.ts", "A2");
    await fs.writeFile("b.ts", "B2");
    await store.revertIntent("i1");
    expect(await fs.readFile("a.ts")).toBe("A");
    expect(await fs.readFile("b.ts")).toBe("B2");
    expect(store.hasSnapshot("i2", "b.ts")).toBe(true);
  });
});
