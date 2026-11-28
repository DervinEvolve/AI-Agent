import { describe, expect, it } from "vitest";
import {
  STRUCTURED_CAPS,
  STRUCTURED_REASON,
  UNTRUSTED_FEEDBACK_LABEL,
  buildStructuredFeedback,
  defaultStructuredConfig,
  objectRootCompiler,
  outputContract,
  parseStrictAnswer,
  runStructuredEpisode,
  validateStructuredStartup,
  HeldCandidateSeam,
  type AdmissionBudgets,
  type DecodedReemit,
  type OutputRecord,
  type Reservation,
  type StructuredOutputConfig,
} from "../structured/types";

const admission: AdmissionBudgets = {
  step: 8,
  inferenceAttempt: 4,
  token: 1000,
  cost: 1,
  deadline: 60_000,
};

const schema = {
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
};

function config(enabled = true): StructuredOutputConfig {
  return defaultStructuredConfig(outputContract(schema), enabled);
}

function reserveOk(log: { releases: number; steps: number }): () => Reservation {
  return () => ({
    ok: true,
    attempts: 1,
    tokens: 100,
    cost: 0.01,
    steps: 0,
    release: () => {
      log.releases += 1;
    },
  });
}

function baseHooks(over: Partial<Parameters<typeof runStructuredEpisode>[0]> = {}) {
  const releases = { releases: 0, steps: 0 };
  const compiler = objectRootCompiler(["object"]);
  return {
    config: config(true),
    runId: "run-1",
    compiler,
    admission,
    measure: () => true,
    reserve: reserveOk(releases),
    firstDecode: () => ({ kind: "final_answer", text: '{"ok":true}' }) as DecodedReemit,
    reemit: () => ({ kind: "final_answer", text: '{"ok":true}' }) as DecodedReemit,
    _releases: releases,
    ...over,
  };
}

