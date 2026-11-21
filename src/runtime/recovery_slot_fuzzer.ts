/**
 * Deterministic simulator + fuzzer for the recovery-slot budget model.
 *
 * Spec under test (recovery-slot design):
 *  - one open failure slot per run tree (parent + delegate_task children share it)
 *  - shared recovery allowance (default 3) charged on every failure / repair dispatch
 *  - the slot is closed ONLY by a true-success repair of the tool that opened it
 *  - recall calls are free and never open/close/reset the slot
 *  - replanning never resets the allowance
 *  - a child never mints its own slot or allowance; it borrows the parent's slot
 *    or the parent's exhausted state. If the parent allowance is 0, a child's
 *    first failure is a terminal failure returned to the parent (no new slot,
 *    no dispatch), and no recovery dispatch by the child is permitted.
 *
 * The simulator drives a single shared ledger object across parent and child
 * (including nested grandchild delegation), so "child mints a slot" is
 * structurally impossible — the fuzzer asserts the four invariants hold on
 * every interleaving of the fuzzed outcome kinds.
 */

export const INITIAL_ALLOWANCE = 3;

export type ToolOutcomeKind = 'success' | 'invalid_args' | 'rejected' | 'timeout';

export interface ToolEvent {
  type: 'tool';
  tool: string;
  idempotent: boolean;
  outcome: ToolOutcomeKind;
}

export interface RunCodeEvent {
  type: 'run_code';
  outerOk: boolean;
  exitCode: number;
}

export interface RecallEvent {
  type: 'recall';
}

export interface ReplanEvent {
  type: 'replan';
}

export interface DelegateEvent {
  type: 'delegate_task';
  child: SimEvent[];
}

export type SimEvent = ToolEvent | RunCodeEvent | RecallEvent | ReplanEvent | DelegateEvent;

export interface LedgerSnapshot {
  allowance: number;
  slotOpen: boolean;
  slotTool: string | null;
  slotIdempotent: boolean | null;
}

export interface SimResult {
  /** whether the runtime actually dispatched the call */
  dispatched: boolean;
  /** the dispatch was refused (allowance exhausted) */
  refused: boolean;
  /** terminal failure propagated up (no slot could be opened / no dispatch possible) */
  terminalFailure: boolean;
  slotOpened: boolean;
  slotClosed: boolean;
  charged: number;
}

const ok = (over: Partial<SimResult> = {}): SimResult => ({
  dispatched: true,
  refused: false,
  terminalFailure: false,
  slotOpened: false,
  slotClosed: false,
  charged: 0,
  ...over,
});

/**
 * The shared-budget state machine. Parent and child runs all call `apply`
 * on the same instance; there is exactly one slot and one allowance for the
 * whole delegation tree.
 */
export class RecoverySlotSimulator {
  private allowance = INITIAL_ALLOWANCE;
  private slotOpen = false;
  private slotTool: string | null = null;
  private slotIdempotent: boolean | null = null;
  private totalCharged = 0;

  snapshot(): LedgerSnapshot {
    return {
      allowance: this.allowance,
      slotOpen: this.slotOpen,
      slotTool: this.slotTool,
      slotIdempotent: this.slotIdempotent,
    };
  }

  get remaining(): number {
    return this.allowance;
  }

  get exhausted(): boolean {
    return this.allowance <= 0;
  }

  get totalChargedUnits(): number {
    return this.totalCharged;
  }

  apply(event: SimEvent): SimResult {
    switch (event.type) {
      case 'tool':
        return this.applyTool(event.tool, event.idempotent, event.outcome);
      case 'run_code':
        // outer ok + exit_code === 0 is the only success form; anything else
        // (outer ok with exit_code != 0, or outer failure) is a non-success.
        if (event.outerOk && event.exitCode === 0) {
          return this.applyTool('run_code', false, 'success');
        }
        return this.applyTool('run_code', false, 'invalid_args');
      case 'recall':
        // Recall is free and never touches the ledger.
        return ok();
      case 'replan':
        // Replanning never resets the allowance and never touches the slot.
        return ok();
      case 'delegate_task':
        return this.applyDelegate(event.child);
    }
  }

  private applyTool(tool: string, idempotent: boolean, outcome: ToolOutcomeKind): SimResult {
    if (outcome === 'success') {
      // A success only closes the slot if it is a true-success repair of the
      // tool that opened it. A different (even idempotent) tool's success
      // never closes the slot.
      if (this.slotOpen && this.slotTool === tool) {
        this.slotOpen = false;
        this.slotTool = null;
        this.slotIdempotent = null;
        return ok({ slotClosed: true });
      }
      return ok();
    }

    // Non-success outcome: invalid_args / rejected / timeout / run_code failure.
    if (!this.slotOpen) {
      // First failure: charge the shared allowance and open the single slot.
      // If the allowance is already 0, this is a terminal failure — no slot
      // is opened and no dispatch happens. This is the child-borrowing rule:
      // a child calling into the same ledger cannot mint a fresh slot.
      if (this.allowance > 0) {
        this.allowance -= 1;
        this.totalCharged += 1;
        this.slotOpen = true;
        this.slotTool = tool;
        this.slotIdempotent = idempotent;
        return ok({ slotOpened: true, charged: 1 });
      }
      return {
        dispatched: false,
        refused: true,
        terminalFailure: true,
        slotOpened: false,
        slotClosed: false,
        charged: 0,
      };
    }

    // Slot already open: this is a repair / retry / alternative dispatch and
    // consumes from the shared remaining count. Refused when exhausted.
    if (this.allowance > 0) {
      this.allowance -= 1;
      this.totalCharged += 1;
      return ok({ charged: 1 });
    }
    return {
      dispatched: false,
      refused: true,
      terminalFailure: true,
      slotOpened: false,
      slotClosed: false,
      charged: 0,
    };
  }

