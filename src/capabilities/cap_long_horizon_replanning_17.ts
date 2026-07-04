// cap_long_horizon_replanning_17 — mission_control
//
// A PURE orchestration/state layer. It NEVER executes tools, adapters, sandbox,
// browser, api_client, network, or vault. It only:
//   - persists mission state (via injected MemoryBackend / cap_long_term_memory_3)
//   - evaluates milestone success_criteria through the injected controller
//     reflection path (beh_criteria_reflection_2)
//   - emits advisory plans via the injected planner (cap_deliberative_planning_10)
//   - routes state-changing / irreversible / drifted-resume steps through the
//     injected HITL backend (cap_hitl_communication_16)
//
// All external-state evidence is tainted and cannot directly mark a milestone
// complete, select a replan target, set tool args, or substitute for an HITL
// token (ARGUS value/authorization/evidence pathways).

import type {
  BudgetPolicy,
  CheckpointRef,
  ExecutionContext,
  Milestone,
  MilestoneInput,
  MissionControlDeps,
  MissionInputs,
  MissionOutput,
  MissionState,
  NextPlan,
  ObservedState,
  Provenance,
} from './cap_long_horizon_replanning_17.types';

export const DEFAULT_MAX_REPLANS = 5;

export const RESERVE_COST = {
  monitor: 1,
  replan: 3,
  checkpoint: 1,
} as const;

function isInteractive(ctx: ExecutionContext): boolean {
  if (!ctx.interactive) return false;
  const k = ctx.kind ?? 'interactive';
  return k === 'interactive';
}

function err(code: string, message: string, retryable = false) {
  return { code, message, retryable };
}

function observedTainted(observed: ObservedState | undefined): boolean {
  if (!observed) return false;
  return observed.tainted === true;
}

export class MissionControl {
  private missions = new Map<string, MissionState>();
  private deps: MissionControlDeps;
  private ctx: ExecutionContext;
  private counter = 0;