describe("cap_structured_output_80", () => {
  it("parseStrictAnswer rejects duplicate keys, trailing text, and non-utf8 without JSON.parse last-wins", () => {
    expect(parseStrictAnswer('{"a":1,"a":2}')).toEqual({ ok: false, code: "not_json" });
    expect(parseStrictAnswer('{"a":1,"\\u0061":2}')).toEqual({ ok: false, code: "not_json" });
    expect(parseStrictAnswer('{"a":1} trailing')).toEqual({ ok: false, code: "not_json" });
    expect(parseStrictAnswer('{"a":1}   ')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseStrictAnswer(new Uint8Array([0xff, 0xfe]))).toEqual({ ok: false, code: "not_json" });
    const nested = parseStrictAnswer('{"a":{"b":1,"b":2}}');
    expect(nested.ok).toBe(false);
  });

  it("holds, digests, releases, and drops a candidate", () => {
    const seam = new HeldCandidateSeam();
    expect(seam.digest()).toBeNull();
    seam.hold('{"ok":true}');
    expect(seam.digest()).toMatch(/^[a-f0-9]{64}$/);
    const released = seam.releaseToGates();
    expect(released?.text).toBe('{"ok":true}');
    expect(seam.isHeld()).toBe(false);
    seam.hold("x");
    seam.drop();
    expect(seam.releaseToGates()).toBeNull();
  });

  it("publishes a schema-valid answer unchanged with one adapter call", () => {
    let evidence = 0;
    let task = 0;
    let self = 0;
    const hooks = baseHooks({
      selfReview: () => {
        self += 1;
      },
      evidenceValidator: () => {
        evidence += 1;
      },
      taskContract: () => {
        task += 1;
      },
    });
    const out = runStructuredEpisode(hooks);
    expect(out.published).toBe(true);
    expect(out.text).toBe('{"ok":true}');
    expect(out.adapterCalls).toBe(1);
    expect(out.toolRegistryCalls).toBe(0);
    expect(out.reason).toBe(STRUCTURED_REASON.passed);
    expect(evidence).toBe(1);
    expect(task).toBe(1);
    expect(self).toBe(1);
    expect(out.records[0]).toMatchObject({
      run_id: "run-1",
      attempt: 0,
      verdict: "passed",
      outcome: "passed",
      citable: false,
      pinned: false,
      protected: true,
    } satisfies Partial<OutputRecord>);
  });

  it("re-emits once tool-less on schema mismatch and never publishes the invalid candidate", () => {
    const prompts: string[] = [];
    let self = 0;
    const hooks = baseHooks({
      firstDecode: () => ({ kind: "final_answer", text: '{"ok":"no"}' }),
      reemit: (prompt: string) => {
        prompts.push(prompt);
        return { kind: "final_answer", text: '{"ok":true}' };
      },
      selfReview: () => {
        self += 1;
      },
    });
    const out = runStructuredEpisode(hooks);
    expect(out.published).toBe(true);
    expect(out.text).toBe('{"ok":true}');
    expect(out.adapterCalls).toBe(2);
    expect(out.toolRegistryCalls).toBe(0);
    expect(self).toBe(1);
    expect(prompts[0]).toContain(UNTRUSTED_FEEDBACK_LABEL);
    expect(prompts[0]).not.toContain('{"ok":"no"}');
    expect(out.feedbackRetained).toBe(false);
    expect(out.feedbackCitable).toBe(false);
    expect(out.feedbackTaintIndexed).toBe(false);
    expect(out.records.some((r) => r.outcome === "passed")).toBe(true);
    expect(out.text).not.toBe('{"ok":"no"}');
  });

  it("treats tool_call, plan, and batch re-emits as structured_no_candidate without decoder rejects", () => {
    for (const kind of ["tool_call", "plan_revision", "batch"] as const) {
      const hooks = baseHooks({
        firstDecode: () => ({ kind: "final_answer", text: "{}" }),
        reemit: () => ({ kind }),
      });
      const out = runStructuredEpisode(hooks);
      expect(out.published).toBe(false);
      expect(out.reason).toBe(STRUCTURED_REASON.structured_no_candidate);
      expect(out.decoderRejects).toBe(0);
      expect(out.recoverySlotsOpened).toBe(0);
      expect(out.toolRegistryCalls).toBe(0);
      expect(out.records.some((r) => r.outcome === STRUCTURED_REASON.reemit_not_answer)).toBe(true);
    }
  });

  it("publishes output_schema_invalid after maxReemits and structured_no_candidate when no answer", () => {
    const still = runStructuredEpisode(
      baseHooks({
        firstDecode: () => ({ kind: "final_answer", text: "{}" }),
        reemit: () => ({ kind: "final_answer", text: "{}" }),
      }),
    );
    expect(still.reason).toBe(STRUCTURED_REASON.output_schema_invalid);
    expect(still.adapterCalls).toBe(2);
    expect(still.published).toBe(false);

    const none = runStructuredEpisode(
      baseHooks({
        firstDecode: () => ({ kind: "none" }),
      }),
    );
    expect(none.reason).toBe(STRUCTURED_REASON.structured_no_candidate);
    expect(none.adapterCalls).toBe(1);
  });

  it("flags too_large before parse and strips feedback to code, pointer, keyword", () => {
    const huge = `{"ok":true,${'"pad":"' + "x".repeat(80) + '"' }}`;
    const cfg = { ...config(true), maxAnswerBytes: 16 };
    const out = runStructuredEpisode(
      baseHooks({
        config: cfg,
        firstDecode: () => ({ kind: "final_answer", text: huge }),
        reemit: () => ({ kind: "final_answer", text: '{"ok":true}' }),
      }),
    );
    expect(out.records[0]?.verdict).toBe("too_large");
    expect(out.published).toBe(true);
    expect(out.text).toBe('{"ok":true}');

    const fb = buildStructuredFeedback(
      [
        {
          code: "type",
          pointer: "/ok",
          keyword: "type",
          message: 'expected boolean got "secret-answer"',
          data: "secret-answer",
          schema: { description: "do not leak" },
        },
      ],
      { maxErrors: STRUCTURED_CAPS.maxErrors.default, maxErrorBytes: 200 },
    );
    expect(fb.items).toEqual([{ code: "type", pointer: "/ok", keyword: "type" }]);
    expect(fb.labelled).not.toContain("secret-answer");
    expect(fb.labelled.startsWith(UNTRUSTED_FEEDBACK_LABEL)).toBe(true);
    expect(Object.keys(fb.items[0]).sort()).toEqual(["code", "keyword", "pointer"]);
  });

  it("skips the re-emit when measurement fails and does not start semantic compaction", () => {
    let reemits = 0;
    const out = runStructuredEpisode(
      baseHooks({
        firstDecode: () => ({ kind: "final_answer", text: "{}" }),
        measure: () => false,
        digestCompact: (t: string) => t.slice(0, 8),
        reemit: () => {
          reemits += 1;
          return { kind: "final_answer", text: '{"ok":true}' };
        },
      }),
    );
    expect(reemits).toBe(0);
    expect(out.adapterCalls).toBe(1);
    expect(out.reason).toBe(STRUCTURED_REASON.output_schema_invalid);
    expect(out.records.some((r) => r.outcome === "skipped_overflow")).toBe(true);
    expect(out.semanticCompactionCalls).toBe(0);
  });

  it("refuses reservation all-or-nothing with zero steps and releases once", () => {
    let releases = 0;
    const out = runStructuredEpisode(
      baseHooks({
        firstDecode: () => ({ kind: "final_answer", text: "{}" }),
        reserve: () => ({
          ok: false,
          attempts: 0,
          tokens: 0,
          cost: 0,
          steps: 0,
          release: () => {
            releases += 1;
          },
        }),
      }),
    );
    expect(out.adapterCalls).toBe(1);
    expect(out.stepsReserved).toBe(0);
    expect(out.reason).toBe(STRUCTURED_REASON.output_schema_invalid);
    expect(out.records.some((r) => r.outcome === "reservation_refused")).toBe(true);
    expect(releases).toBe(0);

    const ok = runStructuredEpisode(
      baseHooks({
        firstDecode: () => ({ kind: "final_answer", text: "{}" }),
        reemit: () => ({ kind: "final_answer", text: '{"ok":true}' }),
        reserve: () => ({
          ok: true,
          attempts: 1,
          tokens: 10,
          cost: 1,
          steps: 0,
          release: () => {
            releases += 1;
          },
        }),
      }),
    );
    expect(ok.published).toBe(true);
    expect(ok.stepsReserved).toBe(0);
    expect(releases).toBe(1);
    expect(ok.reservationReleases).toBe(1);
  });

  it("grants no re-emit on blockers and cancels on abort", () => {
    let reemits = 0;
    const blocked = runStructuredEpisode(
      baseHooks({
        firstDecode: () => ({ kind: "final_answer", text: "{}" }),
        blockers: { quarantine: true },
        reemit: () => {
          reemits += 1;
          return { kind: "final_answer", text: '{"ok":true}' };
        },
      }),
    );
    expect(reemits).toBe(0);
    expect(blocked.incomplete).toBe(true);
    expect(blocked.published).toBe(false);

    const aborted = runStructuredEpisode(
      baseHooks({
        firstDecode: () => ({ kind: "final_answer", text: "{}" }),
        blockers: { abort: true },
      }),
    );
    expect(aborted.cancelled).toBe(true);
    expect(aborted.reason).toBe(STRUCTURED_REASON.cancelled);
  });

  it("fails startup on unsupported roots and listed co-mounts; disabled adds no calls", () => {
    const compiler = objectRootCompiler(["object"]);
    const arraySchema = { type: "array", items: { type: "string" } };
    const bad = validateStructuredStartup({
      config: defaultStructuredConfig(outputContract(arraySchema), true),
      compiler,
      admission,
      mounted: [],
    });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe(STRUCTURED_REASON.structured_schema_unsupported);
    expect(bad.supportedRoots).toEqual(["object"]);

    const arrayOk = objectRootCompiler(["object", "array"]);
    const good = validateStructuredStartup({
      config: defaultStructuredConfig(outputContract(arraySchema), true),
      compiler: arrayOk,
      admission,
      mounted: [],
    });
    expect(good.ok).toBe(true);
    expect(good.compiledRoot).toBe("array");

    const co = validateStructuredStartup({
      config: config(true),
      compiler,
      admission,
      mounted: ["cap_verifier_repair_78"],
    });
    expect(co.ok).toBe(false);
    expect(co.code).toBe(STRUCTURED_REASON.co_mount_rejected);

    const disabled = runStructuredEpisode(
      baseHooks({
        config: config(false),
        firstDecode: () => {
          throw new Error("must not call");
        },
      }),
    );
    expect(disabled.adapterCalls).toBe(0);
    expect(disabled.records).toEqual([]);
  });

  it("does not treat a schema pass as waiving evidence or task contract", () => {
    let evidence = 0;
    const out = runStructuredEpisode(
      baseHooks({
        evidenceValidator: () => {
          evidence += 1;
        },
        taskContract: () => {
          evidence += 1;
        },
      }),
    );
    expect(out.reason).toBe("passed");
    expect(evidence).toBe(2);
    expect(out.records[0]?.citable).toBe(false);
  });
});
