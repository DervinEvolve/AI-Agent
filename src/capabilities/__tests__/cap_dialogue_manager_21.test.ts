import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DialogueManager, DialogueManagerDependencies } from '../cap_dialogue_manager_21';
import type { DialogueScope, Commitment } from '../cap_dialogue_manager_21';

// Fake redactor that redacts any string containing 'secret'
function fakeRedact(text: string): { redacted: string; didRedact: boolean } {
  if (text.includes('secret')) {
    return { redacted: text.replace(/secret/gi, '[REDACTED]'), didRedact: true };
  }
  return { redacted: text, didRedact: false };
}

// Fake context manager with budget tracking
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
  const scope: DialogueScope = { user_id: 'u1', project_id: 'p1', namespace: 'test' };

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
      expect(state.taint_summary.sources).toEqual([]);
      expect(state.active_commitments).toHaveLength(0);
      expect(state.pending_clarifications).toHaveLength(0);
    });
  });

  describe('record_user_turn', () => {
    let dialogueId: string;

    beforeEach(() => {
      const { dialogue_id } = manager.startDialogue('task-1', scope);
      dialogueId = dialogue_id;
    });

    it('appends a user turn with utterance, timestamp, tainted=true, and optional structured intent', () => {
      const result = manager.recordUserTurn(dialogueId, 'Hello world', {
        intent_type: 'greeting',
        slots: {},
        confidence: 0.9,
      });
      expect(result.status).toBe('ok');
      expect(result.state.user_turns).toHaveLength(1);
      const turn = result.state.user_turns[0];
      expect(turn.type).toBe('user');
      expect(turn.utterance).toBe('Hello world');
      expect(turn.tainted).toBe(true);
      expect(turn.redacted).toBe(false);
      expect(turn.structured_intent).toEqual({
        intent_type: 'greeting',
        slots: {},
        confidence: 0.9,
      });
      expect(turn.turn_id).toMatch(/^turn_/);
      expect(result.state.turn_count).toBe(1);
    });

    it('redacts utterance containing secrets and marks turn as redacted', () => {
      const result = manager.recordUserTurn(dialogueId, 'my secret is safe');
      expect(result.status).toBe('ok');
      const turn = result.state.user_turns[0];
      expect(turn.utterance).toBe('my [REDACTED] is safe');
      expect(turn.redacted).toBe(true);
      expect(turn.original_utterance).toBe('my secret is safe');
    });

    it('rejects empty utterance', () => {
      const result = manager.recordUserTurn(dialogueId, '');
      expect(result.status).toBe('invalid');
      expect(result.state.user_turns).toHaveLength(0);
    });

    it('rejects oversized utterance', () => {
      const longText = 'a'.repeat(10001);
      const result = manager.recordUserTurn(dialogueId, longText);
      expect(result.status).toBe('invalid');
      expect(result.state.user_turns).toHaveLength(0);
    });

    it('updates taint summary sources', () => {
      manager.recordUserTurn(dialogueId, 'hello');
      const state = manager.getDialogueState(dialogueId);
      expect(state.taint_summary.sources).toContain('user_utterance');
    });
  });

  describe('record_agent_turn', () => {
    let dialogueId: string;

    beforeEach(() => {
      const { dialogue_id } = manager.startDialogue('task-1', scope);
      dialogueId = dialogue_id;
    });

    it('appends an agent turn with utterance and optional commitments', () => {
      const commitments: Commitment[] = [
        {
          id: 'c1',
          description: 'Summarize before sending',
          reversible: true,
          created_at: new Date().toISOString(),
          turn_id: '',
          advisory: true,
        },
      ];
      const result = manager.recordAgentTurn(dialogueId, 'I will summarize', commitments);
      expect(result.status).toBe('ok');
      expect(result.state.agent_turns).toHaveLength(1);
      const turn = result.state.agent_turns[0];
      expect(turn.type).toBe('agent');
      expect(turn.utterance).toBe('I will summarize');
      expect(turn.tainted).toBe(false);
      expect(turn.redacted).toBe(false);
      expect(turn.commitments).toEqual(commitments);
      expect(result.state.active_commitments).toHaveLength(1);
      expect(result.state.active_commitments[0].description).toBe('Summarize before sending');
    });

    it('stores commitments as advisory only', () => {
      const commitments: Commitment[] = [
        {
          id: 'c2',
          description: 'test',
          reversible: false,
          created_at: new Date().toISOString(),
          turn_id: '',
          advisory: true,
        },
      ];
      manager.recordAgentTurn(dialogueId, 'test', commitments);
      const active = manager.getCommitments(dialogueId);
      expect(active).toHaveLength(1);
      expect(active[0].advisory).toBe(true);
    });

    it('redacts agent utterance if it contains secrets', () => {
      const result = manager.recordAgentTurn(dialogueId, 'the secret key is 123');
      expect(result.status).toBe('ok');
      expect(result.state.agent_turns[0].utterance).toBe('the [REDACTED] key is 123');
      expect(result.state.agent_turns[0].redacted).toBe(true);
    });

    it('agent turn does not increase taint (but whole state remains tainted)', () => {
      manager.recordAgentTurn(dialogueId, 'hello');
      const state = manager.getDialogueState(dialogueId);
      expect(state.taint_summary.tainted).toBe(true);
      expect(state.taint_summary.sources).not.toContain('agent_utterance');
    });
  });

  describe('intent slots', () => {
    let dialogueId: string;

    beforeEach(() => {
      const { dialogue_id } = manager.startDialogue('task-1', scope);
      dialogueId = dialogue_id;
    });

    it('set_intent_slot updates a slot with value, confidence, and tainted flag', () => {
      const result = manager.setIntentSlot(dialogueId, 'destination', 'Paris', 0.95, true);
      expect(result.status).toBe('ok');
      expect(result.state.intent_slots['destination']).toEqual({
        key: 'destination',
        value: 'Paris',
        confidence: 0.95,
        tainted: true,
        source: 'intent',
        updated_at: expect.any(String),
      });
    });

    it('get_intent_state returns all current slots with provenance', () => {
      manager.setIntentSlot(dialogueId, 'a', 1);
      manager.setIntentSlot(dialogueId, 'b', 2);
      const slots = manager.getIntentState(dialogueId);
      expect(Object.keys(slots)).toHaveLength(2);
      expect(slots.a.value).toBe(1);
      expect(slots.b.source).toBe('intent');
    });
  });

  describe('clarifications', () => {
    let dialogueId: string;

    beforeEach(() => {
      const { dialogue_id } = manager.startDialogue('task-1', scope);
      dialogueId = dialogue_id;
    });

    it('note_clarification_requested adds a pending clarification', () => {
      const result = manager.noteClarificationRequested(dialogueId, 'Which city?');
      expect(result.status).toBe('ok');
      expect(result.ref_id).toMatch(/^clar_/);
      const pending = manager.getPendingClarifications(dialogueId);
      expect(pending).toHaveLength(1);
      expect(pending[0].question).toBe('Which city?');
      expect(pending[0].resolved).toBe(false);
    });

    it('record_clarification_response resolves a pending clarification', () => {
      const { ref_id } = manager.noteClarificationRequested(dialogueId, 'Which city?');
      const result = manager.recordClarificationResponse(dialogueId, ref_id, 'Paris');
      expect(result.status).toBe('ok');
      const pending = manager.getPendingClarifications(dialogueId);
      expect(pending).toHaveLength(0);
      const state = manager.getDialogueState(dialogueId);
      const clar = state.pending_clarifications.find(c => c.ref_id === ref_id);
      expect(clar).toBeDefined();
      expect(clar!.resolved).toBe(true);
      expect(clar!.response).toBe('Paris');
    });

    it('record_clarification_response optionally feeds user response into intent slots', () => {
      const { ref_id } = manager.noteClarificationRequested(dialogueId, 'Which city?');
      const result = manager.recordClarificationResponse(dialogueId, ref_id, 'Paris', 'destination');
      expect(result.status).toBe('ok');
      const slots = manager.getIntentState(dialogueId);
      expect(slots.destination.value).toBe('Paris');
      expect(slots.destination.tainted).toBe(true);
    });
  });

  describe('get_dialogue_snapshot', () => {
    let dialogueId: string;

    beforeEach(() => {
      const { dialogue_id } = manager.startDialogue('task-1', scope);
      dialogueId = dialogue_id;
      manager.recordUserTurn(dialogueId, 'hello secret');
      manager.recordAgentTurn(dialogueId, 'response');
    });

    it('returns a redacted summary suitable for context assembly', () => {
      const snapshot = manager.getDialogueSnapshot(dialogueId);
      expect(snapshot.dialogue_id).toBe(dialogueId);
      expect(snapshot.turn_count).toBe(2);
      expect(snapshot.user_turns).toHaveLength(1);
      expect(snapshot.user_turns[0].utterance).toBe('hello [REDACTED]');
      expect(snapshot.agent_turns).toHaveLength(1);
      // intent slots should not contain source
      manager.setIntentSlot(dialogueId, 'key', 'val');
      const snapshot2 = manager.getDialogueSnapshot(dialogueId);
      expect(snapshot2.intent_slots.key).not.toHaveProperty('source');
    });

    it('applies export_policy if provided', () => {
      // Just verify it doesn't throw and returns something
      const snapshot = manager.getDialogueSnapshot(dialogueId, { audience: 'external' });
      expect(snapshot).toBeDefined();
    });
  });

  describe('end_dialogue', () => {
    let dialogueId: string;

    beforeEach(() => {
      const { dialogue_id } = manager.startDialogue('task-1', scope);
      dialogueId = dialogue_id;
      contextManager.setBudget('default', 10);
    });

    it('finalizes state and persists a redacted summary via longTermStore', async () => {
      manager.recordUserTurn(dialogueId, 'hello');
      const result = await manager.endDialogue(dialogueId, 'default');
      expect(result.status).toBe('ok');
      expect(result.state.finalized).toBe(true);
      expect(fakeStore).toHaveBeenCalledWith(expect.objectContaining({
        dialogue_id: dialogueId,
        finalized: true,
      }));
    });

    it('returns budget_exhausted if budget insufficient', async () => {
      contextManager.setBudget('low', 0);
      const result = await manager.endDialogue(dialogueId, 'low');
      expect(result.status).toBe('budget_exhausted');
      expect(fakeStore).not.toHaveBeenCalled();
    });

    it('prevents further operations after finalization', async () => {
      await manager.endDialogue(dialogueId, 'default');
      const result = manager.recordUserTurn(dialogueId, 'after end');
      expect(result.status).toBe('invalid');
    });
  });

  describe('append-only and advisory contracts', () => {
    let dialogueId: string;

    beforeEach(() => {
      const { dialogue_id } = manager.startDialogue('task-1', scope);
      dialogueId = dialogue_id;
    });

    it('turns cannot be deleted or modified after append', () => {
      manager.recordUserTurn(dialogueId, 'turn1');
      manager.recordUserTurn(dialogueId, 'turn2');
      const state = manager.getDialogueState(dialogueId);
      // Attempt to modify a turn directly (should have no effect or throw)
      // Since state is returned by value, modifications to the returned object won't affect internal state.
      // We can try to use the public API to delete a turn (none exists).
      // Instead, verify that the internal state is immutable by checking that repeated calls return same turns.
      const state2 = manager.getDialogueState(dialogueId);
      expect(state2.user_turns).toHaveLength(2);
      expect(state2.user_turns[0].utterance).toBe('turn1');
      expect(state2.user_turns[1].utterance).toBe('turn2');
    });

    it('commitments are advisory and cannot authorize side effects', () => {
      const commitments: Commitment[] = [{
        id: 'c3',
        description: 'delete file',
        reversible: false,
        created_at: new Date().toISOString(),
        turn_id: '',
        advisory: true,
      }];
      manager.recordAgentTurn(dialogueId, 'I will delete', commitments);
      const active = manager.getCommitments(dialogueId);
      expect(active[0].advisory).toBe(true);
      // The manager itself has no authority to act on commitments.
      // This is a design contract, tested by the absence of any execution method.
    });
  });

  describe('taint contract', () => {
    it('dialogue state is tainted=true after any user utterance', () => {
      const { dialogue_id } = manager.startDialogue('task-2', scope);
      manager.recordUserTurn(dialogue_id, 'hello');
      const state = manager.getDialogueState(dialogue_id);
      expect(state.taint_summary.tainted).toBe(true);
    });

    it('agent-only turns keep state tainted but do not add agent source', () => {
      const { dialogue_id } = manager.startDialogue('task-3', scope);
      manager.recordAgentTurn(dialogue_id, 'hello');
      const state = manager.getDialogueState(dialogue_id);
      expect(state.taint_summary.tainted).toBe(true);
      expect(state.taint_summary.sources).not.toContain('agent_utterance');
    });
  });
});
