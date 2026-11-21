import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  DurableRunSession,
  DurableRunsError,
  canonicalize,
  digestOf,
  durableRunsInactive,
  inspectDirectoryFsyncSupport,
  kernelLockAvailable,
  parseDurableRunsOption,
  productionMountAvailable,
  DURABLE_RUNS_MOUNT_ID,
  MAX_JOURNAL_RECORDS,
} from "../durable_runs_mount.ts";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "durable-runs-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

function manifestInput(deadline = 10_000) {
  return {
    taskDigest: digestOf("task"),
    contractDigest: digestOf({ contract: true }),
    verifierIdentity: "verifier-1",
    toolNames: ["echo"],
    toolSchemaDigest: digestOf({ echo: { type: "object" } }),
    implementationIdentities: { echo: "impl-echo-1" },
    resourceIdentities: { workspace: "ws-1" },
    budgetCaps: {
      absoluteDeadlineMs: deadline,
      maxSteps: 8,
      maxTurns: 8,
      maxClarifications: 2,
      usageCap: 100,
    },
    mountConfigDigest: digestOf({ mount: DURABLE_RUNS_MOUNT_ID }),
  };
}

function option(root: string, extra: Record<string, unknown> = {}) {
  return {
    enabled: true,
    principalId: "principalA",
    store: { root, principalId: "principalA" },
    maxStoreBytes: 1 * 1024 * 1024,
    ...extra,
  };
}

