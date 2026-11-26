import type { BoardEvent } from './types';

export interface BoardJournalReconciliation {
  status: 'unapplied' | 'applied' | 'none';
  events: BoardEvent[];
}

export interface BoardJournalAdapter {
  appendIntent(callId: string): Promise<void>;
  appendEvents(callId: string, events: BoardEvent[]): Promise<void>;
  reconcile(callId: string): Promise<BoardJournalReconciliation>;
  getCommittedEvents(): BoardEvent[];
}

export class InMemoryFencedBoardJournal implements BoardJournalAdapter {
  private readonly intents = new Set<string>();
  private readonly eventsByCallId = new Map<string, BoardEvent[]>();
  private readonly committedEvents: BoardEvent[] = [];

  async appendIntent(callId: string): Promise<void> {
    this.intents.add(callId);
  }

  async appendEvents(callId: string, events: BoardEvent[]): Promise<void> {
    if (this.eventsByCallId.has(callId)) {
      return;
    }
    const cloned = events.map((e) => ({ ...e }));
    this.eventsByCallId.set(callId, cloned);
    this.committedEvents.push(...cloned);
  }

  async reconcile(callId: string): Promise<BoardJournalReconciliation> {
    const events = this.eventsByCallId.get(callId);
    if (events && events.length > 0) {
      return { status: 'applied', events: events.map((e) => ({ ...e })) };
    }
    if (this.intents.has(callId)) {
      return { status: 'unapplied', events: [] };
    }
    return { status: 'none', events: [] };
  }

  getCommittedEvents(): BoardEvent[] {
    return this.committedEvents.map((e) => ({ ...e }));
  }
}
