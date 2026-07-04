// beh_multi_turn_dialogue_grounding_21.ts
// Dialogue-grounded multi-turn interaction with intent tracking
// Implements a bounded neuro-symbolic dialogue manager that treats user turns as tainted input,
// validates intent against immutable success criteria, and falls back to human clarification on ambiguity.
// The manager maintains a safe state: pending clarifications, commitments, and a redacted history.

// ---- types ----

export type ClarificationType =
  | 'ambiguity'
  | 'missing_info'
  | 'preference'
  | 'verification'
  | 'guidance';

export interface ClarificationRequest {
  type: ClarificationType;
  message: string;
  timeoutMs?: number;
}

export interface Commitment {
  id: string;
  description: string;
  fulfilled: boolean;
}

export interface DialogueTurn {
  speaker: 'user' | 'agent';
  text: string;
  timestamp: number;
}

export interface DialogueState {
  pendingClarification: ClarificationRequest | null;
  commitments: Commitment[];
  history: DialogueTurn[];
  lastResolvedIntent: string | null;
  validated: boolean;
}

export interface DialogueResult {
  ok: boolean;
  reason?: string;
  clarification?: ClarificationRequest;
  validatedIntent?: string;
  snapshot?: string;
}

// Interface for pluggable intent resolver (real implementations could use an LLM classifier).
// The default is a simple heuristic resolver that looks for keywords.
export interface IntentResolver {
  resolve(userInput: string): { intent: string; confidence: number };
}

// ---- default heuristic resolver ----

const defaultIntentResolver: IntentResolver = {
  resolve(input: string) {
    const lower = input.toLowerCase();
    if (lower.includes('search') || lower.includes('find') || lower.includes('look up')) {
      return { intent: 'search', confidence: 0.9 };
    }
    if (lower.includes('summarize') || lower.includes('summary') || lower.includes('brief')) {
      return { intent: 'summarize', confidence: 0.9 };
    }
    if (lower.includes('calculate') || lower.includes('compute') || lower.includes('math')) {
      return { intent: 'compute', confidence: 0.9 };
    }
    if (lower.includes('deactivate') || lower.includes('disable') || lower.includes('stop')) {
      return { intent: 'stop', confidence: 0.9 };
    }
    if (lower.includes('commit') || lower.includes('promise') || lower.includes('remember')) {
      return { intent: 'commit', confidence: 0.9 };
    }
    // fallback – ambiguous
    return { intent: 'unknown', confidence: 0.3 };
  }
};

// ---- DialogueManager ----

export class DialogueManager {
  private _state: DialogueState;
  private immutableCriteria: string[];
  private intentResolver: IntentResolver;

  constructor(
    immutableCriteria: string[],
    intentResolver: IntentResolver = defaultIntentResolver
  ) {
    this.immutableCriteria = immutableCriteria;
    this.intentResolver = intentResolver;
    this._state = {
      pendingClarification: null,
      commitments: [],
      history: [],
      lastResolvedIntent: null,
      validated: false,
    };
  }

  get state(): Readonly<DialogueState> {
    return this._state;
  }

  // Process a new user turn. Returns a result that indicates success or need for clarification.
  // If interactive = false and clarification is needed, returns a policy_blocked result.
  processTurn(userInput: string, interactive: boolean): DialogueResult {
    // 0. Clear previous pending clarification
    this._state.pendingClarification = null;

    // 1. Record user turn
    this._state.history.push({
      speaker: 'user',
      text: userInput,
      timestamp: Date.now(),
    });

    // 2. Resolve intent
    const resolved = this.intentResolver.resolve(userInput);
    const intent = resolved.intent;

    // 3. Validate intent against immutable criteria
    const validationResult = this.validateIntent(intent);
    if (!validationResult.valid) {
      // ambiguity or policy violation
      const reason = validationResult.reason || 'intent could not be validated';
      // Detect ambiguity type
      const clarificationType: ClarificationType =
        intent === 'unknown' ? 'ambiguity' : 'verification';
      const clarificationMsg = `Could not resolve intent '${intent}': ${reason}. Please clarify.`;

      this._state.pendingClarification = {
        type: clarificationType,
        message: clarificationMsg,
      };

      if (!interactive) {
        return {
          ok: false,
          reason: `policy_blocked: ${reason}`,
          clarification: this._state.pendingClarification,
        };
      }
      // interactive: signal that clarification is needed via the result
      return {
        ok: false,
        reason: 'clarification_required',
        clarification: this._state.pendingClarification,
      };
    }

    // 4. Intent is valid – update state
    this._state.lastResolvedIntent = intent;
    this._state.validated = true;

    // Provide a redacted snapshot (user only) that the controller can include in context
    const snapshot = this.getRedactedSnapshot();

    return {
      ok: true,
      validatedIntent: intent,
      snapshot,
    };
  }