describe("durable runs mount", () => {
  it("does not claim node:fs kernel locks", () => {
    expect(kernelLockAvailable()).toBe(false);
    expect(DURABLE_RUNS_MOUNT_ID).toBe("cap_durable_runs_mount_41");
    expect(MAX_JOURNAL_RECORDS).toBe(8192);
  });

  it("absent and disabled configuration writes nothing", () => {
    expect(durableRunsInactive(undefined)).toBe(true);
    expect(durableRunsInactive(null)).toBe(true);
    const root = scratch();
    expect(durableRunsInactive({ enabled: false, principalId: "p", store: { root, principalId: "p" } })).toBe(true);
    expect(existsSync(join(root, "p"))).toBe(false);
  });

  it("rejects unknown keys and malformed config", () => {
    expect(() => parseDurableRunsOption({ enabled: true, extra: 1 })).toThrow(DurableRunsError);
    expect(() => parseDurableRunsOption({ enabled: "yes" })).toThrow(DurableRunsError);
    expect(() =>
      parseDurableRunsOption({
        enabled: true,
        principalId: "p",
        store: { root: "/tmp", principalId: "p", leak: true },
      }),
    ).toThrow(DurableRunsError);
  });

  it("creates a journal and refuses a second live owner", () => {
    const root = scratch();
    const session = DurableRunSession.open({
      option: option(root, { runId: "run1" }),
      manifestInput: manifestInput(),
      nowMs: 1_000,
      requireDirectoryFsync: false,
    });
    expect(session.snapshot.generation).toBe(1);
    expect(session.snapshot.ownershipEnforced).toBe(true);
    expect(() =>
      DurableRunSession.open({
        option: option(root, { runId: "run1", resume: true }),
        manifestInput: manifestInput(),
        nowMs: 2_000,
        requireDirectoryFsync: false,
      }),
    ).toThrow(/leftover/);
  });

  it("reserves dispatch then settles without replay of completed calls", () => {
    const root = scratch();
    const session = DurableRunSession.open({
      option: option(root, { runId: "run2" }),
      manifestInput: manifestInput(),
      nowMs: 100,
      requireDirectoryFsync: false,
    });
    const begun = session.beginDispatch({
      generation: 1,
      callId: "call_1",
      toolName: "echo",
      toolArguments: { text: "hi" },
      idempotent: false,
      nowMs: 150,
    });
    expect(begun).toEqual({ started: true, argumentsDigest: digestOf({ text: "hi" }) });
    const settled = session.settleDispatch({
      generation: 1,
      callId: "call_1",
      toolName: "echo",
      result: { ok: true },
      status: "ok",
      transition: { name: "observe" },
      nowMs: 160,
    });
    expect(settled.started).toBe(true);
    expect(settled.settled).toBe(true);
    expect(session.snapshot.state.observations).toHaveLength(1);
    expect(session.snapshot.state.admissions.steps).toBe(1);
  });

  it("refuses stale generations", () => {
    const root = scratch();
    const session = DurableRunSession.open({
      option: option(root, { runId: "run3" }),
      manifestInput: manifestInput(),
      nowMs: 100,
      requireDirectoryFsync: false,
    });
    expect(() => session.assertWritableGeneration(0)).toThrow(/stale/);
  });

  it("fails closed on a torn journal tail", () => {
    const root = scratch();
    const session = DurableRunSession.open({
      option: option(root, { runId: "run4" }),
      manifestInput: manifestInput(),
      nowMs: 100,
      requireDirectoryFsync: false,
    });
    session.close();
    const journal = join(root, "principalA", "run4", "journal.jsonl");
    writeFileSync(journal, readFileSync(journal).toString("utf8") + "{\"torn\": ");
    expect(() =>
      DurableRunSession.open({
        option: option(root, { runId: "run4", resume: true }),
        manifestInput: manifestInput(),
        nowMs: 200,
        attestation: {
          runId: "run4",
          principalId: "principalA",
          priorGeneration: 1,
          priorOwnerCeased: true,
          supervisorId: "sup",
          attestationToken: "token-ok-1",
        },
        requireDirectoryFsync: false,
      }),
    ).toThrow(/torn/);
  });

  it("supervised takeover increments generation and concurrent takeover cannot both succeed", () => {
    const root = scratch();
    const first = DurableRunSession.open({
      option: option(root, { runId: "run5" }),
      manifestInput: manifestInput(),
      nowMs: 100,
      requireDirectoryFsync: false,
    });
    first.close();
    const att = {
      runId: "run5",
      principalId: "principalA",
      priorGeneration: 1,
      priorOwnerCeased: true as const,
      supervisorId: "sup",
      attestationToken: "token-ok-2",
    };
    const second = DurableRunSession.open({
      option: option(root, { runId: "run5", resume: true }),
      manifestInput: manifestInput(),
      nowMs: 300,
      attestation: att,
      requireDirectoryFsync: false,
    });
    expect(second.snapshot.generation).toBe(2);
    expect(() => second.assertWritableGeneration(1)).toThrow(/stale/);
    expect(() =>
      DurableRunSession.open({
        option: option(root, { runId: "run5", resume: true }),
        manifestInput: manifestInput(),
        nowMs: 400,
        attestation: { ...att, priorGeneration: 1 },
        requireDirectoryFsync: false,
      }),
    ).toThrow(DurableRunsError);
  });

  it("does not extend deadline without a committed suspension and blocks expired dispatch", () => {
    const root = scratch();
    const session = DurableRunSession.open({
      option: option(root, { runId: "run6" }),
      manifestInput: manifestInput(500),
      nowMs: 100,
      requireDirectoryFsync: false,
    });
    const blocked = session.beginDispatch({
      generation: 1,
      callId: "call_9",
      toolName: "echo",
      toolArguments: { text: "x" },
      idempotent: true,
      nowMs: 501,
    });
    expect(blocked).toEqual({ started: false, code: "deadline" });
    const inference = session.beginInference({
      generation: 1,
      inferenceId: "inf_1",
      nowMs: 501,
      usageCapActive: true,
    });
    expect(inference).toEqual({ admitted: false, code: "deadline" });
  });

  it("canonicalizes objects with sorted keys", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("reports directory fsync support without enabling production mount when unsupported", () => {
    const support = inspectDirectoryFsyncSupport();
    expect(typeof support.supported).toBe("boolean");
    expect(support.detail.length).toBeGreaterThan(0);
    expect(productionMountAvailable({ supported: false, detail: "no" }, true)).toBe(false);
    expect(productionMountAvailable({ supported: true, detail: "yes" }, false)).toBe(false);
    expect(productionMountAvailable({ supported: true, detail: "yes" }, true)).toBe(true);
  });

  it("rejects resume when task binding changes", () => {
    const root = scratch();
    const first = DurableRunSession.open({
      option: option(root, { runId: "run7" }),
      manifestInput: manifestInput(),
      nowMs: 100,
      requireDirectoryFsync: false,
    });
    first.close();
    const changed = manifestInput();
    changed.taskDigest = digestOf("other-task");
    expect(() =>
      DurableRunSession.open({
        option: option(root, { runId: "run7", resume: true }),
        manifestInput: changed,
        nowMs: 200,
        attestation: {
          runId: "run7",
          principalId: "principalA",
          priorGeneration: 1,
          priorOwnerCeased: true,
          supervisorId: "sup",
          attestationToken: "token-ok-3",
        },
        requireDirectoryFsync: false,
      }),
    ).toThrow(/taskDigest/);
  });

  it("marks interrupted descendants unknown after owner exit", () => {
    const root = scratch();
    const session = DurableRunSession.open({
      option: option(root, { runId: "run8" }),
      manifestInput: manifestInput(),
      nowMs: 100,
      requireDirectoryFsync: false,
    });
    session.markDescendantsUnknown({ generation: 1, callId: "call_d", toolName: "echo", nowMs: 120 });
    expect(session.classifyUnsettled().some((q) => q.reason === "descendant_unknown")).toBe(true);
    const notice = session.renderNotice();
    expect(notice.text).toContain("not authoritative");
    expect(notice.unresolved[0]?.status).toBe("unknown");
    expect(notice.argumentPreviews[0]?.untrusted).toBe(true);
  });
});
