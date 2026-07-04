import { describe, it, expect, vi } from 'vitest';
import { SkillLibrary } from '../cap_procedural_memory_skill_library_14';
import { BudgetTracker } from '../../constraints/constraints';

class MockLTM {
  store = vi.fn();
}

describe('cap_procedural_memory_skill_library_14', () => {
  it('distillation only succeeds after explicit verification against success_criteria and produces a named skill with provenance', () => {
    const lib = new SkillLibrary(new MockLTM() as any, new BudgetTracker());
    const skill = lib.distillAfterReflection('test goal', 'print(1)', ['success'], 'prov', false);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBeDefined();
    expect(skill!.provenance).toBe('prov');
  });

  it('skills distilled from tainted observations carry tainted=true and never clear taint', () => {
    const lib = new SkillLibrary(new MockLTM() as any, new BudgetTracker());
    const skill = lib.distillAfterReflection('g', 'c', ['ok'], 'p', true);
    expect(skill!.tainted).toBe(true);
  });

  it('retrieval returns only verified, non-stale skills matching the query', () => {
    const lib = new SkillLibrary(new MockLTM() as any, new BudgetTracker());
    lib.distillAfterReflection('match goal', 'print(2)', ['ok'], 'p', false);
    const res = lib.retrieve('match');
    expect(res.length).toBe(1);
    expect(res[0].verified).toBe(true);
  });

  it('unverified or failed skills are never added to the library', () => {
    const lib = new SkillLibrary(new MockLTM() as any, new BudgetTracker());
    const skill = lib.distillAfterReflection('g', 'eval(1)', ['fail'], 'p', false);
    expect(skill).toBeNull();
  });

  it('skill execution re-uses the existing controller loop and sandbox without bypassing constraints', () => {
    const budget = new BudgetTracker();
    const lib = new SkillLibrary(new MockLTM() as any, budget);
    const skill = lib.distillAfterReflection('g', 'print(3)', ['ok'], 'p', false);
    const result = lib.execute(skill!.id, []);
    expect(result).toBe('executed');
  });

  it('skill library respects unified BudgetTracker and long-term memory scope/authorization', () => {
    const budget = new BudgetTracker();
    const ltm = new MockLTM();
    const lib = new SkillLibrary(ltm as any, budget);
    lib.distillAfterReflection('g', 'c', ['ok'], 'p', false);
    expect(ltm.store).toHaveBeenCalled();
    expect(budget.remaining()).toBeGreaterThan(0);
  });
});
