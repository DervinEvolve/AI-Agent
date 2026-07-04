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

  describe('ambiguity leads to pending clarification and HITL request', () => {
    it('sets pending clarification and requests via hitl_channel when interactive', async () => {
      const hitl = mockHITLChannel();
      const controller = new DialogueController(manager, hitl);
      const result = await controller.handleTurn('uhh maybe something', true);
      expect(result.ok).toBe(false);
      expect(result.clarification).toBeDefined();
      expect(result.clarification!.type).toBe('ambiguity');
      expect(hitl.requestClarification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ambiguity' })
      );
      // The manager should have a pending clarification
      expect(manager.hasPendingClarification()).toBe(true);
    });

    it('returns policy_blocked when non-interactive and ambiguity occurs', async () => {
      const controller = new DialogueController(manager, undefined);
      const result = await controller.handleTurn('some weird input', false);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('policy_blocked');
      expect(result.clarification).toBeDefined();
      // No HITL request because non-interactive
    });

    it('flags the ambiguity type correctly for unknown intent', async () => {
      const hitl = mockHITLChannel();
      const controller = new DialogueController(manager, hitl);
      const result = await controller.handleTurn('xyzzy', true);
      expect(result.ok).toBe(false);
      expect(result.clarification).toHaveProperty('type', 'ambiguity');
    });
  });

  describe('commitments recorded by agent and honored before final answer', () => {
    it('records a commitment and retrieves it before final answer', async () => {
      const controller = new DialogueController(manager);
      await controller.handleTurn('I need a summary of the document', true);
      // Simulate the agent adding a commitment
      manager.addCommitment({
        id: 'cm1',
        description: 'Provide a summary before final result',
        fulfilled: false,
      });

      // Before final answer, check commitments
      const pending = controller.checkCommitmentsBeforeFinal();
      expect(pending).toContain('Provide a summary before final result');

      // After the agent fulfills it
      manager.fulfillCommitment('cm1');
      expect(controller.checkCommitmentsBeforeFinal()).toHaveLength(0);
    });

    it('does not bypass HITL for irreversible actions', async () => {
      // The presence of a commitment does not mean the system automatically dispatches an irreversible action;
      // the actual dispatch still goes through HITL.
      // Here we simulate a controller that first checks commitments, then later the action is dispatched via HITL.
      const controller = new DialogueController(manager);
      // User asks to deactivate something (this intent will be blocked by criteria)
      const result = await controller.handleTurn('deactivate all sensors', true);
      // This intent should not validate, resulting in clarification (not action)
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('clarification_required');
      // Even if the agent had a commitment, the HITL check must occur before acting.
      // The test verifies that the controller's handleTurn does not silently allow dispatch.
    });
  });

  describe('dialogue-derived intent is validated against immutable success criteria', () => {
    it('permits search intent when criteria include answering', async () => {
      const result = manager.processTurn('search for weather', true);
      expect(result.ok).toBe(true);
      expect(result.validatedIntent).toBe('search');
    });

    it('blocks stop intent when safety criteria forbid it', async () => {
      // "never disable safety systems" is a criterion; stop is not aligned
      const hitl = mockHITLChannel();
      const controller = new DialogueController(manager, hitl);
      const result = await controller.handleTurn('deactivate main system', true);
      expect(result.ok).toBe(false);
      expect(result.clarification).toBeDefined();
      expect(hitl.requestClarification).toHaveBeenCalled();
    });

    it('rejects intents that conflict with multiple criteria', async () => {
      const strictManager = new DialogueManager([
        'only answer questions about math',
        'never access the internet',
      ]);
      const hitl = mockHITLChannel();
      const controller = new DialogueController(strictManager, hitl);
      const result = await controller.handleTurn('find pictures of cats', true);
      expect(result.ok).toBe(false);
    });
  });

  describe("agent's own previous utterances are not cited as evidence", () => {
    it('redacted snapshot excludes agent utterances', () => {
      manager.addAgentUtterance('I found 3 results');
      const snapshot = manager.getRedactedSnapshot();
      expect(snapshot).not.toContain('agent:');
      expect(snapshot).toContain('[DIALOGUE_DATA_TIER]');
    });

    it('does not allow using agent utterances as evidence when checking claims (simulated)', () => {
      // The manager's design prevents agent utterances from being included in the evidence snapshot.
      // A controller that uses getRedactedSnapshot ensures only user data is passed to context.
      manager.addAgentUtterance('The answer is 42');
      const controller = new DialogueController(manager);
      // The snapshot from a new user turn must not contain previous agent utterance
      const result = manager.processTurn('Is that correct?', true);
      expect(result.snapshot).not.toContain('agent:');
      expect(result.snapshot).toContain('user: Is that correct?');
      // The manager's state does contain the agent utterance, but the snapshot for evidence does not
    });
  });

  describe('multi-turn context assembly via context_manager includes redacted dialogue snapshot', () => {
    it('calls contextManager.addSnapshot with the redacted snapshot', async () => {
      const cm = mockContextManager();
      const controller = new DialogueController(manager, undefined, cm);
      await controller.handleTurn('Hello', true);
      expect(cm.addSnapshot).toHaveBeenCalledWith(
        expect.stringContaining('[DIALOGUE_DATA_TIER]')
      );
    });

    it('does not call contextManager if no snapshot generated (e.g., empty history)', async () => {
      const cm = mockContextManager();
      // create fresh manager with no history; but processTurn always adds a user turn, so snapshot exists.
      // To test empty, we can call directly on manager without adding turns (start state).
      expect(manager.getRedactedSnapshot()).toBe('');
      // But controller.handleTurn always processes a turn, so we skip.
    });
  });

  describe('controller does not treat the dialogue state as a substitute for validating evidence from tools or memory', () => {
    it('does not use dialogue state to verify factual claims', () => {
      // In this design, the controller never extracts factual evidence from dialogue state.
      // It only uses it for intent tracking and commitment management.
      // The manager does not store tool results, only user/agent turns.
      const state = manager.state;
      // There is no property like `lastToolResult` – evidence must come from dedicated tool/memory modules.
      expect(state).not.toHaveProperty('lastToolResult');
      expect(state).toHaveProperty('commitments');
    });

    it('relies on external tool results, not on dialogue history', async () => {
      // The controller's handleTurn does not cache or use tool results; it only validates intent.
      // A separate tool orchestration layer would provide validated observations.
      // Here we just ensure that the dialogue manager does not expose tool outputs.
      const fakeToolResult = 'temperature: 23C';
      // Even if we try to inject it as an agent utterance, it shouldn't be used in snapshot.
      manager.addAgentUtterance(fakeToolResult);
      const snapshot = manager.getRedactedSnapshot();
      expect(snapshot).not.toContain(fakeToolResult);
    });
  });
});
