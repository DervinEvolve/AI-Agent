import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalArgsDigest,
  canonicalize,
  evaluateStall,
  IMMUTABLE_EXEMPT_TOOLS,
  interpretHookOutcome,
  isNoticeTooLong,
  MAX_NOTICE_BYTES,
  resolveExemptTools,
  runHook,
  type StallRecord,
} from "../hooks/types.js";
import {
  createStallState,
  observeStall,
  pushStallRecord,
} from "../hooks/stall_detector.js";
import {
  applyHooks,
  createHookRuntimeState,
  latestModelFacingNotice,
} from "../hooks/runtime_hooks.js";
import type { HookConfig, HookContext } from "../hooks/types.js";

function rec(
  seq: number,
  turn: number,
  tool: string,
  digest: string,
  extra: Partial<StallRecord> = {},
): StallRecord {
  return {
    seq,
    turn_index: turn,
    tool_name: tool,
    digest,
    ...extra,
  };
}

function ctx(partial: Partial<HookContext> = {}): HookContext {
  return {
    hook_point: "pre_dispatch",
    turn_index: 0,
    counters: {},
    ...partial,
  };
}

describe("canonicalArgsDigest", () => {
  it("sorts object keys and keeps array order", () => {
    const a = canonicalArgsDigest({ b: 1, a: [2, { z: 1, y: 2 }] });
    const b = canonicalArgsDigest({ a: [2, { y: 2, z: 1 }], b: 1 });
    const expected = createHash("sha256")
      .update(canonicalize({ b: 1, a: [2, { z: 1, y: 2 }] }), "utf8")
      .digest("hex");
    expect(a).toBe(b);
    expect(a).toBe(expected);
    expect(canonicalArgsDigest({ a: [1, 2] })).not.toBe(
      canonicalArgsDigest({ a: [2, 1] }),
    );
  });
});

describe("interpretHookOutcome", () => {
  it("fail-closes throw, malformed, and overrun at pre_dispatch and pre_finalize", () => {
    for (const point of ["pre_dispatch", "pre_finalize"] as const) {
      const thrown = interpretHookOutcome(point, undefined, true, 1, 50);
      expect(thrown.hook_error).toBe(true);
      expect(thrown.fail_closed).toBe(true);

      const malformed = interpretHookOutcome(
        point,
        { decision: "nope" },
        false,
        1,
        50,
      );
      expect(malformed.hook_error).toBe(true);
      expect(malformed.fail_closed).toBe(true);

      const overrun = interpretHookOutcome(
        point,
        { decision: "allow" },
        false,
        80,
        10,
      );
      expect(overrun.hook_error).toBe(true);
      expect(overrun.fail_closed).toBe(true);
    }
  });

  it("fail-opens throw and malformed at turn_start and post_result", () => {
    for (const point of ["turn_start", "post_result"] as const) {
      const thrown = interpretHookOutcome(point, undefined, true, 1, undefined);
      expect(thrown.hook_error).toBe(true);
      expect(thrown.fail_closed).toBe(false);
      const deny = interpretHookOutcome(
        point,
        { decision: "deny" },
        false,
        1,
        undefined,
      );
      expect(deny.hook_error).toBe(true);
      expect(deny.fail_closed).toBe(false);
    }
  });

  it("rejects notices over 400 bytes instead of truncating", () => {
    const big = "x".repeat(MAX_NOTICE_BYTES + 1);
    expect(isNoticeTooLong(big)).toBe(true);
    const result = interpretHookOutcome(
      "pre_dispatch",
      { decision: "notice", notice: big },
      false,
      1,
      undefined,
    );
    expect(result.hook_error).toBe(true);
    expect(result.notice_rejected).toBe(true);
    expect(result.notice).toBeUndefined();
    expect(result.fail_closed).toBe(true);
  });
});