  private applyDelegate(child: SimEvent[]): SimResult {
    // The child runs against THIS ledger (the parent's). It never gets its
    // own slot or a fresh allowance. Any refusal or terminal failure inside
    // the child run is returned to the parent as a terminal failure of the
    // delegate_task call.
    let terminalFailure = false;
    let refused = false;
    let dispatched = false;
    let slotOpened = false;
    let slotClosed = false;
    let charged = 0;
    for (const ev of child) {
      const r = this.apply(ev);
      dispatched = dispatched || r.dispatched;
      refused = refused || r.refused;
      terminalFailure = terminalFailure || r.terminalFailure;
      slotOpened = slotOpened || r.slotOpened;
      slotClosed = slotClosed || r.slotClosed;
      charged += r.charged;
    }
    return {
      dispatched,
      refused,
      terminalFailure,
      slotOpened,
      slotClosed,
      charged,
    };
  }
}

// ---------------------------------------------------------------------------
// Deterministic seeded fuzzer
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOOL_POOL: Array<{ tool: string; idempotent: boolean }> = [
  { tool: 'search_api', idempotent: true },
  { tool: 'reconcile_index', idempotent: true },
  { tool: 'write_file', idempotent: false },
  { tool: 'run_code', idempotent: false },
];

const OUTCOMES: ToolOutcomeKind[] = ['success', 'invalid_args', 'rejected', 'timeout'];

export function generateEvent(rand: () => number, depth: number): SimEvent {
  const roll = rand();
  if (depth > 0 && roll < 0.15) {
    const n = 1 + Math.floor(rand() * 4);
    const child: SimEvent[] = [];
    for (let i = 0; i < n; i++) child.push(generateEvent(rand, depth - 1));
    return { type: 'delegate_task', child };
  }
  if (roll < 0.25) return { type: 'recall' };
  if (roll < 0.35) return { type: 'replan' };
  if (roll < 0.5) {
    const outerOk = rand() < 0.8;
    const exitCode = rand() < 0.5 ? 0 : Math.floor(rand() * 3) - 1;
    return { type: 'run_code', outerOk, exitCode };
  }
  const t = TOOL_POOL[Math.floor(rand() * TOOL_POOL.length)];
  const outcome = OUTCOMES[Math.floor(rand() * OUTCOMES.length)];
  return { type: 'tool', tool: t.tool, idempotent: t.idempotent, outcome };
}

export interface FuzzViolation {
  seed: number;
  step: number;
  invariant: string;
  event: SimEvent;
  before: LedgerSnapshot;
  after: LedgerSnapshot;
}

function snapshotsEqual(a: LedgerSnapshot, b: LedgerSnapshot): boolean {
  return (
    a.allowance === b.allowance &&
    a.slotOpen === b.slotOpen &&
    a.slotTool === b.slotTool &&
    a.slotIdempotent === b.slotIdempotent
  );
}

function isTrueSuccessRepair(event: SimEvent, before: LedgerSnapshot): boolean {
  if (event.type === 'tool') {
    return event.outcome === 'success' && event.tool === before.slotTool;
  }
  if (event.type === 'run_code') {
    return event.outerOk && event.exitCode === 0 && before.slotTool === 'run_code';
  }
  return false;
}

/**
 * Runs one seeded interleaving, asserting the four invariants after every
 * single event. Returns the list of violations found (empty when the model
 * holds).
 *
 * Invariants:
 *  1. allowance is never negative and never exceeds INITIAL_ALLOWANCE (no
 *     reset, no minting — including by children).
 *  2. recall and replan events leave the ledger byte-for-byte unchanged.
 *  3. the slot is closed only by a true-success repair of the tool that
 *     opened it (a different idempotent tool's success never closes it).
 *  4. total charged units never exceed the initial issued budget.
 */
export function runSeed(seed: number, steps: number): FuzzViolation[] {
  const rand = mulberry32(seed);
  const sim = new RecoverySlotSimulator();
  const violations: FuzzViolation[] = [];
  for (let step = 0; step < steps; step++) {
    const event = generateEvent(rand, 2);
    const before = sim.snapshot();
    sim.apply(event);
    const after = sim.snapshot();
    const base = { seed, step, event, before, after };

    if (after.allowance < 0) {
      violations.push({ ...base, invariant: 'allowance_negative' });
    }
    if (after.allowance > INITIAL_ALLOWANCE) {
      violations.push({ ...base, invariant: 'allowance_reset_or_minted' });
    }
    if (after.allowance > before.allowance) {
      violations.push({ ...base, invariant: 'allowance_increased' });
    }
    if ((event.type === 'recall' || event.type === 'replan') && !snapshotsEqual(before, after)) {
      violations.push({ ...base, invariant: 'recall_or_replan_touched_ledger' });
    }
    if (before.slotOpen && !after.slotOpen && !isTrueSuccessRepair(event, before)) {
      violations.push({ ...base, invariant: 'slot_closed_without_true_success_repair' });
    }
    if (!before.slotOpen && after.slotOpen && sim.totalChargedUnits > INITIAL_ALLOWANCE) {
      violations.push({ ...base, invariant: 'issued_budget_bound_exceeded' });
    }
    if (sim.totalChargedUnits > INITIAL_ALLOWANCE) {
      violations.push({ ...base, invariant: 'issued_budget_bound_exceeded' });
    }
  }
  return violations;
}

export function fuzzRecoverySlot(seeds: number, steps: number): FuzzViolation[] {
  const all: FuzzViolation[] = [];
  for (let seed = 1; seed <= seeds; seed++) {
    all.push(...runSeed(seed, steps));
  }
  return all;
}
