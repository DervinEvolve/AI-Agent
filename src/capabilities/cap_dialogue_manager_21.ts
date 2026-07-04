import { redact } from './secret_redactor';
import { ContextManager } from '../context/context_manager';
import { longTermMemory } from './cap_long_term_memory_3';

// --- Types ---

export interface DialogueScope {
  user_id: string;
  project_id: string;
  namespace: string;
}

export interface StructuredIntent {
  intent_type: string;
  slots: Record<string, any>;
  confidence: number;
}

export interface Commitment {
  id: string;
  description: string;
  target_action_draft?: string;
  deadline_estimate?: string;
  reversible: boolean;
  created_at: string;
  turn_id: string;
  advisory: true;
}

export interface Turn {
  turn_id: string;
  type: 'user' | 'agent';
  timestamp: string;
  utterance: string;
  original_utterance?: string;
  structured_intent?: StructuredIntent;
  commitments?: Commitment[];
  redacted: boolean;
  tainted: boolean;
}

export interface IntentSlot {
  key: string;
  value: any;
  confidence: number;
  tainted: boolean;
  source: string;
  updated_at: string;
}

export interface Clarification {
  ref_id: string;
  question: string;
  asked_at: string;
  resolved: boolean;
  resolved_at?: string;
  response?: string;
}

export interface TaintSummary {
  tainted: true;
  sources: string[];
}

export interface DialogueState {
  dialogue_id: string;
  task_id: string;
  scope: DialogueScope;
  version: number;
  user_turns: Turn[];
  agent_turns: Turn[];
  intent_slots: Record<string, IntentSlot>;
  pending_clarifications: Clarification[];
  active_commitments: Commitment[];
  ambiguity_flags: string[];
  taint_summary: TaintSummary;
  created_at: string;
  updated_at: string;
  turn_count: number;
  finalized: boolean;
}

export interface DialogueSnapshot {
  dialogue_id: string;
  task_id: string;
  turn_count: number;
  user_turns: Pick<Turn, 'turn_id' | 'timestamp' | 'utterance' | 'structured_intent'>[];
  agent_turns: Pick<Turn, 'turn_id' | 'timestamp' | 'utterance'>[];
  intent_slots: Record<string, Omit<IntentSlot, 'source'>>;
  active_commitments: Commitment[];
  pending_clarifications: Clarification[];
  tainted: true;
}

export interface DialogueManagerDependencies {
  redact: (text: string) => { redacted: string; didRedact: boolean };
  contextManager?: ContextManager;
  longTermStore?: (memory: any) => Promise<void>;
}

// --- DialogueManager Class ---

export class DialogueManager {
  private dialogues: Map<string, DialogueState> = new Map();
  private deps: DialogueManagerDependencies;

  constructor(deps: DialogueManagerDependencies) {
    this.deps = deps;
  }