describe("evaluateStall", () => {
  it("flags three identical dispatches once as a notice, not an abort", () => {
    const window = [
      rec(1, 1, "echo", "d"),
      rec(2, 2, "echo", "d"),
      rec(3, 3, "echo", "d"),
    ];
    const v = evaluateStall(window, { enabled: true }, null, {
      current_turn: 3,
    });
    expect(v.flagged).toBe(true);
    expect(v.notice).toBe(true);
    expect(v.abort).toBe(false);
    expect(v.rule).toBe("repeat");
    expect(v.watermark_index).toBe(4);
  });

  it("does not abort when the next dispatch differs", () => {
    const window = [
      rec(1, 1, "echo", "d"),
      rec(2, 2, "echo", "d"),
      rec(3, 3, "echo", "d"),
      rec(4, 4, "echo", "other"),
    ];
    const v = evaluateStall(window, { enabled: true }, 4, {
      watermark_rule: "repeat",
      notice_turn: 3,
      current_turn: 4,
    });
    expect(v.abort).toBe(false);
  });

  it("aborts on three further identical dispatches after the watermark within M", () => {
    const window = [
      rec(1, 1, "echo", "d"),
      rec(2, 2, "echo", "d"),
      rec(3, 3, "echo", "d"),
      rec(4, 4, "echo", "d"),
      rec(5, 5, "echo", "d"),
      rec(6, 6, "echo", "d"),
    ];
    const v = evaluateStall(window, { enabled: true, post_watermark_m: 3 }, 4, {
      watermark_rule: "repeat",
      notice_turn: 3,
      current_turn: 6,
    });
    expect(v.abort).toBe(true);
    expect(v.reason).toBe("stall_detected");
    expect(v.notice).toBe(false);
  });

  it("a match after M expired turns is a new notice, not an abort", () => {
    const window = [
      rec(1, 1, "echo", "d"),
      rec(2, 2, "echo", "d"),
      rec(3, 3, "echo", "d"),
      rec(10, 10, "echo", "d"),
      rec(11, 11, "echo", "d"),
      rec(12, 12, "echo", "d"),
    ];
    const v = evaluateStall(window, { enabled: true, post_watermark_m: 3 }, 4, {
      watermark_rule: "repeat",
      notice_turn: 3,
      current_turn: 12,
    });
    expect(v.abort).toBe(false);
    expect(v.notice).toBe(true);
    expect(v.watermark_index).toBe(13);
  });

  it("detects A,B,A,B oscillation and ignores distinct-argument streaks", () => {
    const osc = [
      rec(1, 1, "edit", "A"),
      rec(2, 2, "edit", "B"),
      rec(3, 3, "edit", "A"),
      rec(4, 4, "edit", "B"),
    ];
    const v = evaluateStall(osc, { enabled: true }, null, { current_turn: 4 });
    expect(v.flagged).toBe(true);
    expect(v.rule === "oscillation" || v.rule === "no_progress" || v.rule === "repeat").toBe(
      true,
    );
    const oscOnly = evaluateStall(
      osc.map((r, i) => ({ ...r, plan_status: "p" + i, successful_non_readonly: true })),
      { enabled: true, repeat_n: 99, no_progress_k: 99 },
      null,
      { current_turn: 4 },
    );
    expect(oscOnly.rule).toBe("oscillation");
    expect(oscOnly.notice).toBe(true);

    const distinct = [
      rec(1, 1, "edit", "A", { plan_status: "s" }),
      rec(2, 2, "edit", "B", { plan_status: "s" }),
      rec(3, 3, "edit", "C", { plan_status: "s" }),
      rec(4, 4, "edit", "D", { plan_status: "s" }),
      rec(5, 5, "edit", "E", { plan_status: "s" }),
    ];
    const np = evaluateStall(distinct, { enabled: true }, null, {
      current_turn: 5,
    });
    expect(np.rule).not.toBe("no_progress");
  });

  it("detects no-progress and resets on plan progress or a new digest", () => {
    const stalled = [1, 2, 3, 4, 5].map((t) =>
      rec(t, t, "search", "same", { plan_status: "open" }),
    );
    const v = evaluateStall(stalled, { enabled: true, repeat_n: 99 }, null, {
      current_turn: 5,
    });
    expect(v.flagged).toBe(true);
    expect(v.rule).toBe("no_progress");

    const progressed = stalled.map((r, i) =>
      i === 4 ? { ...r, plan_status: "advanced" } : r,
    );
    const reset = evaluateStall(
      progressed,
      { enabled: true, repeat_n: 99 },
      null,
      { current_turn: 5 },
    );
    expect(reset.flagged).toBe(false);
  });

  it("does not flag three identical recall polls and cannot un-exempt recall", () => {
    const window = [1, 2, 3].map((t) => rec(t, t, "recall", "q"));
    const v = evaluateStall(
      window,
      { enabled: true, exempt_tools: [] },
      null,
      { current_turn: 3 },
    );
    expect(v.flagged).toBe(false);

    const exempt = resolveExemptTools([]);
    for (const name of IMMUTABLE_EXEMPT_TOOLS) {
      expect(exempt.has(name)).toBe(true);
    }
    const host = resolveExemptTools(["echo"]);
    expect(host.has("echo")).toBe(true);
    expect(host.has("recall")).toBe(true);
    expect(host.has("list_recalls")).toBe(true);

    const echoed = [1, 2, 3].map((t) => rec(t, t, "echo", "q"));
    const flagged = evaluateStall(echoed, { enabled: true }, null, {
      current_turn: 3,
      exempt: host,
    });
    expect(flagged.flagged).toBe(false);

    const notExempt = evaluateStall(echoed, { enabled: true }, null, {
      current_turn: 3,
    });
    expect(notExempt.flagged).toBe(true);
  });

  it("watermark survives a dropped window head because it is a sequence id", () => {
    const window = [
      rec(4, 4, "echo", "d"),
      rec(5, 5, "echo", "d"),
      rec(6, 6, "echo", "d"),
    ];
    const v = evaluateStall(window, { enabled: true }, 4, {
      watermark_rule: "repeat",
      notice_turn: 3,
      current_turn: 6,
    });
    expect(v.abort).toBe(true);
  });
});

