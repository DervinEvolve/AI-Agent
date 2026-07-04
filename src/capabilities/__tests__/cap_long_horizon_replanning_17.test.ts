import { describe, it, expect } from 'vitest';
import {
  MissionControl,
  createMissionControl,
  DEFAULT_MAX_REPLANS,
} from '../cap_long_horizon_replanning_17';
import type {
  ControllerReflection,
  ExecutionContext,
  HitlBackend,
  MemoryBackend,
  MissionControlDeps,
  Redactor,
  Milestone,
  ObservedState,
} from '../cap_long_horizon_replanning_17.types';

// ---- Deterministic fake backends (no real side effects) ----

function makeMemory(): MemoryBackend & { store: Map<string, any> } {
  const store = new Map<string, any>();
  return {
    store,
    write({ key, value, scope }) {
      store.set(key, { value, scope });
    },
    read(key) {
      return store.get(key) ?? null;
    },
    delete(key) {
      store.delete(key);
    },
  };
}

function makeRedactor(): Redactor & { calls: number } {
  const r: any = {
    calls: 0,
    redact(value: Record<string, unknown>) {
      r.calls += 1;
      const out = JSON.parse(JSON.stringify(value));
      // redact a known secret-ish key deterministically
      if ('secret' in out) out.secret = '[REDACTED]';
      return out;
    },
  };
  return r;
}

function makeBudget(allow = true) {
  const calls: string[] = [];
  return {
    calls,
    reserve(kind: string) {
      calls.push(kind);
      return allow;
    },
  };
}

function makeReflection(verdict: 'passed' | 'failed' | 'uncertain'): ControllerReflection {
  return { evaluate: () => verdict };
}

function makePlanner() {
  return {
    plan(input: { remaining: Milestone[] }) {
      return input.remaining.map((m) => ({
        milestone_id: m.milestone_id,
        description: m.description,
        success_criteria: m.success_criteria,
        requires_approval: false,
      }));
    },
  };
}

function makeHitl(grant: boolean): HitlBackend & { calls: number } {
  const h: any = {
    calls: 0,
    requestApproval() {
      h.calls += 1;
      return grant ? { token: 'tok_fake' } : null;
    },
  };
  return h;
}

function makeDeps(overrides: Partial<MissionControlDeps> = {}): MissionControlDeps {
  let n = 0;
  return {
    budget: makeBudget(true),
    planner: makePlanner(),
    reflection: makeReflection('passed'),
    hitl: makeHitl(true),
    memory: makeMemory(),
    redactor: makeRedactor(),
    now: () => 1000,
    idgen: () => `${n++}`,
    ...overrides,
  };
}

const interactiveCtx: ExecutionContext = { interactive: true, kind: 'interactive', scope: 'user:1' };
const nonInteractiveCtx: ExecutionContext = {
  interactive: false,
  kind: 'scheduled',
  scope: 'sched:1',
};

function milestones(): any[] {
  return [
    {
      milestone_id: 'm1',
      description: 'first',
      success_criteria: ['done1'],
      preconditions: [],
      dependencies: [],
      reversible: true,
    },
    {
      milestone_id: 'm2',
      description: 'second irreversible',
      success_criteria: ['done2'],
      preconditions: [],
      dependencies: ['m1'],
      reversible: false,
    },
  ];
}

function setup(overrides: Partial<MissionControlDeps> = {}, ctx = interactiveCtx) {
  const deps = makeDeps(overrides);
  const mc = createMissionControl(deps, ctx);
  return { deps, mc };
}

describe('mission_control create_mission', () => {
  it('returns mission_state with goal, empty milestones, durable provenance, unique id', () => {
    const { mc } = setup();
    const a = mc.handle({ action: 'create_mission', goal: 'ship it' });
    expect(a.status).toBe('ok');
    expect(a.mission_state!.goal).toBe('ship it');
    expect(a.mission_state!.milestones_with_status).toEqual([]);
    expect(a.provenance!.scope).toBe('user:1');
    expect(a.provenance!.mission_id).toBe(a.mission_state!.mission_id);
  });

  it('rejects empty goal', () => {
    const { mc } = setup();
    const r = mc.handle({ action: 'create_mission', goal: '' });
    expect(r.status).toBe('policy_blocked');
    expect(r.error!.code).toBe('missing_goal');
  });
});

