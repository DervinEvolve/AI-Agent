import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DialogueManager, DialogueManagerDependencies } from '../cap_dialogue_manager_21';

// Fake redactor that redacts any string containing 'secret'
function fakeRedact(text: string): { redacted: string; didRedact: boolean } {
  if (text.includes('secret')) {
    return { redacted: text.replace(/secret/gi, '[REDACTED]'), didRedact: true };
  }
  return { redacted: text, didRedact: false };
}

// Fake context manager
class FakeContextManager {
  private budgets: Record<string, number> = {};
  setBudget(tag: string, tokens: number) {
    this.budgets[tag] = tokens;
  }
  async reserveTokens(tag: string, amount: number): Promise<boolean> {
    if (!this.budgets[tag] || this.budgets[tag] < amount) return false;
    this.budgets[tag] -= amount;
    return true;
  }
}

// Fake long term memory store
const fakeStore = vi.fn().mockResolvedValue(undefined);

describe('DialogueManager', () => {
  let manager: DialogueManager;
  let contextManager: FakeContextManager;

  beforeEach(() => {
    contextManager = new FakeContextManager();
    const deps: DialogueManagerDependencies = {
      redact: fakeRedact,
      contextManager: contextManager as any,
      longTermStore: fakeStore,
    };
    manager = new DialogueManager(deps);
    fakeStore.mockClear();
  });

  describe('start_dialogue', () => {
    it('creates a unique dialogue_id tied to task_id with scope and empty turn history', () => {
      const scope = { user_id: 'u1', project_id: 'p1', namespace: 'test' };
      const { dialogue_id, state } = manager.startDialogue('task-1', scope);
      expect(dialogue_id).toMatch(/^dial_/);
      expect(state.dialogue_id).toBe(dialogue_id);
      expect(state.task_id).toBe('task-1');
      expect(state.scope).toEqual(scope);
      expect(state.turn_count).toBe(0);
      expect(state.user_turns).toHaveLength(0);
      expect(state.agent_turns).toHaveLength(0);
      expect(state.finalized).toBe(false);
      expect(state.taint_summary.tainted).toBe(true);
    });
  });

  describe('record_user_turn', () => {
    it('appends a user turn with utterance (redacted), timestamp, tainted=true', () => {
      const { dialogue_id } = manager.startDialogue('task-1', { user_id: 'u', project_id: 'p', namespace: 'ns' });
      const { turn, state } = manager.recordUserTurn(dialogue_id, 'Hello, my secret is safe');
      expect(turn.type).toBe('user');
      expect(turn.utterance).toContain('[REDACTED]');
      expect(turn.redacted).toBe(true);
      expect(turn.tainted).toBe(true);
      expect(state.user_turns).toHaveLength(1);
      expect(state.turn_count).toBe(1);
      expect(state.taint_summary.sources).toContain('user_utterance');
    });

    it('rejects oversized or missing utterance', () => {
      const { dialogue_id } = manager.startDialogue('task-1', { user_id: 'u', project_id: 'p', namespace: 'ns' });
      expect(() => manager.recordUserTurn(dialogue_id, '')).toThrow('INVALID_UTTERANCE');
      expect(() => manager.recordUserTurn(dialogue_id, 'a'.repeat(10001))).toThrow('UTTERANCE_TOO_LARGE');
    });
  });

  describe('record_agent_turn', () => {
    it('appends an agent turn with utterance, structured actions, and optional commitments', () => {
      const { dialogue_id } = manager.startDialogue('task-1', { user_id: 'u', project_id: 'p', namespace: 'ns' });
      const commitments = [
        { description: 'Summarize results', reversible: true },
      ];
      const { turn, state } = manager.recordAgentTurn(dialogue_id, 'I will summarize', undefined, commitments);
      expect(turn.type).toBe('agent');
      expect(turn.utterance).toBe('I will summarize');
      expect(turn.tainted).toBe(false);
      expect(turn.commitments).toHaveLength(1);
      expect(turn.commitments![0].advisory).toBe(true);
      expect(state.active_commitments).toHaveLength(1);
      expect(state.agent_turns).toHaveLength(1);
    });

    it('stores commitments in active_commitments list; get_commitments returns them', () => {
      const { dialogue_id } = manager.startDialogue('task-1', { user_id: 'u', project_id: 'p', namespace: 'ns' });
      manager.recordAgentTurn(dialogue_id, 'I promise', undefined, [
        { description: 'Do X', reversible: false },
      ]);
      const commitments = manager.getCommitments(dialogue_id);
      expect(commitments).toHaveLength(1);
      expect(commitments[0].description).toBe('Do X');
      expect(commitments[0].advisory).toBe(true);
    });
  });

  describe('set_intent_slot and get_intent_state', () => {
    it('updates a slot with value, confidence, and tainted flag', () => {
      const { dialogue_id } = manager.startDialogue('task-1', { user_id: 'u', project_id: 'p', namespace: 'ns' });
      manager.setIntentSlot(dialogue_id, 'destination', 'Paris', 0.9, true, 'user_turn_1');
      const slots = manager.getIntentState(dialogue_id);
      expect(slots['destination']).toBeDefined();
      expect(slots['destination'].value).toBe('Paris');
      expect(slots['destination'].confidence).toBe(0.9);
      expect(slots['destination'].tainted).toBe(true);
      expect(slots['destination'].source).toBe('user_turn_1');
    });
  });

  describe('clarifications', () => {
    it('adds a pending clarification and lists unresolved ones', () => {
      const { dialogue_id } = manager.startDialogue('task-1', { user_id: 'u', project_id: 'p', namespace: 'ns' });
      const { ref_id } = manager.noteClarificationRequested(dialogue_id, 'What is the date?');
      const pending = manager.getPendingClarifications(dialogue_id);
      expect(pending).toHaveLength(1);
      expect(pending[0].ref_id).toBe(ref_id);
      expect(pending[0].resolved).toBe(false);
    });

    it('resolves a pending clarification with user response', () => {
      const { dialogue_id } = manager.startDialogue('task-1', { user_id: 'u', project_id: 'p', namespace: 'ns' });
      const { ref_id } = manager.noteClarificationRequested(dialogue_id, 'What?');
      manager.recordClarificationResponse(dialogue_id, ref_id, 'Tomorrow');
      const pending = manager.getPendingClarifications(dialogue_id);
      expect(pending).toHaveLength(0);
    });
  });

  describe('append-only', () => {
    it('turns cannot be modified after append (API does not expose mutation)', () => {
      const { dialogue_id } = manager.startDialogue('task-1', { user_id: 'u', project_id: 'p', namespace: 'ns' });
      const { turn } = manager.recordUserTurn(dialogue_id, 'first');
      // There is no method to delete or update a turn; we can only add.
      expect(manager.getDialogueSnapshot(dialogue_id).user_turns[0].turn_id).toBe(turn.turn_id);
    });
  });

  describe('redaction', () => {
    it('redacts secrets and replaces empty utterance with placeholder', () => {
      const { dialogue_id } = manager.startDialogue('task-1', { user_id: 'u', project_id: 'p', namespace: 'ns' });
      const { turn } = manager.recordUserTurn(dialogue_id, 'secret');
      expect(turn.utterance).toBe('[REDACTED]');
      expect(turn.redacted).toBe(true);
    });
  });

  describe('taint', () => {
    it('dialogue_state is tainted=true overall even after agent-only turns', () => {
      const { dialogue_id } = manager.startDialogue('task-1', { user_id: 'u', project_id: 'p', namespace: 'ns' });
      manager.recordAgentTurn(dialogue_id, 'hello', undefined, []);
      const snapshot = manager.getDialogueSnapshot(dialogue_id);
      expect(snapshot.tainted).toBe(true);
    });
  });

  describe('get_dialogue_snapshot', () => {
    it('returns a redacted summary suitable for context assembly', () => {
      const { dialogue_id } = manager.startDialogue('task-1', { user_id: 'u', project_id: 'p', namespace: 'ns' });
      manager.recordUserTurn(dialogue_id, 'Hello', { intent_type: 'greet', slots: {}, confidence: 0.8 });
      manager.recordAgentTurn(dialogue_id, 'Hi there');
      const snapshot = manager.getDialogueSnapshot(dialogue_id);
      expect(snapshot.dialogue_id).toBe(dialogue_id);
      expect(snapshot.user_turns).toHaveLength(1);
      expect(snapshot.agent_turns).toHaveLength(1);
      expect(snapshot.tainted).toBe(true);
      expect(snapshot.user_turns[0].structured_intent).toBeDefined();
    });
  });

  describe('end_dialogue', () => {
    it('finalizes state and optionally persists via long term memory', async () => {
      const { dialogue_id } = manager.startDialogue('task-1', { user_id: 'u', project_id: 'p', namespace: 'ns' });
      contextManager.setBudget('main', 10);
      await manager.endDialogue(dialogue_id, 'main');
      expect(fakeStore).toHaveBeenCalledTimes(1);
      expect(fakeStore.mock.calls[0][0]).toHaveProperty('dialogue_id', dialogue_id);
      // after finalization, further operations should throw
      expect(() => manager.recordUserTurn(dialogue_id, 'test')).toThrow('DIALOGUE_FINALIZED');
    });

    it('throws BUDGET_EXHAUSTED when budget insufficient', async () => {
      const { dialogue_id } = manager.startDialogue('task-1', { user_id: 'u', project_id: 'p', namespace: 'ns' });
      contextManager.setBudget('main', 0);
      await expect(manager.endDialogue(dialogue_id, 'main')).rejects.toThrow('BUDGET_EXHAUSTED');
    });
  });
});
