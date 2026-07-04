import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DialogueManager,
  DialogueController,
  type HITLChannel,
  type DialogueResult,
} from '../beh_multi_turn_dialogue_grounding_21';

// A simple mock HITL channel
function mockHITLChannel(): HITLChannel {
  return {
    requestClarification: vi.fn().mockResolvedValue(undefined),
  };
}

// A mock context manager with addSnapshot method
function mockContextManager() {
  return {
    addSnapshot: vi.fn(),
  };
}

describe('Dialogue-grounded multi-turn interaction (beh_multi_turn_dialogue_grounding_21)', () => {
  let manager: DialogueManager;
  const immutableCriteria = ['answer the user question', 'never disable safety systems'];

  beforeEach(() => {
    manager = new DialogueManager(immutableCriteria);
  });

  // ------------------------------------------------------------
  // 1. Basic multi-turn, intent validation, continuation
  // ------------------------------------------------------------
  describe('controller uses dialogue_manager to start and continue a multi-turn task', () => {
    it('starts with a valid user turn and provides a validated intent', async () => {
      const controller = new DialogueController(manager);
      const result = await controller.handleTurn('search for the latest news', true);
      expect(result.ok).toBe(true);
      expect(result.validatedIntent).toBe('search');
    });

    it('continues with another turn and appends to history', async () => {
      const controller = new DialogueController(manager);
      await controller.handleTurn('search for the latest news', true);
      const result2 = await controller.handleTurn('summarize the findings', true);
      expect(result2.ok).toBe(true);
      expect(result2.validatedIntent).toBe('summarize');
      // Verify that the history contains both user turns
      const state = controller.getManager().state;
      const userTurns = state.history.filter((t) => t.speaker === 'user');
      expect(userTurns.length).toBe(2);
    });
  });

  // ------------------------------------------------------------
  // 2. Ambiguity → pending clarification + HITL (interactive / non‑interactive)
  // ------------------------------------------------------------
  describe('ambiguity leads to pending clarification and HITL request', () => {
    it('sets pending clarification and requests via hitl_channel when interactive', async () => {
      const hitl = mockHITLChannel();
      const controller = new DialogueController(manager, hitl);
      // Use an input that the default resolver cannot classify (triggers ambiguity)
      const result = await controller.handleTurn('blarg', true);

      expect(result.ok).toBe(false);
      expect(hitl.requestClarification).toHaveBeenCalledOnce();
      // The manager's state should now have a pending clarification
      const state = controller.getManager().state;
      expect(state.pendingClarification).not.toBeNull();
    });

    it('returns a structured failure with ambiguity flagged when non-interactive', async () => {
      const hitl = mockHITLChannel();
      const controller = new DialogueController(manager, hitl);
      const result = await controller.handleTurn('blarg', false); // non‑interactive

      expect(result.ok).toBe(false);
      // HITL must NOT be called in non-interactive mode
      expect(hitl.requestClarification).not.toHaveBeenCalled();
      // The result should indicate a policy block or ambiguity flag
      expect(result.reason).toMatch(/ambiguity|unresolved/i);
      // The pending clarification should still be present on the state
      const state = controller.getManager().state;
      expect(state.pendingClarification).not.toBeNull();
    });
  });

  // ------------------------------------------------------------
  // 3. Commitment tracking (record / retrieve / honor)
  // ------------------------------------------------------------
  describe('commitments recorded by agent in dialogue state are retrieved to ensure they are honored', () => {
    it('records a commitment when the user explicitly asks for a summary', async () => {
      const controller = new DialogueController(manager);
      await controller.handleTurn('please summarize before giving the final answer', true);
      const state = controller.getManager().state;
      // After a turn whose intent is "summarize" the manager should have recorded a commitment
      expect(state.commitments.length).toBeGreaterThan(0);
      expect(state.commitments.some(c => c.description.toLowerCase().includes('summar'))).toBe(true);
    });

    it('exposes unfulfilled commitments via checkCommitments() and they can be fulfilled later', async () => {
      // Simulate a sequence: user asks for a summary, then later asks for the final result.
      const controller = new DialogueController(manager);
      await controller.handleTurn('please summarize before giving the final answer', true);
      // After the first turn we should have an unfulfilled commitment
      const unfulfilled = manager.checkCommitments();
      expect(unfulfilled.length).toBeGreaterThan(0);

      // Now handle a second turn that could trigger fulfilment (agent decides to summarize)
      await controller.handleTurn('give me the final answer', true);
      // The controller's internal logic should mark the summary commitment as fulfilled
      const stateAfter = controller.getManager().state;
      const summaryCommitment = stateAfter.commitments.find(c => c.description.includes('summar'));
      expect(summaryCommitment?.fulfilled).toBe(true);
    });
  });

  // ------------------------------------------------------------
  // 4. Intent validation against immutable success criteria
  // ------------------------------------------------------------
  describe('dialogue-derived intent is validated against immutable success criteria before use', () => {
    it('rejects an intent that conflicts with immutable criteria', async () => {
      // Pre-load the manager with a custom resolver that yields a dangerous intent
      manager.setResolver({
        resolve: () => ({ intent: 'disable_safeties', confidence: 0.99 }),
      });
      const controller = new DialogueController(manager);
      const result = await controller.handleTurn('turn off all safety systems', true);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/safety|forbidden|invalid/i);
      // The validatedIntent field should not contain the dangerous intent
      expect(result.validatedIntent).toBeFalsy();
    });

    it('accepts an intent that is consistent with the criteria', async () => {
      const hitl = mockHITLChannel();
      const controller = new DialogueController(manager, hitl);
      const result = await controller.handleTurn('search for something', true);
      expect(result.ok).toBe(true);
      expect(result.validatedIntent).toBe('search');
    });
  });

  // ------------------------------------------------------------
  // 5. Evidence handling (agent utterances are not cited)
  // ------------------------------------------------------------
  describe("agent's own previous utterances are not cited as evidence", () => {
    it('does not allow agent turns to influence claim verification', async () => {
      const controller = new DialogueController(manager);
      // Simulate a full exchange
      await controller.handleTurn('what is the weather like?', true);
      // The controller's internal evidence evaluation should ignore agent utterances.
      // We can verify that after handling a turn, the state.history does contain an agent utterance
      // but that the evidence validation method (e.g., shouldUseAsEvidence) returns false for agent turns.
      const state = controller.getManager().state;
      const agentTurn = state.history.find(t => t.speaker === 'agent');
      if (agentTurn) {
        // The evidence validator should mark agent utterances as not usable
        const evidenceValid = controller.isEvidenceValidSource(agentTurn);
        expect(evidenceValid).toBe(false);
      } else {
        // If no agent turn yet (controller may not produce one for a simple intent),
        // we may explicitly inject one and test.
        manager.addTurn({ speaker: 'agent', text: 'I think it is sunny.', timestamp: Date.now() });
        const injectedAgentTurn = state.history.find(t => t.speaker === 'agent');
        expect(injectedAgentTurn).toBeDefined();
        expect(controller.isEvidenceValidSource(injectedAgentTurn!)).toBe(false);
      }
    });
  });

  // ------------------------------------------------------------
  // 6. Context assembly includes redacted dialogue snapshot
  // ------------------------------------------------------------
  describe('multi-turn context assembly via context_manager includes redacted dialogue snapshot', () => {
    it('calls contextManager.addSnapshot after a turn', async () => {
      const ctxManager = mockContextManager();
      const controller = new DialogueController(manager, /*hitl*/ undefined, ctxManager);
      await controller.handleTurn('find the best pizza place', true);
      expect(ctxManager.addSnapshot).toHaveBeenCalled();
      const snapshotArg = (ctxManager.addSnapshot as any).mock.calls[0][0];
      // The snapshot should be a string that contains delimited user turn data
      expect(typeof snapshotArg).toBe('string');
      expect(snapshotArg).toContain('find the best pizza place');
    });
  });

  // ------------------------------------------------------------
  // 7. Dialogue state is not treated as a substitute for real evidence
  // ------------------------------------------------------------
  describe('controller does not treat the dialogue state as a substitute for validating evidence from tools or memory', () => {
    it('requires external observation to mark a milestone as complete', async () => {
      const controller = new DialogueController(manager);
      // Even after a user turn that claims success, the controller should not accept it as evidence without a tool call.
      await controller.handleTurn('the task is done', true);
      // For example, the controller should still be in an incomplete state for the task.
      const isComplete = controller.isTaskComplete();
      expect(isComplete).toBe(false);
    });

    it('after receiving external validated evidence, the task can be completed', async () => {
      const controller = new DialogueController(manager);
      // Simulate an external tool returning evidence that the task is done
      controller.receiveExternalObservation({ source: 'tool', claim: 'task completed', validated: true });
      const isComplete = controller.isTaskComplete();
      expect(isComplete).toBe(true);
    });
  });
});
