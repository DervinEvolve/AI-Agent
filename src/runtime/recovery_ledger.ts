import type { OutcomeClassification } from './outcome_classifier';

export type AdmitResult =
  | {
      allowed: true;
      intentId: string | null;
      remainingAllowance: number;
    }
  | {
      allowed: false;
      reason: string;
      intentId: string | null;
      remainingAllowance: number;
    };

export interface RecordResult {
  slot: 'opened' | 'consumed' | 'closed' | 'unchanged';
  intentId: string | null;
}

export interface UnresolvedItem {
  intentId: string;
  toolName: string;
  callId: string;
  classification: OutcomeClassification;
  idempotent: boolean;
}

export interface LedgerSnapshot {
  active: boolean;
  intentId: string | null;
  remainingAllowance: number;
  unresolved: UnresolvedItem[];
}

export class RecoveryLedger {
  private active = false;
  private currentIntentId: string | null = null;
  private remainingAllowance = 3;
  private failedToolName: string | null = null;
  private failedToolIdempotent = true;
  private failedOutcome: OutcomeClassification = 'unknown';
  private readonly unresolvedItems: UnresolvedItem[] = [];

  admit(toolName: string, idempotent: boolean, isRecall: boolean): AdmitResult {
    if (isRecall) {
      return {
        allowed: true,
        intentId: this.currentIntentId,
        remainingAllowance: this.remainingAllowance,
      };
    }

    if (!this.active) {
      return {
        allowed: true,
        intentId: null,
        remainingAllowance: 3,
      };
    }

    if (this.remainingAllowance <= 0) {
      return {
        allowed: false,
        reason: 'recovery_allowance_exhausted',
        intentId: this.currentIntentId,
        remainingAllowance: 0,
      };
    }

    if (
      this.failedOutcome === 'unknown' &&
      !this.failedToolIdempotent &&
      toolName === this.failedToolName
    ) {
      return {
        allowed: false,
        reason: 'non_idempotent_unknown_outcome_redispatch_refused',
        intentId: this.currentIntentId,
        remainingAllowance: this.remainingAllowance,
      };
    }

    return {
      allowed: true,
      intentId: this.currentIntentId,
      remainingAllowance: this.remainingAllowance,
    };
  }

  record(
    callId: string,
    classification: OutcomeClassification,
    toolName = 'unknown_tool',
    idempotent = true,
    isRecall = false,
  ): RecordResult {
    if (isRecall) {
      return { slot: 'unchanged', intentId: this.currentIntentId };
    }

    if (!this.active) {
      if (classification === 'success') {
        return { slot: 'unchanged', intentId: null };
      }
      this.active = true;
      this.currentIntentId = `intent_${callId}`;
      this.remainingAllowance = 3;
      this.failedToolName = toolName;
      this.failedToolIdempotent = idempotent;
      this.failedOutcome = classification;
      if (classification === 'unknown') {
        this.unresolvedItems.push({
          intentId: this.currentIntentId,
          toolName,
          callId,
          classification,
          idempotent,
        });
      }
      return { slot: 'opened', intentId: this.currentIntentId };
    }

    this.remainingAllowance = Math.max(0, this.remainingAllowance - 1);
    if (classification === 'success') {
      const intentId = this.currentIntentId;
      this.active = false;
      return { slot: 'closed', intentId };
    }
    if (classification === 'unknown' && this.currentIntentId) {
      this.unresolvedItems.push({
        intentId: this.currentIntentId,
        toolName,
        callId,
        classification,
        idempotent,
      });
    }
    return { slot: 'consumed', intentId: this.currentIntentId };
  }

  closeOnFinalize(): void {
    this.active = false;
  }

  getSnapshot(): LedgerSnapshot {
    return {
      active: this.active,
      intentId: this.currentIntentId,
      remainingAllowance: this.remainingAllowance,
      unresolved: this.unresolvedItems.map((item) => ({ ...item })),
    };
  }
}
