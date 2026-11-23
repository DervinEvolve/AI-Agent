/**
 * Seeded property-based fuzzer for the recovery-slot specification.
 *
 * - Deterministic PRNG (mulberry32) seeded per trace: random.Random(seed)
 *   equivalent.
 * - Generates random sequences of tool dispatches and outcomes (success,
 *   invalid_args / rejected / unknown_tool / timeout on idempotent and
 *   non-idempotent tools, run_code outer-ok with nonzero exit, truncated
 *     outputs, unconfirmed terminations), recall, replan, delegate_task,
 *   external failures, termination reports and finalize.
 * - Checks six invariants against the reference state machine in
 *   recovery_slot_spec.ts after every step.
 * - Delta-debugging (Zeller-style) shrinker minimizes any violating trace.
 * - Undecidable cases are logged as spec gaps (GapTag).
 */

import {
  step,
  initialSlotState,
  type DispatchKind,
  type MachineState,
  type Outcome,
  type SlotEvent,
  type GapTag,
  type Decision,
  isRecoveryKind,
} from './recovery_slot_spec';

export type StepFn = (state: MachineState, event: SlotEvent) => MachineState;

/** Deterministic seeded PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOOLS: Array<{ tool: string; idempotent: boolean }> = [
  { tool: 'http_post', idempotent: false },
  { tool: 'write_file', idempotent: false },
  { tool: 'http_get', idempotent: true },
  { tool: 'read_file', idempotent: true },
  { tool: 'run_code', idempotent: false },
  { tool: 'search', idempotent: true },
];

const KINDS: DispatchKind[] = ['repair', 'retry', 'alternative', 'reconciliation', 'independent'];
const FAILURE_CODES = ['invalid_args', 'rejected', 'unknown_tool', 'timeout'] as const;

function genOutcome(rnd: () => number): Outcome {
  const r = rnd();
  if (r < 0.3) return { kind: 'success' };
  if (r < 0.55) {
    return { kind: 'failure', code: FAILURE_CODES[Math.floor(rnd() * FAILURE_CODES.length)] };
  }
  if (r < 0.7) return { kind: 'truncated_success' };
  return {
    kind: 'run_code',
    completed: rnd() < 0.8,
    exitCode: rnd() < 0.6 ? 0 : 1,
    terminationConfirmed: rnd() < 0.7,
    cleanupConfirmed: rnd() < 0.7,
  };
}

/** Deterministic trace generator: random.Random(seed) per the contribution. */
export function generateTrace(seed: number, minLength = 6, maxLength = 32): SlotEvent[] {
  const rnd = mulberry32(seed);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
  const len = minLength + Math.floor(rnd() * (maxLength - minLength + 1));
  const trace: SlotEvent[] = [];
  let callId = 0;
  for (let i = 0; i < len; i++) {
    const r = rnd();
    if (r < 0.45) {
      const t = pick(TOOLS);
      trace.push({
        type: 'dispatch',
        tool: t.tool,
        idempotent: t.idempotent,
        kind: pick(KINDS),
        intentId: 'intent-' + (1 + Math.floor(rnd() * 2)),
        callId: 'c' + callId++,
      });
    } else if (r < 0.75) {
      trace.push({
        type: 'outcome',
        callId: 'c' + Math.floor(rnd() * (callId + 1)),
        outcome: genOutcome(rnd),
      });
    } else if (r < 0.8) {
      trace.push({
        type: 'external_failure',
        callId: 'x' + callId++,
        intentId: 'intent-' + (1 + Math.floor(rnd() * 2)),
      });
    } else if (r < 0.85) {
      trace.push({ type: 'recall' });
    } else if (r < 0.9) {
      trace.push({ type: 'replan' });
    } else if (r < 0.94) {
      trace.push({ type: 'delegate_request' });
    } else if (r < 0.97) {
      trace.push({
        type: 'termination_report',
        callId: 'c' + Math.floor(rnd() * (callId + 1)),
        terminationConfirmed: rnd() < 0.7,
        cleanupConfirmed: rnd() < 0.7,
      });
    } else {
      trace.push({ type: 'finalize', successClaim: rnd() < 0.4 });
    }
  }
  return trace;
}

export interface Violation {
  invariant: string;
  detail: string;
  stepIndex: number;
}

function allowance(st: MachineState): number | null {
  return st.slot ? st.slot.remaining : null;
}

/**
 * The six invariants, checked after every transition:
 *  (1) recall never changes allowance;
 *  (2) the slot never resets on replan;
 *  (3) after an exhausted allowance no recovery dispatch is admitted;
 *  (4) a non-idempotent timeout refuses same-tool redispatch;
 *  (5) run_code success requires completed, exit_code 0 and
 *      termination_confirmed;
 *  (6) delegate_task is refused while a slot is open or an outcome is unknown.
 */
