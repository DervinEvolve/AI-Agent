import { AttemptAllowance, InferenceUsage, ReserveResult, SharedInferenceAdmission } from './types';

export interface InferenceAdmissionLimits {
  attemptLimit: number;
  tokenLimit?: number;
  costLimit?: number;
}

export interface InferenceAdmissionSnapshot {
  attemptsStarted: number;
  attemptsHeld: number;
  tokensUsed: number;
  tokensHeld: number;
  costUsed: number;
  costHeld: number;
  unknownUsageAttempts: number;
  stopped: boolean;
  stopReason: string | null;
}

interface Reservation {
  pending: AttemptAllowance[];
  inflight: AttemptAllowance[];
  released: boolean;
}

/**
 * Run-wide inference admission with all-or-nothing reservations.
 *
 * Base attempts and deliberation attempts draw on the same counters, so there
 * is one account and no double charge. Unknown usage is charged at the full
 * reserved allowance, stays recorded, and stops further admission.
 */
export class InferenceAdmission implements SharedInferenceAdmission {
  private readonly limits: Required<InferenceAdmissionLimits>;
  private readonly reservations = new Map<string, Reservation>();
  private seq = 0;
  private s: InferenceAdmissionSnapshot = {
    attemptsStarted: 0,
    attemptsHeld: 0,
    tokensUsed: 0,
    tokensHeld: 0,
    costUsed: 0,
    costHeld: 0,
    unknownUsageAttempts: 0,
    stopped: false,
    stopReason: null,
  };

  constructor(limits: InferenceAdmissionLimits) {
    if (!Number.isInteger(limits.attemptLimit) || limits.attemptLimit <= 0) {
      throw new Error('InferenceAdmission requires a finite positive integer attemptLimit');
    }
    this.limits = {
      attemptLimit: limits.attemptLimit,
      tokenLimit: limits.tokenLimit ?? Number.POSITIVE_INFINITY,
      costLimit: limits.costLimit ?? Number.POSITIVE_INFINITY,
    };
  }

  attemptLimit(): number {
    return this.limits.attemptLimit;
  }

  reserve(allowances: readonly AttemptAllowance[]): ReserveResult {
    if (this.s.stopped) return { ok: false, reason: 'inference_stopped' };
    if (allowances.length === 0) return { ok: false, reason: 'empty_reservation' };
    let tokens = 0;
    let cost = 0;
    for (const a of allowances) {
      if (!Number.isFinite(a.tokens) || a.tokens < 0 || !Number.isFinite(a.cost) || a.cost < 0) {
        return { ok: false, reason: 'bad_allowance' };
      }
      tokens += a.tokens;
      cost += a.cost;
    }
    if (this.s.attemptsStarted + this.s.attemptsHeld + allowances.length > this.limits.attemptLimit) {
      return { ok: false, reason: 'attempt_limit' };
    }
    if (this.s.tokensUsed + this.s.tokensHeld + tokens > this.limits.tokenLimit) {
      return { ok: false, reason: 'token_limit' };
    }
    if (this.s.costUsed + this.s.costHeld + cost > this.limits.costLimit) {
      return { ok: false, reason: 'cost_limit' };
    }
    const id = `res_${++this.seq}`;
    this.reservations.set(id, { pending: allowances.map((a) => ({ ...a })), inflight: [], released: false });
    this.s.attemptsHeld += allowances.length;
    this.s.tokensHeld += tokens;
    this.s.costHeld += cost;
    return { ok: true, id };
  }

  start(id: string): void {
    const r = this.reservations.get(id);
    if (!r || r.released) throw new Error(`reservation ${id} is not open`);
    const a = r.pending.shift();
    if (!a) throw new Error(`reservation ${id} has no unstarted attempt`);
    r.inflight.push(a);
    this.s.attemptsHeld -= 1;
    this.s.attemptsStarted += 1;
  }

  settle(id: string, usage: InferenceUsage): void {
    const r = this.reservations.get(id);
    const a = r?.inflight.shift();
    if (!r || !a) throw new Error(`reservation ${id} has no started attempt to settle`);
    this.s.tokensHeld -= a.tokens;
    this.s.costHeld -= a.cost;
    if (usage.known) {
      this.s.tokensUsed += usage.tokens;
      this.s.costUsed += usage.cost;
    } else {
      this.s.tokensUsed += a.tokens;
      this.s.costUsed += a.cost;
      this.s.unknownUsageAttempts += 1;
      this.stopInference('usage_unknown');
    }
  }

  release(id: string): boolean {
    const r = this.reservations.get(id);
    if (!r || r.released) return false;
    r.released = true;
    for (const a of r.pending) {
      this.s.attemptsHeld -= 1;
      this.s.tokensHeld -= a.tokens;
      this.s.costHeld -= a.cost;
    }
    r.pending = [];
    return true;
  }

  stopInference(reason: string): void {
    if (!this.s.stopped) {
      this.s.stopped = true;
      this.s.stopReason = reason;
    }
  }

  inferenceStopped(): boolean {
    return this.s.stopped;
  }

  /** Convenience for an ordinary base attempt: reserve one and start it. */
  startBaseAttempt(allowance: AttemptAllowance): ReserveResult {
    const res = this.reserve([allowance]);
    if (res.ok) this.start(res.id);
    return res;
  }

  snapshot(): InferenceAdmissionSnapshot {
    return { ...this.s };
  }
}
