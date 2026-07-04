import { BudgetTracker } from '../constraints/constraints';
import type { LongTermMemory } from './cap_long_term_memory_3';

export interface Skill {
  id: string;
  name: string;
  code: string;
  provenance: string;
  tainted: boolean;
  verified: boolean;
  successMetrics: Record<string, number>;
  lastUsed?: number;
}

export class SkillLibrary {
  private skills: Map<string, Skill> = new Map();
  private memory: LongTermMemory;
  private budget: BudgetTracker;

  constructor(memory: LongTermMemory, budget: BudgetTracker) {
    this.memory = memory;
    this.budget = budget;
  }

  distillAfterReflection(
    taskGoal: string,
    code: string,
    successCriteria: string[],
    provenance: string,
    tainted: boolean
  ): Skill | null {
    // gated: only after explicit reflection (simulated by caller)
    const verified = this.verify(code, successCriteria);
    if (!verified) return null;
    const skill: Skill = {
      id: 'skill_' + Date.now(),
      name: taskGoal.slice(0, 32),
      code,
      provenance,
      tainted,
      verified: true,
      successMetrics: { executions: 0 },
    };
    if (tainted) skill.tainted = true;
    this.skills.set(skill.id, skill);
    this.memory.store(skill);
    return skill;
  }

  private verify(code: string, criteria: string[]): boolean {
    // reuses sandbox/controller concepts via code exec simulation
    return criteria.length > 0 && !code.includes('eval');
  }

  retrieve(query: string): Skill[] {
    return Array.from(this.skills.values()).filter(
      (s) => s.verified && !s.tainted && (s.name.includes(query) || s.provenance.includes(query))
    );
  }

  execute(skillId: string, args: any[]): any {
    const skill = this.skills.get(skillId);
    if (!skill || !skill.verified || skill.tainted) throw new Error('unauthorized');
    this.budget.consume(1);
    skill.successMetrics.executions!++;
    return 'executed';
  }

  prune() {
    for (const [id, s] of this.skills) {
      if (!s.verified || s.tainted) this.skills.delete(id);
    }
  }
}

export const cap_procedural_memory_skill_library_14 = {
  id: 'cap_procedural_memory_skill_library_14',
  name: 'Verified procedural skill library',
  status: 'active',
  // ...rest of spec
};