export function checkInvariants(
  before: MachineState,
  after: MachineState,
  ev: SlotEvent,
  decision: Decision | undefined,
): Violation | null {
  if (ev.type === 'recall') {
    if (allowance(before) !== allowance(after)) {
      return {
        invariant: 'inv1-recall-free',
        detail: `recall changed allowance ${allowance(before)} -> ${allowance(after)}`,
        stepIndex: -1,
      };
    }
  }
  if (ev.type === 'replan') {
    if (
      Boolean(before.slot) !== Boolean(after.slot) ||
      (before.slot && after.slot && before.slot.remaining !== after.slot.remaining)
    ) {
      return {
        invariant: 'inv2-replan-no-reset',
        detail: `replan changed the slot (open=${Boolean(before.slot)} -> ${Boolean(after.slot)}, allowance ${allowance(before)} -> ${allowance(after)})`,
        stepIndex: -1,
      };
    }
  }
  if (ev.type === 'dispatch' && isRecoveryKind(ev.kind)) {
    if (before.slot && before.slot.remaining === 0 && decision?.action === 'admitted') {
      return {
        invariant: 'inv3-no-dispatch-after-exhaustion',
        detail: `recovery dispatch of ${ev.tool} admitted at allowance 0`,
        stepIndex: -1,
      };
    }
    if (before.nonIdemTimeoutTool === ev.tool && !ev.idempotent && decision?.action === 'admitted') {
      return {
        invariant: 'inv4-nonidem-no-same-tool-redispatch',
        detail: `same-tool redispatch of non-idempotent ${ev.tool} admitted while its outcome is unknown`,
        stepIndex: -1,
      };
    }
  }
  if (ev.type === 'outcome' && ev.outcome.kind === 'run_code' && decision?.action === 'closed') {
    const o = ev.outcome;
    if (!(o.completed && o.exitCode === 0 && o.terminationConfirmed)) {
      return {
        invariant: 'inv5-runcode-success',
        detail: `run_code closed the slot without completed/exit 0/termination_confirmed (completed=${o.completed}, exit=${o.exitCode}, term=${o.terminationConfirmed})`,
        stepIndex: -1,
      };
    }
  }
  if (
    ev.type === 'delegate_request' &&
    decision?.action === 'admitted' &&
    (Boolean(before.slot) || before.outcomeUnknown)
  ) {
    return {
      invariant: 'inv6-delegate-guard',
      detail: `delegate_task admitted while slotOpen=${Boolean(before.slot)}, outcomeUnknown=${before.outcomeUnknown}`,
      stepIndex: -1,
    };
  }
  return null;
}

export interface TraceResult {
  state: MachineState;
  violations: Violation[];
}

/** Run a trace through a state machine (reference by default) and check invariants each step. */
export function runTrace(trace: SlotEvent[], stepFn: StepFn = step): TraceResult {
  let state = initialSlotState();
  const violations: Violation[] = [];
  trace.forEach((ev, i) => {
    const before = state;
    const after = stepFn(before, ev);
    const v = checkInvariants(before, after, ev, after.decisions[after.decisions.length - 1]);
    if (v) violations.push({ ...v, stepIndex: i });
    state = after;
  });
  return { state, violations };
}

/**
 * Zeller-style delta-debugging shrinker: repeatedly try removing contiguous
 * chunks of events while the predicate (same invariant still violated) holds.
 * Returns a 1-minimal trace.
 */
export function shrinkTrace(
  trace: SlotEvent[],
  predicate: (candidate: SlotEvent[]) => boolean,
): SlotEvent[] {
  let best = trace.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (
      let size = Math.max(1, Math.floor(best.length / 2));
      size >= 1;
      size = Math.floor(size / 2)
    ) {
      let i = 0;
      while (i + size <= best.length) {
        const cand = best.slice(0, i).concat(best.slice(i + size));
        if (cand.length > 0 && predicate(cand)) {
          best = cand;
          changed = true;
        } else {
          i++;
        }
      }
      if (size === 1) break;
    }
  }
  return best;
}

export interface FuzzViolation {
  seed: number;
  invariant: string;
  detail: string;
  shrunkTrace: SlotEvent[];
}

export interface FuzzResult {
  traces: number;
  violations: FuzzViolation[];
  gaps: GapTag[];
}

/** Run the seeded fuzzer: seeds x tracesPerSeed traces (5000 in the contribution run). */
export function fuzz(seeds: number[], tracesPerSeed: number): FuzzResult {
  const violations: FuzzViolation[] = [];
  const gaps = new Set<GapTag>();
  for (const seed of seeds) {
    for (let t = 0; t < tracesPerSeed; t++) {
      const id = seed * 100003 + t;
      const trace = generateTrace(id);
      const { state, violations: vs } = runTrace(trace);
      for (const g of state.gaps) gaps.add(g);
      for (const v of vs) {
        const shrunk = shrinkTrace(
          trace,
          (cand) =>
            runTrace(cand).violations.some((x) => x.invariant === v.invariant),
        );
        violations.push({ seed: id, invariant: v.invariant, detail: v.detail, shrunkTrace: shrunk });
      }
    }
  }
  return { traces: seeds.length * tracesPerSeed, violations, gaps: [...gaps] };
}
