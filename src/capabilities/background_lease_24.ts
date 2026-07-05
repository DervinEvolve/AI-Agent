import type { RedactionRecord, RedactionResult } from "./background_redaction_adapter_24";

export interface BackgroundTraceEvent {
  type: string;
  text?: string;
  terminal?: boolean;
  policyBlocked?: boolean;
  redactions?: RedactionRecord[];
  data?: Record<string, unknown>;
}

export class BackgroundLease {
  private readonly traceEvents: BackgroundTraceEvent[] = [];

  emit(event: BackgroundTraceEvent): void {
    this.traceEvents.push({ ...event });
  }

  emitRedactedTerminalTrace(result: RedactionResult, data: Record<string, unknown> = {}): void {
    this.emit({
      type: "terminal_trace",
      text: result.text,
      terminal: true,
      policyBlocked: result.blocked,
      redactions: result.redactions,
      data,
    });
  }

  snapshot(): BackgroundTraceEvent[] {
    return this.traceEvents.map((event) => ({ ...event }));
  }
}
