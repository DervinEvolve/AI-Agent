import { describe, it, expect } from "vitest";
import { PreMutationSnapshotStore } from "../premutation_snapshot.ts";

function makeFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    files,
    fs: {
      readFile: async (p: string) => {
        if (!files.has(p)) throw new Error("ENOENT");
        return files.get(p)!;
      },
      writeFile: async (p: string, c: string) => {
        files.set(p, c);
      },
      statMode: async () => null,
      exists: async (p: string) => files.has(p),
    },
  };
}

describe("PreMutationSnapshotStore multi-file intents", () => {
  it("reverts every file in the intent together (no half-migrated workspace)", async () => {
    const { fs, files } = makeFs({
      "a.ts": "const a = 1;\n",
      "b.ts": "const b = 2;\n",
    });
    const store = new PreMutationSnapshotStore(fs);

    await store.capture("intent-1", "a.ts");
    await store.capture("intent-1", "b.ts");

    // simulate failed repair attempts mutating both files
    files.set("a.ts", "const a = 1; const a = ");
    files.set("b.ts", "const b = 2; syntax error");

    const result = await store.revertIntent("intent-1");
    expect(result.reverted.sort()).toEqual(["a.ts", "b.ts"]);
    expect(files.get("a.ts")).toBe("const a = 1;\n");
    expect(files.get("b.ts")).toBe("const b = 2;\n");
  });

  it("snapshot-on-first-write is per (intent, path): second capture keeps the original baseline", async () => {
    const { fs, files } = makeFs({ "a.ts": "baseline" });
    const store = new PreMutationSnapshotStore(fs);

    const first = await store.capture("intent-1", "a.ts");
    expect(first.captured).toBe(true);

    // a repair attempt mutates the file, then the runtime tries to snapshot again
    files.set("a.ts", "mutated attempt");
    const second = await store.capture("intent-1", "a.ts");
    expect(second.captured).toBe(false);

    files.set("a.ts", "mutated attempt 2");
    await store.revertIntent("intent-1");
    // revert must land on the ORIGINAL baseline, not an intermediate mutation
    expect(files.get("a.ts")).toBe("baseline");
  });

  it("after a full revert the snapshots are discarded, so a second revert is a no-op", async () => {
    const { fs, files } = makeFs({ "a.ts": "base" });
    const store = new PreMutationSnapshotStore(fs);
    await store.capture("intent-1", "a.ts");
    files.set("a.ts", "mutated");

    const first = await store.revertIntent("intent-1");
    expect(first.reverted).toEqual(["a.ts"]);

    files.set("a.ts", "new work after revert");
    const second = await store.revertIntent("intent-1");
    expect(second.reverted).toEqual([]);
    // post-revert work is never clobbered by an idempotent no-op revert
    expect(files.get("a.ts")).toBe("new work after revert");
    expect(store.hasSnapshot("intent-1", "a.ts")).toBe(false);
  });

  it("revertFile is scoped per intent: another intent's snapshot is untouched", async () => {
    const { fs, files } = makeFs({ "a.ts": "base" });
    const store = new PreMutationSnapshotStore(fs);

    await store.capture("intent-A", "a.ts");
    files.set("a.ts", "mutated by A");

    // intent-B asks to revert a path it never snapshotted
    const revertedByB = await store.revertFile("intent-B", "a.ts");
    expect(revertedByB).toBe(false);
    expect(files.get("a.ts")).toBe("mutated by A");

    // intent-A can still revert its own snapshot
    const revertedByA = await store.revertFile("intent-A", "a.ts");
    expect(revertedByA).toBe(true);
    expect(files.get("a.ts")).toBe("base");
  });

  it("separate intents get independent snapshots of the same file", async () => {
    const { fs, files } = makeFs({ "a.ts": "v0" });
    const store = new PreMutationSnapshotStore(fs);

    await store.capture("intent-1", "a.ts");
    files.set("a.ts", "v1");
    await store.capture("intent-2", "a.ts");
    files.set("a.ts", "v2");

    // reverting intent-2 restores its own baseline (v1), not intent-1's (v0)
    await store.revertIntent("intent-2");
    expect(files.get("a.ts")).toBe("v1");

    // intent-1's snapshot is still live and restores v0
    expect(store.hasSnapshot("intent-1", "a.ts")).toBe(true);
    await store.revertIntent("intent-1");
    expect(files.get("a.ts")).toBe("v0");
  });
});