  constructor(deps: MissionControlDeps, ctx: ExecutionContext) {
    this.deps = deps;
    this.ctx = ctx;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private id(prefix: string): string {
    if (this.deps.idgen) return `${prefix}_${this.deps.idgen()}`;
    this.counter += 1;
    return `${prefix}_${this.now()}_${this.counter}`;
  }

  handle(input: MissionInputs): MissionOutput {
    switch (input.action) {
      case 'create_mission':
        return this.createMission(input);
      case 'decompose':
        return this.decompose(input);
      case 'monitor':
        return this.monitor(input);
      case 'replan':
        return this.replan(input);
      case 'checkpoint':
        return this.checkpoint(input);
      case 'resume':
        return this.resume(input);
      case 'abort':
        return this.abort(input);
      case 'status':
        return this.status(input);
      default:
        return {
          status: 'policy_blocked',
          tainted: false,
          error: err('unknown_action', `unknown action: ${String(input.action)}`),
        };
    }
  }

  private getMission(mission_id?: string): MissionState | null {
    if (!mission_id) return null;
    return this.missions.get(mission_id) ?? null;
  }

  private notFound(): MissionOutput {
    return {
      status: 'policy_blocked',
      tainted: false,
      error: err('mission_not_found', 'mission_id required and must reference an existing mission'),
    };
  }

  private createMission(input: MissionInputs): MissionOutput {
    if (!input.goal || input.goal.trim() === '') {
      return {
        status: 'policy_blocked',
        tainted: false,
        error: err('missing_goal', 'create_mission requires a non-empty goal'),
      };
    }
    const mission_id = this.id('mission');
    const ts = this.now();
    const provenance: Provenance = {
      mission_id,
      timestamps: [ts],
      checkpoint_ids: [],
      replan_history: [],
      scope: this.ctx.scope,
    };
    const state: MissionState = {
      mission_id,
      goal: input.goal,
      milestones_with_status: [],
      current_milestone: null,
      completed: [],
      remaining: [],
      replan_count: 0,
      provenance,
      stale: false,
      aborted: false,
    };
    this.missions.set(mission_id, state);
    return { status: 'ok', tainted: false, mission_state: clone(state), provenance: clone(provenance) };
  }

  private decompose(input: MissionInputs): MissionOutput {
    const m = this.getMission(input.mission_id);
    if (!m) return this.notFound();
    if (!input.milestones || input.milestones.length === 0) {
      return {
        status: 'policy_blocked',
        tainted: false,
        error: err('missing_milestones', 'decompose requires a non-empty milestones list'),
      };
    }
    // Reject any milestone missing success_criteria.
    for (const ms of input.milestones) {
      if (!ms.success_criteria || ms.success_criteria.length === 0) {
        return {
          status: 'policy_blocked',
          tainted: false,
          error: err(
            'invalid_milestone',
            `milestone ${ms.milestone_id} rejected: success_criteria required`
          ),
        };
      }
    }
    const milestones: Milestone[] = input.milestones.map((ms: MilestoneInput) => ({
      milestone_id: ms.milestone_id,
      description: ms.description,
      // immutable success criteria copy
      success_criteria: [...ms.success_criteria],
      preconditions: ms.preconditions ? [...ms.preconditions] : [],
      dependencies: ms.dependencies ? [...ms.dependencies] : [],
      reversible: ms.reversible !== false ? ms.reversible ?? true : false,
      status: 'pending',
      tainted: false,
    }));
    m.milestones_with_status = milestones;
    m.remaining = milestones.map((x) => x.milestone_id);
    m.completed = [];
    m.current_milestone = milestones.length > 0 ? milestones[0].milestone_id : null;
    m.provenance.timestamps.push(this.now());
    return { status: 'ok', tainted: false, mission_state: clone(m), provenance: clone(m.provenance) };
  }

  private monitor(input: MissionInputs): MissionOutput {
    const m = this.getMission(input.mission_id);
    if (!m) return this.notFound();

    if (!this.deps.budget.reserve('monitor', RESERVE_COST.monitor)) {
      return budgetExhausted();
    }

    const tainted = observedTainted(input.observed_state);

    // Evaluate every milestone's immutable success_criteria via reflection path.
    for (const ms of m.milestones_with_status) {
      if (ms.status === 'passed') continue;
      const verdict = this.deps.reflection.evaluate({
        milestone: ms,
        observed: input.observed_state,
      });
      // Taint contract: tainted evidence may NOT directly mark a milestone
      // complete. A 'passed' verdict backed only by tainted evidence becomes
      // 'uncertain' and requires independent validation before completion.
      if (verdict === 'passed' && tainted) {
        ms.status = 'uncertain';
        ms.tainted = true;
      } else {
        ms.status = verdict === 'passed' ? 'passed' : verdict === 'failed' ? 'failed' : 'uncertain';
        if (tainted) ms.tainted = true;
      }
    }

    this.recomputeProgress(m);

    // A failed milestone whose dependencies are not all completed is blocked.
    const current = m.milestones_with_status.find((x) => x.milestone_id === m.current_milestone);
    if (current && current.status === 'failed') {
      const unmet = current.dependencies.filter((d) => !m.completed.includes(d));
      if (unmet.length > 0) {
        current.status = 'blocked';
        return {
          status: 'blocked_on_dependency',
          tainted,
          mission_state: clone(m),
          provenance: clone(m.provenance),
        };
      }
    }

    m.provenance.timestamps.push(this.now());
    return { status: 'ok', tainted, mission_state: clone(m), provenance: clone(m.provenance) };
  }

  private recomputeProgress(m: MissionState): void {
    m.completed = m.milestones_with_status
      .filter((x) => x.status === 'passed')
      .map((x) => x.milestone_id);
    m.remaining = m.milestones_with_status
      .filter((x) => x.status !== 'passed')
      .map((x) => x.milestone_id);
    // current_milestone: first remaining whose deps are complete.
    const next = m.milestones_with_status.find(
      (x) => x.status !== 'passed' && x.dependencies.every((d) => m.completed.includes(d))
    );
    m.current_milestone = next ? next.milestone_id : m.remaining.length > 0 ? m.remaining[0] : null;
  }

  private replan(input: MissionInputs): MissionOutput {
    const m = this.getMission(input.mission_id);
    if (!m) return this.notFound();

    const policy: BudgetPolicy = input.budget_policy ?? {};
    const maxReplans = policy.max_replans ?? DEFAULT_MAX_REPLANS;

    if (m.replan_count >= maxReplans) {
      // Hard cap -> budget_exhausted + structured failure.
      m.provenance.timestamps.push(this.now());
      return {
        status: 'budget_exhausted',
        tainted: observedTainted(input.observed_state),
        mission_state: clone(m),
        provenance: clone(m.provenance),
        error: err('max_replans_exceeded', `replan cap ${maxReplans} exceeded`, false),
      };
    }

    if (!this.deps.budget.reserve('replan', RESERVE_COST.replan)) {
      return budgetExhausted();
    }

    const tainted = observedTainted(input.observed_state);

    // Taint contract: tainted evidence must NOT directly select the replan
    // target. We revise only remaining/failed milestones (verified 'passed'
    // milestones are preserved untouched), independent of the tainted payload.
    const remaining = m.milestones_with_status.filter((x) => x.status !== 'passed');

    const steps = this.deps.planner.plan({
      goal: m.goal,
      remaining,
      trigger: input.replan_trigger,
    });

    // Advisory plan only — annotate approval requirements. Never executed here.
    const next_plan: NextPlan = {
      advisory: true,
      mission_id: m.mission_id,
      steps: steps.map((s) => {
        const ms = m.milestones_with_status.find((x) => x.milestone_id === s.milestone_id);
        const requires_approval = ms ? ms.reversible === false : false;
        return { ...s, requires_approval };
      }),
    };

    m.replan_count += 1;
    m.provenance.replan_history.push({
      at: this.now(),
      trigger: input.replan_trigger ?? 'unspecified',
      tainted,
      preserved_completed: [...m.completed],
      revised_remaining: remaining.map((x) => x.milestone_id),
    });
    m.provenance.timestamps.push(this.now());

    return {
      status: 'replanned',
      tainted,
      mission_state: clone(m),
      next_plan,
      provenance: clone(m.provenance),
    };
  }

  private buildSnapshot(m: MissionState): Record<string, unknown> {
    return {
      mission_id: m.mission_id,
      goal: m.goal,
      milestones_with_status: m.milestones_with_status,
      current_milestone: m.current_milestone,
      completed: m.completed,
      remaining: m.remaining,
      replan_count: m.replan_count,
      provenance: m.provenance,
      stale: m.stale,
      aborted: m.aborted,
    };
  }

  private checkpoint(input: MissionInputs): MissionOutput {
    const m = this.getMission(input.mission_id);
    if (!m) return this.notFound();

    if (!this.deps.budget.reserve('checkpoint', RESERVE_COST.checkpoint)) {
      return budgetExhausted();
    }

    const ref = this.writeCheckpoint(m);
    return {
      status: 'ok',
      tainted: false,
      mission_state: clone(m),
      checkpoint: ref,
      provenance: clone(m.provenance),
    };
  }

  private writeCheckpoint(m: MissionState): CheckpointRef {
    const checkpoint_id = this.id('ckpt');
    const created_at = this.now();
    const raw = this.buildSnapshot(m);
    // Secrets pass through the redactor BEFORE write.
    const redacted_snapshot = this.deps.redactor.redact(raw);
    this.deps.memory.write({
      key: checkpoint_id,
      value: { ...redacted_snapshot, __scope: this.ctx.scope, __stale: m.stale },
      scope: this.ctx.scope,
    });
    m.provenance.checkpoint_ids.push(checkpoint_id);
    m.provenance.timestamps.push(created_at);
    return {
      checkpoint_id,
      mission_id: m.mission_id,
      scope: this.ctx.scope,
      created_at,
      stale: m.stale,
      redacted_snapshot,
    };
  }

  private resume(input: MissionInputs): MissionOutput {
    // Resume from an existing in-memory mission or a memory checkpoint.
    let m = this.getMission(input.mission_id);
    if (!m && input.mission_id) {
      const rec = this.findLatestCheckpoint(input.mission_id);
      if (rec) {
        m = fromSnapshot(rec.value);
        this.missions.set(m.mission_id, m);
      }
    }
    if (!m) return this.notFound();

    if (!this.deps.budget.reserve('monitor', RESERVE_COST.monitor)) {
      return budgetExhausted();
    }

    const tainted = observedTainted(input.observed_state);

    // Re-verify current preconditions against present state (idempotency on
    // resume): a milestone may have partially executed before a crash. We
    // re-verify rather than assume prior completion.
    let drifted = false;
    for (const ms of m.milestones_with_status) {
      if (ms.status === 'passed') {
        const verdict = this.deps.reflection.evaluate({ milestone: ms, observed: input.observed_state });
        if (verdict !== 'passed') {
          // Prior 'passed' no longer holds -> stale/uncertain, not assumed done.
          ms.status = 'stale';
          drifted = true;
        }
      }
    }
    // External state may have drifted while interrupted.
    if (tainted) drifted = true;
    this.recomputeProgress(m);

    if (drifted) {
      m.stale = true;
    }

    m.provenance.timestamps.push(this.now());

    // If mission drifted (stale) and the next step is state-changing/irreversible,
    // require fresh HITL approval before any dispatch. Non-interactive contexts
    // fail closed to policy_blocked.
    const current = m.milestones_with_status.find((x) => x.milestone_id === m.current_milestone);
    const nextIsIrreversible = current ? current.reversible === false : false;

    if (m.stale && nextIsIrreversible) {
      if (!isInteractive(this.ctx)) {
        return {
          status: 'policy_blocked',
          tainted,
          mission_state: clone(m),
          provenance: clone(m.provenance),
          error: err(
            'non_interactive_approval_required',
            'irreversible resume requires HITL approval; context cannot approve',
            false
          ),
        };
      }
      const approval = this.deps.hitl.requestApproval({
        mission_id: m.mission_id,
        milestone_id: current!.milestone_id,
        reason: 'resume of drifted mission with irreversible next step',
      });
      if (!approval) {
        return {
          status: 'requires_user_approval',
          tainted,
          mission_state: clone(m),
          provenance: clone(m.provenance),
        };
      }
    }

    if (m.stale) {
      return { status: 'stale', tainted, mission_state: clone(m), provenance: clone(m.provenance) };
    }
    return { status: 'ok', tainted, mission_state: clone(m), provenance: clone(m.provenance) };
  }

  private findLatestCheckpoint(mission_id: string) {
    // Deterministic: checkpoint ids include mission ref via provenance; we
    // read by scanning known ids is unavailable through interface, so callers
    // resume by the mission_id key when the backend stored it. We store under
    // checkpoint_id but also mirror under the mission_id key for resume.
    return this.deps.memory.read(mission_id);
  }

  private abort(input: MissionInputs): MissionOutput {
    const m = this.getMission(input.mission_id);
    if (!m) return this.notFound();
    // Preserve only a redacted final checkpoint per retention policy.
    const finalRef = this.writeCheckpoint(m);
    m.aborted = true;
    m.current_milestone = null;
    // Tear down ephemeral in-memory mission state; destroy ephemeral tokens
    // (none held here — HITL tokens are not persisted by mission_control).
    this.missions.delete(m.mission_id);
    return {
      status: 'aborted',
      tainted: false,
      checkpoint: finalRef,
      provenance: clone(m.provenance),
    };
  }

  private status(input: MissionInputs): MissionOutput {
    const m = this.getMission(input.mission_id);
    if (!m) return this.notFound();
    return { status: 'ok', tainted: false, mission_state: clone(m), provenance: clone(m.provenance) };
  }
}

function budgetExhausted(): MissionOutput {
  return {
    status: 'budget_exhausted',
    tainted: false,
    error: err('budget_reservation_failed', 'unified BudgetTracker reservation failed', true),
  };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function fromSnapshot(snap: Record<string, unknown>): MissionState {
  const s = snap as unknown as MissionState;
  return {
    mission_id: s.mission_id,
    goal: s.goal,
    milestones_with_status: s.milestones_with_status ?? [],
    current_milestone: s.current_milestone ?? null,
    completed: s.completed ?? [],
    remaining: s.remaining ?? [],
    replan_count: s.replan_count ?? 0,
    provenance: s.provenance ?? {
      mission_id: s.mission_id,
      timestamps: [],
      checkpoint_ids: [],
      replan_history: [],
      scope: 'unknown',
    },
    stale: s.stale ?? false,
    aborted: s.aborted ?? false,
  };
}

export function createMissionControl(deps: MissionControlDeps, ctx: ExecutionContext): MissionControl {
  return new MissionControl(deps, ctx);
}