  private generateId(): string {
    return `dial_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private generateTurnId(type: string): string {
    return `${type}_${this.generateId()}`;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private redactUtterance(utterance: string): { text: string; redacted: boolean } {
    const result = this.deps.redact(utterance);
    if (result.didRedact && result.redacted.trim() === '') {
      return { text: '[REDACTED]', redacted: true };
    }
    return { text: result.redacted, redacted: result.didRedact };
  }

  startDialogue(taskId: string, scope: DialogueScope): { dialogue_id: string; state: DialogueState } {
    const dialogueId = this.generateId();
    const now = this.now();
    const state: DialogueState = {
      dialogue_id: dialogueId,
      task_id: taskId,
      scope,
      version: 1,
      user_turns: [],
      agent_turns: [],
      intent_slots: {},
      pending_clarifications: [],
      active_commitments: [],
      ambiguity_flags: [],
      taint_summary: { tainted: true, sources: [] },
      created_at: now,
      updated_at: now,
      turn_count: 0,
      finalized: false,
    };
    this.dialogues.set(dialogueId, state);
    return { dialogue_id: dialogueId, state };
  }

  private getDialogue(dialogueId: string): DialogueState {
    const state = this.dialogues.get(dialogueId);
    if (!state) throw new Error('DIALOGUE_NOT_FOUND');
    if (state.finalized) throw new Error('DIALOGUE_FINALIZED');
    return state;
  }

  recordUserTurn(
    dialogueId: string,
    utterance: string,
    structuredIntent?: StructuredIntent
  ): { turn: Turn; state: DialogueState } {
    if (!utterance || typeof utterance !== 'string' || utterance.length === 0) {
      throw new Error('INVALID_UTTERANCE');
    }
    if (utterance.length > 10000) { // arbitrary size limit
      throw new Error('UTTERANCE_TOO_LARGE');
    }
    const state = this.getDialogue(dialogueId);
    const redacted = this.redactUtterance(utterance);
    const turn: Turn = {
      turn_id: this.generateTurnId('user'),
      type: 'user',
      timestamp: this.now(),
      utterance: redacted.text,
      original_utterance: utterance,
      structured_intent: structuredIntent,
      redacted: redacted.redacted,
      tainted: true,
    };
    state.user_turns.push(turn);
    state.turn_count += 1;
    state.version += 1;
    state.updated_at = this.now();
    // update taint summary
    if (!state.taint_summary.sources.includes('user_utterance')) {
      state.taint_summary.sources.push('user_utterance');
    }
    if (structuredIntent && !state.taint_summary.sources.includes('user_intent')) {
      state.taint_summary.sources.push('user_intent');
    }
    return { turn, state };
  }

  recordAgentTurn(
    dialogueId: string,
    utterance: string,
    structuredIntent?: StructuredIntent,
    commitments?: Omit<Commitment, 'id' | 'created_at' | 'turn_id' | 'advisory'>[]
  ): { turn: Turn; state: DialogueState } {
    const state = this.getDialogue(dialogueId);
    const redacted = this.redactUtterance(utterance);
    const turnId = this.generateTurnId('agent');
    const now = this.now();
    const turn: Turn = {
      turn_id: turnId,
      type: 'agent',
      timestamp: now,
      utterance: redacted.text,
      original_utterance: utterance,
      structured_intent: structuredIntent,
      redacted: redacted.redacted,
      tainted: false, // agent utterances are not tainted
    };
    // process commitments
    const newCommitments: Commitment[] = [];
    if (commitments && commitments.length > 0) {
      for (const c of commitments) {
        const commitment: Commitment = {
          id: this.generateId(),
          description: c.description,
          target_action_draft: c.target_action_draft,
          deadline_estimate: c.deadline_estimate,
          reversible: c.reversible ?? true,
          created_at: now,
          turn_id: turnId,
          advisory: true,
        };
        newCommitments.push(commitment);
      }
      turn.commitments = newCommitments;
      state.active_commitments.push(...newCommitments);
    }
    state.agent_turns.push(turn);
    state.turn_count += 1;
    state.version += 1;
    state.updated_at = now;
    return { turn, state };
  }

  setIntentSlot(
    dialogueId: string,
    key: string,
    value: any,
    confidence: number,
    tainted: boolean,
    source?: string
  ): { slot: IntentSlot; state: DialogueState } {
    const state = this.getDialogue(dialogueId);
    const now = this.now();
    const slot: IntentSlot = {
      key,
      value,
      confidence,
      tainted,
      source: source || 'agent',
      updated_at: now,
    };
    state.intent_slots[key] = slot;
    state.version += 1;
    state.updated_at = now;
    return { slot, state };
  }

  getIntentState(dialogueId: string): Record<string, IntentSlot> {
    const state = this.getDialogue(dialogueId);
    return { ...state.intent_slots };
  }

  noteClarificationRequested(
    dialogueId: string,
    question: string,
    ambiguityRefs?: string[]
  ): { ref_id: string; state: DialogueState } {
    const state = this.getDialogue(dialogueId);
    const refId = this.generateId();
    const now = this.now();
    const clarification: Clarification = {
      ref_id: refId,
      question,
      asked_at: now,
      resolved: false,
    };
    state.pending_clarifications.push(clarification);
    if (ambiguityRefs) {
      state.ambiguity_flags.push(...ambiguityRefs);
    }
    state.version += 1;
    state.updated_at = now;
    return { ref_id: refId, state };
  }

  recordClarificationResponse(
    dialogueId: string,
    refId: string,
    userResponse: string
  ): { clarification: Clarification; state: DialogueState } {
    const state = this.getDialogue(dialogueId);
    const clarification = state.pending_clarifications.find(c => c.ref_id === refId);
    if (!clarification) throw new Error('CLARIFICATION_NOT_FOUND');
    if (clarification.resolved) throw new Error('CLARIFICATION_ALREADY_RESOLVED');
    const now = this.now();
    clarification.resolved = true;
    clarification.resolved_at = now;
    clarification.response = userResponse;
    // optionally feed into intent slots? The spec says "optionally feeds user response into intent slots (tainted)"
    // We'll not automatically set slots; caller can do that separately.
    state.version += 1;
    state.updated_at = now;
    return { clarification, state };
  }

  getPendingClarifications(dialogueId: string): Clarification[] {
    const state = this.getDialogue(dialogueId);
    return state.pending_clarifications.filter(c => !c.resolved);
  }

  getCommitments(dialogueId: string): Commitment[] {
    const state = this.getDialogue(dialogueId);
    return [...state.active_commitments];
  }

  getDialogueSnapshot(dialogueId: string, exportPolicy?: any): DialogueSnapshot {
    const state = this.getDialogue(dialogueId);
    // The snapshot is a redacted summary; we reuse the already redacted utterances
    return {
      dialogue_id: state.dialogue_id,
      task_id: state.task_id,
      turn_count: state.turn_count,
      user_turns: state.user_turns.map(t => ({
        turn_id: t.turn_id,
        timestamp: t.timestamp,
        utterance: t.utterance,
        structured_intent: t.structured_intent,
      })),
      agent_turns: state.agent_turns.map(t => ({
        turn_id: t.turn_id,
        timestamp: t.timestamp,
        utterance: t.utterance,
      })),
      intent_slots: Object.fromEntries(
        Object.entries(state.intent_slots).map(([k, v]) => [k, {
          key: v.key,
          value: v.value,
          confidence: v.confidence,
          tainted: v.tainted,
          updated_at: v.updated_at,
        }])
      ),
      active_commitments: state.active_commitments,
      pending_clarifications: state.pending_clarifications.filter(c => !c.resolved),
      tainted: true,
    };
  }

  async endDialogue(
    dialogueId: string,
    budgetTag?: string
  ): Promise<{ state: DialogueState }> {
    const state = this.getDialogue(dialogueId);
    // budget check if contextManager provided
    if (this.deps.contextManager && budgetTag) {
      const budgetOk = await this.deps.contextManager.reserveTokens(budgetTag, 1); // simple cost
      if (!budgetOk) {
        throw new Error('BUDGET_EXHAUSTED');
      }
    }
    state.finalized = true;
    state.updated_at = this.now();
    // optional persistence
    if (this.deps.longTermStore) {
      const snapshot = this.getDialogueSnapshot(dialogueId);
      await this.deps.longTermStore(snapshot);
    }
    return { state };
  }
}

// --- Tool Definition ---

export const dialogueManager = {
  name: 'dialogue_manager',
  description:
    'Multi-turn dialogue state management with intent tracking and commitment memory. ' +
    'All user content is tainted. Commitments are advisory only.',
  inputs: {
    action: { type: 'string', required: true, enum: [
      'start_dialogue', 'record_user_turn', 'record_agent_turn', 'set_intent_slot',
      'get_intent_state', 'note_clarification_requested', 'record_clarification_response',
      'get_pending_clarifications', 'get_commitments', 'get_dialogue_snapshot', 'end_dialogue'
    ] },
    dialogue_id: { type: 'string', required: false },
    task_id: { type: 'string', required: false },
    scope: { type: 'object', required: false },
    utterance: { type: 'string', required: false },
    utterance_type: { type: 'string', required: false, enum: ['user', 'agent'] },
    structured_intent: { type: 'object', required: false },
    commitments: { type: 'array', required: false },
    ambiguity_refs: { type: 'array', required: false },
    clarification_question: { type: 'string', required: false },
    user_response: { type: 'string', required: false },
    slot_key: { type: 'string', required: false },
    slot_value: { type: 'any', required: false },
    export_policy: { type: 'object', required: false },
    budget_tag: { type: 'string', required: false },
  },
  handler: async (input: any) => {
    // Instantiate with real dependencies
    const manager = new DialogueManager({
      redact,
      contextManager: undefined, // will be provided by controller if needed
      longTermStore: async (mem) => {
        await longTermMemory.store(mem);
      },
    });

    try {
      switch (input.action) {
        case 'start_dialogue': {
          if (!input.task_id || !input.scope) throw new Error('MISSING_REQUIRED_FIELDS');
          const result = manager.startDialogue(input.task_id, input.scope);
          return {
            status: 'ok',
            tainted: true,
            dialogue_id: result.dialogue_id,
            dialogue_state: result.state,
            provenance: {
              dialogue_id: result.dialogue_id,
              task_id: input.task_id,
              created_at: result.state.created_at,
              updated_at: result.state.updated_at,
              turn_count: result.state.turn_count,
              version: result.state.version,
              scope: input.scope,
            },
          };
        }
        case 'record_user_turn': {
          if (!input.dialogue_id || !input.utterance) throw new Error('MISSING_REQUIRED_FIELDS');
          const result = manager.recordUserTurn(input.dialogue_id, input.utterance, input.structured_intent);
          return {
            status: 'ok',
            tainted: true,
            dialogue_id: input.dialogue_id,
            dialogue_state: result.state,
          };
        }
        case 'record_agent_turn': {
          if (!input.dialogue_id || !input.utterance) throw new Error('MISSING_REQUIRED_FIELDS');
          const result = manager.recordAgentTurn(
            input.dialogue_id,
            input.utterance,
            input.structured_intent,
            input.commitments
          );
          return {
            status: 'ok',
            tainted: true, // overall state is tainted
            dialogue_id: input.dialogue_id,
            dialogue_state: result.state,
            commitments: result.turn.commitments,
          };
        }
        case 'set_intent_slot': {
          if (!input.dialogue_id || !input.slot_key || input.slot_value === undefined) throw new Error('MISSING_REQUIRED_FIELDS');
          const result = manager.setIntentSlot(
            input.dialogue_id,
            input.slot_key,
            input.slot_value,
            input.structured_intent?.confidence ?? 1.0,
            input.tainted ?? true,
            input.source
          );
          return {
            status: 'ok',
            tainted: result.slot.tainted,
            dialogue_id: input.dialogue_id,
            dialogue_state: result.state,
          };
        }
        case 'get_intent_state': {
          if (!input.dialogue_id) throw new Error('MISSING_REQUIRED_FIELDS');
          const slots = manager.getIntentState(input.dialogue_id);
          return {
            status: 'ok',
            tainted: true,
            dialogue_id: input.dialogue_id,
            intent_slots: slots,
          };
        }
        case 'note_clarification_requested': {
          if (!input.dialogue_id || !input.clarification_question) throw new Error('MISSING_REQUIRED_FIELDS');
          const result = manager.noteClarificationRequested(
            input.dialogue_id,
            input.clarification_question,
            input.ambiguity_refs
          );
          return {
            status: 'ok',
            tainted: true,
            dialogue_id: input.dialogue_id,
            ref_id: result.ref_id,
            dialogue_state: result.state,
          };
        }
        case 'record_clarification_response': {
          if (!input.dialogue_id || !input.user_response || !input.ref_id) throw new Error('MISSING_REQUIRED_FIELDS');
          const result = manager.recordClarificationResponse(input.dialogue_id, input.ref_id, input.user_response);
          return {
            status: 'ok',
            tainted: true,
            dialogue_id: input.dialogue_id,
            dialogue_state: result.state,
          };
        }
        case 'get_pending_clarifications': {
          if (!input.dialogue_id) throw new Error('MISSING_REQUIRED_FIELDS');
          const clarifications = manager.getPendingClarifications(input.dialogue_id);
          return {
            status: 'ok',
            tainted: true,
            dialogue_id: input.dialogue_id,
            pending_clarifications: clarifications,
          };
        }
        case 'get_commitments': {
          if (!input.dialogue_id) throw new Error('MISSING_REQUIRED_FIELDS');
          const commitments = manager.getCommitments(input.dialogue_id);
          return {
            status: 'ok',
            tainted: true,
            dialogue_id: input.dialogue_id,
            commitments,
          };
        }
        case 'get_dialogue_snapshot': {
          if (!input.dialogue_id) throw new Error('MISSING_REQUIRED_FIELDS');
          const snapshot = manager.getDialogueSnapshot(input.dialogue_id, input.export_policy);
          return {
            status: 'ok',
            tainted: true,
            dialogue_id: input.dialogue_id,
            redacted_snapshot: snapshot,
          };
        }
        case 'end_dialogue': {
          if (!input.dialogue_id) throw new Error('MISSING_REQUIRED_FIELDS');
          const result = await manager.endDialogue(input.dialogue_id, input.budget_tag);
          return {
            status: 'ok',
            tainted: true,
            dialogue_id: input.dialogue_id,
            dialogue_state: result.state,
          };
        }
        default:
          throw new Error('INVALID_ACTION');
      }
    } catch (err: any) {
      const message = err.message || 'UNKNOWN_ERROR';
      let status: string;
      switch (message) {
        case 'DIALOGUE_NOT_FOUND':
          status = 'not_found';
          break;
        case 'DIALOGUE_FINALIZED':
          status = 'limit_exceeded';
          break;
        case 'BUDGET_EXHAUSTED':
          status = 'budget_exhausted';
          break;
        case 'INVALID_UTTERANCE':
        case 'UTTERANCE_TOO_LARGE':
        case 'MISSING_REQUIRED_FIELDS':
        case 'INVALID_ACTION':
        case 'CLARIFICATION_NOT_FOUND':
        case 'CLARIFICATION_ALREADY_RESOLVED':
          status = 'policy_blocked';
          break;
        default:
          status = 'policy_blocked';
      }
      return {
        error: {
          code: message,
          message: message,
          retryable: false,
        },
        status,
        tainted: true,
      };
    }
  },
};
