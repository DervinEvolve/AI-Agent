/**
 * Deterministic, seeded fuzzer for the recovery-slot model.
 *
 * Generates pseudo-random event sequences (seeded PRNG, no external deps),
 * replays each sequence under the strict oracle and under two alternative
 * readings of the spec, and records every point where the readings disagree
 * (a spec ambiguity) plus every invariant violation under the strict reading.
 */

import {
  canonical,
  initState,
  runSequence,
  step,
  STRICT_ORACLE,
  type Oracle,
  type SlotEvent,
  type SlotState,
  type ToolSpec,
} from "./slot_model";

export interface Divergence {
  variant: string;
  description: string;
  eventIndex: number;
  sequence: SlotEvent[];
  strictState: string;
  variantState: string;
}

export interface FuzzReport {
  seed: number;
  sequencesChecked: number;
  divergences: Divergence[];
  invariantViolations: string[];
}

const VARIANTS: Array<{ name: string; oracle: Oracle; description: string }> = [
  {
    name: "reconciliation-costs-allowance",
    oracle: {
      reconciliationConsumesAllowance: true,
      childFinalFailureCountsUnderMark: false,
    },
    description:
      "mlsysbook vol3 ch.12 Table 2 classifies a reconciliation probe that returns evidence as a retry of the same operation, so it consumes allowance; the contribution text says it consumes none.",
  },
  {
    name: "child-failure-counts-under-mark",
    oracle: {
      reconciliationConsumesAllowance: false,
      childFinalFailureCountsUnderMark: true,
    },
    description:
      "The 'child final failure counts as one parent recovery dispatch' rule fires even while delegate_task is refused under the unknown_outcome mark, contradicting the refusal rule that consumes nothing.",
  },
];

const TOOLS: ToolSpec[] = [
  { id: "T", idempotent: false, readOnly: false }, // the marked non-idempotent tool
  { id: "R", idempotent: true, readOnly: true }, // idempotent read-only reconciliation tool
  { id: "W", idempotent: true, readOnly: false }, // idempotent write tool
];

/** mulberry32 — small deterministic PRNG. */
function makePrng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rnd: () => number, xs: T[]): T {
  return xs[Math.floor(rnd() * xs.length) % xs.length];
}

function randomEvent(rnd: () => number): SlotEvent {
  const roll = rnd();
  if (roll < 0.15) return { kind: "timeout", tool: "T" };
  if (roll < 0.4) {
    const spec = pick(rnd, TOOLS);
    return { kind: "dispatch", tool: spec.id, spec, success: rnd() < 0.3 };
  }
  if (roll < 0.6) {
    const spec = pick(rnd, TOOLS);
    const evidence = pick(rnd, ["applied", "not_applied", "none"] as const);
    return {
      kind: "reconcile",
      tool: spec.id,
      spec,
      evidence,
      recorded: rnd() < 0.7,
    };
  }
  if (roll < 0.7) return { kind: "recall" };
  if (roll < 0.85) return { kind: "delegate", childFinalFailure: rnd() < 0.5 };
  if (roll < 0.97) {
    return {
      kind: "run_code",
      outcome: rnd() < 0.6 ? "completed" : "failed",
      exitCode: rnd() < 0.6 ? 0 : 1,
      terminationConfirmed: rnd() < 0.7,
      cleanupConfirmed: rnd() < 0.7,
    };
  }
  return { kind: "finalize" };
}

function randomSequence(rnd: () => number): SlotEvent[] {
  const len = 3 + Math.floor(rnd() * 10);
  return Array.from({ length: len }, () => randomEvent(rnd));
}

/** Directed sequences that pin the known ambiguities deterministically. */
function directedSequences(): SlotEvent[][] {
  return [
    [
      { kind: "timeout", tool: "T" },
      { kind: "delegate", childFinalFailure: true },
    ],
    [
      { kind: "timeout", tool: "T" },
      {
        kind: "reconcile",
        tool: "R",
        spec: TOOLS[1],
        evidence: "applied",
        recorded: true,
      },
    ],
    [
      { kind: "timeout", tool: "T" },
      {
        kind: "reconcile",
        tool: "R",
        spec: TOOLS[1],
        evidence: "none",
        recorded: false,
      },
    ],
  ];
}

