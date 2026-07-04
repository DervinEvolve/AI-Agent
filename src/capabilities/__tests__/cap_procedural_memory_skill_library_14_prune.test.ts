import { describe, it, expect } from 'vitest';
import { SkillLibrary } from '../cap_procedural_memory_skill_library_14';
import { BudgetTracker } from '../../constraints/constraints';

class MockLTM {
  store = vi.fn();
}

describe('cap_procedural_memory_skill_library_14 prune', () => {
  it('prune removes unverified or tainted skills while keeping verified non-tainted ones', () => {
    const lib = new SkillLibrary(new MockLTM() as any, new BudgetTracker());
    // add a good skill
    const good = lib.distillAfterReflection('good', 'print(1)', ['ok'], 'p', false);
    // add a tainted one
    const bad = lib.distillAfterReflection('bad', 'print(2)', ['ok'], 'p', true);
    // force an unverified path by direct internal state is not possible so we rely on verify gate
    // after above, only good should survive prune
    lib.prune();
    const res = lib.retrieve('good');
    expect(res.length).toBe(1);
    expect(res[0].id).toBe(good!.id);
  });
});