describe("applyHooks", () => {
  it("pre_dispatch deny is recorded and does not mutate a copied result", () => {
    const config: HookConfig = {
      hooks: [
        {
          point: "pre_dispatch",
          fn: () => ({ decision: "deny", notice: "stop" }),
        },
      ],
    };
    const state = createHookRuntimeState(config);
    const toolResult = { status: "ok", output: "kept" };
    const before = JSON.stringify(toolResult);
    const applied = applyHooks(config, state, "pre_dispatch", ctx());
    expect(applied.denied).toBe(true);
    expect(JSON.stringify(toolResult)).toBe(before);
    expect(state.trace[0]?.decision).toBe("deny");
  });

  it("turn_start throw is hook_error and does not deny", () => {
    const config: HookConfig = {
      hooks: [
        {
          point: "turn_start",
          fn: () => {
            throw new Error("boom");
          },
        },
      ],
    };
    const state = createHookRuntimeState(config);
    const applied = applyHooks(
      config,
      state,
      "turn_start",
      ctx({ hook_point: "turn_start" }),
    );
    expect(applied.denied).toBe(false);
    expect(state.trace[0]?.hook_error).toBe(true);
    expect(state.hook_errors).toBe(1);
  });

  it("pre_finalize notice is not model-facing; only the latest other notice is", () => {
    const config: HookConfig = {
      hooks: [
        {
          point: "post_result",
          fn: () => ({ decision: "notice", notice: "first" }),
        },
        {
          point: "post_result",
          fn: () => ({ decision: "notice", notice: "second" }),
        },
        {
          point: "pre_finalize",
          fn: () => ({ decision: "notice", notice: "final-meta" }),
        },
      ],
    };
    const state = createHookRuntimeState(config);
    applyHooks(config, state, "post_result", ctx({ hook_point: "post_result" }));
    applyHooks(
      config,
      state,
      "pre_finalize",
      ctx({ hook_point: "pre_finalize" }),
    );
    expect(latestModelFacingNotice(state)).toBe("second");
    const fin = state.notices.find((n) => n.point === "pre_finalize");
    expect(fin?.model_facing).toBe(false);
    expect(fin?.text).toBe("final-meta");
  });

  it("runHook deny at pre_dispatch is not fail-open", () => {
    const result = runHook(
      "pre_dispatch",
      () => ({ decision: "deny" }),
      ctx(),
    );
    expect(result.decision).toBe("deny");
    expect(result.hook_error).toBe(false);
  });
});

describe("observeStall integration", () => {
  it("injects one notice then aborts only on post-watermark repeats within M", () => {
    const state = createStallState();
    const config = { enabled: true, repeat_n: 3, post_watermark_m: 3 };
    for (let t = 1; t <= 3; t++) {
      pushStallRecord(state, {
        turn_index: t,
        tool_name: "echo",
        digest: "d",
      });
    }
    const first = observeStall(state, config, 3);
    expect(first.notice).toBe(true);
    expect(first.abort).toBe(false);
    expect(state.watermark_seq).toBe(4);

    pushStallRecord(state, {
      turn_index: 4,
      tool_name: "echo",
      digest: "other",
    });
    const different = observeStall(state, config, 4);
    expect(different.abort).toBe(false);

    const state2 = createStallState();
    for (let t = 1; t <= 3; t++) {
      pushStallRecord(state2, {
        turn_index: t,
        tool_name: "echo",
        digest: "d",
      });
    }
    observeStall(state2, config, 3);
    for (let t = 4; t <= 6; t++) {
      pushStallRecord(state2, {
        turn_index: t,
        tool_name: "echo",
        digest: "d",
      });
    }
    const abort = observeStall(state2, config, 6);
    expect(abort.abort).toBe(true);
    expect(abort.reason).toBe("stall_detected");
  });
});