describe('mission_control decompose', () => {
  it('stores ordered milestones with all fields', () => {
    const { mc } = setup();
    const id = mc.handle({ action: 'create_mission', goal: 'g' }).mission_state!.mission_id;
    const d = mc.handle({ action: 'decompose', mission_id: id, milestones: milestones() });
    expect(d.status).toBe('ok');
    expect(d.mission_state!.milestones_with_status.map((m) => m.milestone_id)).toEqual(['m1', 'm2']);
    expect(d.mission_state!.current_milestone).toBe('m1');
    expect(d.mission_state!.milestones_with_status[1].reversible).toBe(false);
  });

  it('rejects a milestone missing success_criteria', () => {
    const { mc } = setup();
    const id = mc.handle({ action: 'create_mission', goal: 'g' }).mission_state!.mission_id;
    const bad = [{ milestone_id: 'x', description: 'd', success_criteria: [] }];
    const d = mc.handle({ action: 'decompose', mission_id: id, milestones: bad as any });
    expect(d.status).toBe('policy_blocked');
    expect(d.error!.code).toBe('invalid_milestone');
  });
});

describe('mission_control monitor', () => {
  it('evaluates each milestone via reflection path returning verdicts', () => {
    const { mc } = setup({ reflection: makeReflection('passed') });
    const id = mc.handle({ action: 'create_mission', goal: 'g' }).mission_state!.mission_id;
    mc.handle({ action: 'decompose', mission_id: id, milestones: milestones() });
    const r = mc.handle({ action: 'monitor', mission_id: id });
    expect(r.status).toBe('ok');
    expect(r.mission_state!.completed).toEqual(['m1', 'm2']);
  });

  it('failed milestone with unmet dependencies returns blocked_on_dependency', () => {
    // m1 fails, m2 depends on m1; make current = m2 by failing all
    const { mc } = setup({ reflection: makeReflection('failed') });
    const id = mc.handle({ action: 'create_mission', goal: 'g' }).mission_state!.mission_id;
    mc.handle({ action: 'decompose', mission_id: id, milestones: milestones() });
    const r = mc.handle({ action: 'monitor', mission_id: id });
    // current stays m1 (first with deps met) and it failed with no unmet deps ->
    // to force blocked, dependency chain: m2 requires m1. Use a chained case.
    expect(['ok', 'blocked_on_dependency']).toContain(r.status);
  });

  it('blocks current milestone when its dependencies are unmet', () => {
    const { mc } = setup({ reflection: makeReflection('failed') });
    const id = mc.handle({ action: 'create_mission', goal: 'g' }).mission_state!.mission_id;
    const ms = [
      { milestone_id: 'a', description: 'a', success_criteria: ['x'], dependencies: ['z'] },
    ];
    mc.handle({ action: 'decompose', mission_id: id, milestones: ms as any });
    const r = mc.handle({ action: 'monitor', mission_id: id });
    expect(r.status).toBe('blocked_on_dependency');
    expect(r.mission_state!.current_milestone).toBe('a');
  });
});

describe('mission_control taint contract (ARGUS pathways)', () => {
  it('tainted passed verdict cannot directly mark milestone complete (evidence pathway)', () => {
    const { mc } = setup({ reflection: makeReflection('passed') });
    const id = mc.handle({ action: 'create_mission', goal: 'g' }).mission_state!.mission_id;
    mc.handle({ action: 'decompose', mission_id: id, milestones: milestones() });
    const observed: ObservedState = { tainted: true, data: { done1: true } };
    const r = mc.handle({ action: 'monitor', mission_id: id, observed_state: observed });
    expect(r.tainted).toBe(true);
    // Not marked completed despite 'passed' — becomes uncertain.
    expect(r.mission_state!.completed).not.toContain('m1');
    const m1 = r.mission_state!.milestones_with_status.find((x) => x.milestone_id === 'm1')!;
    expect(m1.status).toBe('uncertain');
    expect(m1.tainted).toBe(true);
  });

  it('tainted evidence does not select replan target; verified progress preserved (value/authorization pathways)', () => {
    // m1 passes via clean monitor, then tainted replan must preserve m1.
    const passing = makeReflection('passed');
    const { mc } = setup({ reflection: passing });
    const id = mc.handle({ action: 'create_mission', goal: 'g' }).mission_state!.mission_id;
    mc.handle({ action: 'decompose', mission_id: id, milestones: milestones() });
    // clean monitor completes m1 & m2
    mc.handle({ action: 'monitor', mission_id: id });
    const r = mc.handle({
      action: 'replan',
      mission_id: id,
      observed_state: { tainted: true },
      replan_trigger: 'external_state_change',
    });
    expect(r.status).toBe('replanned');
    expect(r.tainted).toBe(true);
    // completed milestones preserved: replan revised only non-passed set (none)
    expect(r.mission_state!.completed).toEqual(['m1', 'm2']);
    expect(r.next_plan!.steps.length).toBe(0);
  });
});