/** Invariants of the strict reading, checked after every single step. */
function checkInvariants(
  before: SlotState,
  after: SlotState,
  ev: SlotEvent,
  seq: SlotEvent[],
  idx: number
): string[] {
  const violations: string[] = [];
  const where = `seq#${seq
    .slice(0, idx + 1)
    .map((e) => e.kind)
    .join("->")}`;
  if (after.allowance < 0) {
    violations.push(`allowance negative at ${where}`);
  }
  if (ev.kind === "reconcile") {
    if (after.slotOpen !== before.slotOpen) {
      violations.push(`reconciliation changed slotOpen at ${where}`);
    }
    if (after.allowance !== before.allowance) {
      violations.push(
        `reconciliation consumed allowance under strict oracle at ${where}`
      );
    }
    if (after.markTool !== null && before.markTool === null) {
      violations.push(`reconciliation set a mark at ${where}`);
    }
    if (before.markTool !== null && after.markTool !== null) {
      violations.push(
        `reconciliation changed the mark without evidence at ${where}`
      );
    }
  }
  if (ev.kind === "recall") {
    if (
      after.slotOpen !== before.slotOpen ||
      after.markTool !== before.markTool ||
      after.allowance !== before.allowance
    ) {
      violations.push(`recall changed slot state at ${where}`);
    }
  }
  if (
    (ev.kind === "dispatch" || ev.kind === "run_code") &&
    after.lastRefusal !== null &&
    after.allowance !== before.allowance
  ) {
    violations.push(`refused dispatch consumed allowance at ${where}`);
  }
  if (ev.kind === "delegate" && after.lastRefusal !== null) {
    if (after.lastRefusal === "refused_but_counted") {
      violations.push(
        `delegate refused under mark yet counted as parent dispatch at ${where}`
      );
    }
    if (after.allowance !== before.allowance) {
      violations.push(
        `refused delegate changed allowance under strict oracle at ${where}`
      );
    }
  }
  return violations;
}

function compareVariant(
  seq: SlotEvent[],
  variant: { name: string; oracle: Oracle; description: string }
): Divergence | null {
  let strict = initState();
  let variantState = initState();
  for (let i = 0; i < seq.length; i++) {
    strict = step(strict, seq[i], STRICT_ORACLE);
    variantState = step(variantState, seq[i], variant.oracle);
    if (canonical(strict) !== canonical(variantState)) {
      return {
        variant: variant.name,
        description: variant.description,
        eventIndex: i,
        sequence: seq.slice(0, i + 1),
        strictState: canonical(strict),
        variantState: canonical(variantState),
      };
    }
  }
  return null;
}

export function runFuzz(seed: number, randomSequences = 400): FuzzReport {
  const rnd = makePrng(seed);
  const sequences = [
    ...directedSequences(),
    ...Array.from({ length: randomSequences }, () => randomSequence(rnd)),
  ];
  const divergences: Divergence[] = [];
  const invariantViolations: string[] = [];
  const seen = new Set<string>();

  for (const seq of sequences) {
    // Invariants under the strict oracle, step by step.
    let s = initState();
    for (let i = 0; i < seq.length; i++) {
      const before = s;
      s = step(s, seq[i], STRICT_ORACLE);
      for (const v of checkInvariants(before, s, seq[i], seq, i)) {
        if (!seen.has(v)) {
          seen.add(v);
          invariantViolations.push(v);
        }
      }
    }
    // Divergence between strict and each alternative reading.
    for (const variant of VARIANTS) {
      const d = compareVariant(seq, variant);
      if (d) {
        const key = `${d.variant}:${d.eventIndex}:${d.strictState}:${d.variantState}`;
        if (!seen.has(key)) {
          seen.add(key);
          divergences.push(d);
        }
      }
    }
  }

  return {
    seed,
    sequencesChecked: sequences.length,
    divergences,
    invariantViolations,
  };
}

/** Convenience: run one sequence under the strict oracle (used by tests). */
export { runSequence };