  // Record an agent utterance – NOT used for evidence
  addAgentUtterance(text: string): void {
    this._state.history.push({
      speaker: 'agent',
      text,
      timestamp: Date.now(),
    });
  }

  // Validate that the derived intent is compatible with the immutable success criteria.
  // The criteria are simple string patterns that must be present or permitted.
  private validateIntent(intent: string): { valid: boolean; reason?: string } {
    // If no criteria are defined, all intents are permitted (not recommended)
    if (this.immutableCriteria.length === 0) {
      return { valid: true };
    }

    // The intent must directly support at least one of the criteria.
    // This is a simplified policy engine; in a real system you would use a semantic validator.
    const allowedIntents = this.immutableCriteria.map((c) => c.toLowerCase());

    // For demonstration, define a mapping: certain intents align with criteria patterns.
    const intentAligns = (intent: string, criteria: string): boolean => {
      if (criteria.includes('answer') || criteria.includes('respond')) {
        return ['search', 'summarize', 'compute'].includes(intent);
      }
      if (criteria.includes('safety') || criteria.includes('never deactivate')) {
        return intent !== 'stop';
      }
      // default: permit common informational intents
      return ['search', 'summarize', 'compute'].includes(intent);
    };

    const match = allowedIntents.some((criteria) => intentAligns(intent, criteria));
    if (!match) {
      return {
        valid: false,
        reason: `intent '${intent}' is not allowed by immutable success criteria`,
      };
    }

    // Additionally, an unknown intent is considered ambiguous
    if (intent === 'unknown') {
      return { valid: false, reason: 'ambiguous intent' };
    }

    return { valid: true };
  }

  // ---- commitment handling ----

  addCommitment(commitment: Commitment): void {
    this._state.commitments.push(commitment);
  }

  getPendingCommitments(): Commitment[] {
    return this._state.commitments.filter((c) => !c.fulfilled);
  }

  fulfillCommitment(id: string): boolean {
    const c = this._state.commitments.find((c) => c.id === id);
    if (c) {
      c.fulfilled = true;
      return true;
    }
    return false;
  }

  hasPendingClarification(): boolean {
    return this._state.pendingClarification !== null;
  }

  // Produce a redacted dialogue snapshot containing **only user turns**,
  // delimited for inclusion in a data tier context block.
  getRedactedSnapshot(): string {
    const userTurns = this._state.history.filter((t) => t.speaker === 'user');
    if (userTurns.length === 0) return '';
    return (
      '[DIALOGUE_DATA_TIER]\n' +
      userTurns.map((t) => `user: ${t.text}`).join('\n')
    );
  }

  // Debug info: check if any agent utterances are present (they must not be used as evidence)
  hasAgentUtterances(): boolean {
    return this._state.history.some((t) => t.speaker === 'agent');
  }
}

// ---- Controller ----
// A thin controller that uses a DialogueManager and optionally a HITL channel
// and a ContextManager to orchestrate multi-turn interaction.

export interface HITLChannel {
  requestClarification(req: ClarificationRequest): Promise<void>;
}

export class DialogueController {
  private manager: DialogueManager;
  private hitl: HITLChannel | null;
  private contextManager: any; // typed loosely to avoid dependency; expected to have addSnapshot method

  constructor(
    manager: DialogueManager,
    hitl?: HITLChannel,
    contextManager?: any
  ) {
    this.manager = manager;
    this.hitl = hitl || null;
    this.contextManager = contextManager || null;
  }

  // Handle a user turn within a multi-turn task.
  // Returns a result that can be used to decide next steps.
  async handleTurn(
    userInput: string,
    interactive: boolean
  ): Promise<DialogueResult> {
    const result = this.manager.processTurn(userInput, interactive);

    if (!result.ok && result.clarification) {
      if (interactive && this.hitl) {
        // In interactive context, request clarification via HITL channel
        await this.hitl.requestClarification(result.clarification);
      }
      // If non-interactive, the result already indicates policy_blocked
    }

    // If context_manager is available, include the redacted snapshot
    if (this.contextManager && result.snapshot) {
      this.contextManager.addSnapshot(result.snapshot);
    }

    return result;
  }

  // Add an agent utterance (the agent's reply, not for evidence)
  addAgentUtterance(text: string): void {
    this.manager.addAgentUtterance(text);
  }

  // Before the final answer, check commitments and ensure they are honored.
  // This does NOT bypass HITL; irreversible actions still go through HITL.
  checkCommitmentsBeforeFinal(): string[] {
    const pending = this.manager.getPendingCommitments();
    return pending.map((c) => c.description);
  }

  getManager(): DialogueManager {
    return this.manager;
  }
}