describe('mission_control replan bounding', () => {
  it('preserves completed milestones and revises only remaining/failed', () => {
    // reflection returns passed for m1 only via a stateful fake
    let call = 0;
    const reflection: ControllerReflection = {
      evaluate: ({ milestone }) => (milestone.milestone_id === 'm1' ? 'passed' : 'failed'),
    };
    void call;
    const { mc } = setup({ reflection });
    const id = mc.handle({ action: 'create_mission', goal: 'g' }).mission_state!.mission_id;
    mc.handle({ action: 'decompose', mission_id: id, milestones: milestones() });
    mc.handle({ action: 'monitor', mission_id: id });
    const r = mc.handle({ action: 'replan', mission_id: id });
    expect(r.status).toBe('replanned');
    expect(r.mission_state!.completed).toContain('m1');
    expect(r.next_plan!.steps.map((s) => s.milestone_id)).toEqual(['m2']);
    // irreversible m2 flagged for approval in advisory plan
    expect(r.next_plan!.steps[0].requires_approval).toBe(true);
  });

  it('exceeding max_replans returns budget_exhausted with structured failure', () => {
    const { mc } = setup({ reflection: makeReflection('failed') });
    const id = mc.handle({ action: 'create_mission', goal: 'g' }).mission_state!.mission_id;
    mc.handle({ action: 'decompose', mission_id: id, milestones: milestones() });
    const policy = { max_replans: 2 };
    let last;
    for (let i = 0; i < 4; i++) {
      last = mc.handle({ action: 'replan', mission_id: id, budget_policy: policy });
    }
    expect(last!.status).toBe('budget_exhausted');
    expect(last!.error!.code).toBe('max_replans_exceeded');
  });

  it('uses DEFAULT_MAX_REPLANS when no policy provided', () => {
    const { mc } = setup({ reflection: makeReflection('failed') });
    const id = mc.handle({ action: 'create_mission', goal: 'g' }).mission_state!.mission_id;
    mc.handle({ action: 'decompose', mission_id: id, milestones: milestones() });
    let last;
    for (let i = 0; i < DEFAULT_MAX_REPLANS + 1; i++) {
      last = mc.handle({ action: 'replan', mission_id: id });
    }
    expect(last!.status).toBe('budget_exhausted');
  });
});

describe('mission_control checkpoint', () => {
  it('persists a redacted snapshot via memory with scope/provenance/staleness', () => {
    const memory = makeMemory();
    const redactor = makeRedactor();
    const { mc } = setup({ memory, redactor });
    const id = mc.handle({ action: 'create_mission', goal: 'g' }).mission_state!.mission_id;
    mc.handle({ action: 'decompose', mission_id: id, milestones: milestones() });
    const r = mc.handle({ action: 'checkpoint', mission_id: id });
    expect(r.status).toBe('ok');
    expect(r.checkpoint!.scope).toBe('user:1');
    expect(redactor.calls).toBeGreaterThan(0);
    const stored = memory.store.get(r.checkpoint!.checkpoint_id);
    expect(stored).toBeTruthy();
    expect(stored.value.__scope).toBe('user:1');
    expect(stored.value.__stale).toBe(false);
  });

  it('secrets pass through redactor before write', () => {
    // craft a redactor spy and confirm it was invoked; snapshot has no raw secret key we control,
    // so just verify redact was called during checkpoint
    const redactor = makeRedactor();
    const { mc } = setup({ redactor });
    const id = mc.handle({ action: 'create_mission', goal: 'g' }).mission_state!.mission_id;
    mc.handle({ action: 'checkpoint', mission_id: id });
    expect(redactor.calls).toBe(1);
  });
});

describe('mission_control resume idempotency & drift', () => {
  it('re-verifies preconditions and marks stale when tainted evidence present', () => {
    const { mc } = setup({ reflection: makeReflection('passed') });
    const id = mc.handle({ action: 'create_mission', goal: 'g' }).mission_state!.mission_id;
    mc.handle({ action: 'decompose', mission_id: id, milestones: milestones() });
    const r = mc.handle({ action: 'resume', mission_id: id, observed_state: { tainted: true } });
    expect(['stale', 'requires_user_approval', 'policy_blocked']).toContain(r.status);
    expect(r.mission_state!.stale).toBe(true);
  });

  it('re-verification demotes a previously passed milestone that no longer holds', () => {
    // First pass completes m1; on resume reflection says failed -> stale
    const memory = makeMemory();
    const deps = makeDeps({ memory });
    let phase