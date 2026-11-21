import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DURABLE_RUNS_MOUNT_ID,
  DurableRunSession,
  DurableRunsError,
  digestOf,
  parseDurableRunsOption,
} from "../durable_runs_mount.ts";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "durable-deadline-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

function manifestInput(deadline = 5_000) {
  return {
    taskDigest: digestOf("task-deadline"),
    contractDigest: digestOf({ contract: true }),
    verifierIdentity: "verifier-deadline",
    toolNames: ["echo"],
    toolSchemaDigest: digestOf({ echo: { type: "object" } }),
    implementationIdentities: { echo: "impl-echo-1" },
    resourceIdentities: { workspace: "ws-1" },
    budgetCaps: {
      absoluteDeadlineMs: deadline,
      maxSteps: 4,
      maxTurns: 4,
      maxClarifications: 2,
      usageCap: 50,
    },
    mountConfigDigest: digestOf({ mount: DURABLE_RUNS_MOUNT_ID }),
  };
}

function option(root: string) {
  return parseDurableRunsOption({
    enabled: true,
    principalId: "principalA",
    store: { root, principalId: "principalA" },
    maxStoreBytes: 1 * 1024 * 1024,
    requireDirectoryFsync: false,
  });
}

describe("deadline consumption and crash resume", () => {
  it("consumes running and crash downtime against the original deadline and never resets it", () => {
    const root = scratch();
    const startedAt = 1_000_000;
    const first = DurableRunSession.create({
      option: option(root),
      manifest: manifestInput(5_000),
      now: startedAt,
      runId: "run-deadline-1",
    });
    first.beginExecution(startedAt + 100);
    const runId = first.runId;

    const beforeCrash = first.remainingDeadlineMs(startedAt + 1_100);
    expect(beforeCrash).toBe(4_000);

    first.simulateCrash();

    const resumed = DurableRunSession.resume({
      option: option(root),
      manifest: manifestInput(5_000),
      runId,
      now: startedAt + 3_100,
      supervisorAttestation: {
        runId,
        principalId: "principalA",
        previousGeneration: first.generation,
        attestation: "supervisor-ok",
      },
    });

    expect(resumed.generation).toBe(first.generation + 1);
    expect(resumed.remainingDeadlineMs(startedAt + 3_100)).toBe(2_000);
    expect(resumed.deadlineExpiresAt).toBe(startedAt + 5_000);

    expect(() =>
      resumed.reserveAdapterCall({
        now: startedAt + 5_000,
        usage: 1,
      }),
    ).toThrow(DurableRunsError);

    resumed.close();
  });

  it("does not replay a settled dispatch and blocks an unsettled intent", () => {
    const root = scratch();
    const now = 2_000_000;
    const session = DurableRunSession.create({
      option: option(root),
      manifest: manifestInput(20_000),
      now,
      runId: "run-replay-1",
    });
    session.beginExecution(now);

    const callId = session.allocateCallId();
    session.publishDispatchIntent({
      callId,
      toolName: "echo",
      arguments: { text: "once" },
      idempotent: false,
      now,
    });
    session.settleDispatch({
      callId,
      result: { ok: true, output: "once" },
      now: now + 10,
    });

    const openId = session.allocateCallId();
    session.publishDispatchIntent({
      callId: openId,
      toolName: "echo",
      arguments: { text: "open" },
      idempotent: false,
      now: now + 20,
    });
    session.simulateCrash();

    const resumed = DurableRunSession.resume({
      option: option(root),
      manifest: manifestInput(20_000),
      runId: session.runId,
      now: now + 50,
      supervisorAttestation: {
        runId: session.runId,
        principalId: "principalA",
        previousGeneration: session.generation,
        attestation: "supervisor-ok",
      },
    });

    const replay = resumed.replayExternalEffects();
    expect(replay.redispatchedCallIds).toEqual([]);
    expect(replay.completedCallIds).toContain(callId);
    expect(replay.unknownCallIds).toContain(openId);
    expect(resumed.resourceQuarantined("echo")).toBe(true);
    expect(resumed.nextCallId()).not.toBe(callId);
    expect(resumed.nextCallId()).not.toBe(openId);

    expect(() =>
      resumed.publishDispatchIntent({
        callId: openId,
        toolName: "echo",
        arguments: { text: "again" },
        idempotent: false,
        now: now + 60,
      }),
    ).toThrow(DurableRunsError);

    resumed.close();
  });
});
