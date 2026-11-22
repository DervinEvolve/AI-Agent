export const HARD_MAX_TOOL_CALLS_PER_TURN = 8;
export const RECOMMENDED_MAX_TOOL_CALLS_PER_TURN = 4;

export type UnstartedReason = 'batch_aborted' | 'budget_exhausted' | 'deadline_exceeded';

export type ToolOutcomeKind =
  | 'success'
  | 'invalid_args'
  | 'known_error'
  | 'timeout'
  | 'unknown'
  | 'unstarted';

export interface RawToolCall {
  provider_call_id: string;
  name: string;
  arguments: string | Record<string, unknown>;
}

export interface ActionEnvelope {
  kind: 'tool_calls' | 'tool_call' | 'final_answer';
  tool_calls?: RawToolCall[];
  tool_call?: RawToolCall;
  final_answer?: string;
  reasoning_details?: unknown;
}

export interface AcceptedToolCall {
  call_id: string;
  provider_call_id: string;
  name: string;
  parsedArgs: Record<string, unknown> | null;
  rawArguments: string | Record<string, unknown>;
}

export interface EnvelopeDecodeResult {
  ok: boolean;
  error?: string;
  acceptedCalls: AcceptedToolCall[];
  reasoning_details?: unknown;
  rawToolCalls?: RawToolCall[];
}

export interface ToolRegistration {
  name: string;
  service?: string;
  idempotent: boolean;
  concurrentSafe: boolean;
  validateArgs?: (args: Record<string, unknown>) => boolean;
  execute: (args: Record<string, unknown>, ctx: { call_id: string; signal?: AbortSignal }) => Promise<unknown>;
}

export interface ToolResult {
  call_id: string;
  provider_call_id: string;
  name: string;
  started: boolean;
  outcome: ToolOutcomeKind;
  value?: unknown;
  error?: string;
  unstartedReason?: UnstartedReason;
}

export interface RecoverySlot {
  call_id: string;
  toolName: string;
  service?: string;
  outcome: 'unknown' | 'known_error' | 'timeout' | 'invalid_args';
  attemptsRemaining: number;
}

export interface RecoveryLedgerState {
  slot: RecoverySlot | null;
  unknownOutcomes: Array<{ call_id: string; toolName: string; service?: string }>;
  quarantinedServices: Set<string>;
}

export interface BudgetState {
  stepsRemaining: number;
  usageRemaining: number;
  reservedSteps: number;
  reservedUsage: number;
}

export interface ParallelDispatchConfig {
  maxToolCallsPerTurn?: number;
  maxConcurrency?: number;
  durableRunMount?: boolean;
  isChildLoop?: boolean;
  deadlineMs?: number;
}

export function validateDispatchConfig(config: ParallelDispatchConfig): { effectiveMaxCalls: number; effectiveConcurrency: number } {
  if (config.isChildLoop) {
    return { effectiveMaxCalls: 1, effectiveConcurrency: 1 };
  }
  const rawMax = config.maxToolCallsPerTurn ?? 1;
  if (rawMax > 1 && config.durableRunMount) {
    throw new Error('Batch tool dispatch (maxToolCallsPerTurn > 1) is incompatible with durableRunMount until per-member journaling ships.');
  }
  if (rawMax < 1 || rawMax > HARD_MAX_TOOL_CALLS_PER_TURN) {
    throw new Error(`maxToolCallsPerTurn must be between 1 and ${HARD_MAX_TOOL_CALLS_PER_TURN}, got ${rawMax}`);
  }
  const effectiveConcurrency = Math.min(rawMax, Math.max(1, config.maxConcurrency ?? rawMax));
  return { effectiveMaxCalls: rawMax, effectiveConcurrency };
}

let callCounter = 0;
function mintCallId(): string {
  callCounter += 1;
  return `call_${Date.now()}_${callCounter}`;
}

export function decodeActionEnvelope(envelope: ActionEnvelope, maxToolCallsPerTurn = 1): EnvelopeDecodeResult {
  const hasToolCalls = envelope.tool_calls !== undefined;
  const hasToolCall = envelope.tool_call !== undefined;
  const hasFinalAnswer = envelope.final_answer !== undefined;

  const kindCount = (hasToolCalls ? 1 : 0) + (hasToolCall ? 1 : 0) + (hasFinalAnswer ? 1 : 0);
  if (kindCount !== 1) {
    return { ok: false, error: 'Mutually exclusive action kinds violated', acceptedCalls: [] };
  }

  if (envelope.kind !== 'tool_calls') {
    return { ok: false, error: `Expected kind tool_calls, got ${envelope.kind}`, acceptedCalls: [] };
  }

  if (!Array.isArray(envelope.tool_calls) || envelope.tool_calls.length === 0) {
    return { ok: false, error: 'tool_calls must be a non-empty array', acceptedCalls: [] };
  }

  const cap = Math.min(maxToolCallsPerTurn, HARD_MAX_TOOL_CALLS_PER_TURN);
  if (envelope.tool_calls.length > cap) {
    return { ok: false, error: `tool_calls count ${envelope.tool_calls.length} exceeds cap ${cap}`, acceptedCalls: [] };
  }

  const seenIds = new Set<string>();
  const acceptedCalls: AcceptedToolCall[] = [];

  for (const raw of envelope.tool_calls) {
    if (typeof raw.provider_call_id !== 'string' || raw.provider_call_id.trim() === '') {
      return { ok: false, error: 'Every tool call must have a non-empty provider_call_id', acceptedCalls: [] };
    }
    if (seenIds.has(raw.provider_call_id)) {
      return { ok: false, error: `Duplicate provider_call_id: ${raw.provider_call_id}`, acceptedCalls: [] };
    }
    seenIds.add(raw.provider_call_id);

    let parsedArgs: Record<string, unknown> | null = null;
    if (typeof raw.arguments === 'string') {
      try {
        const parsed = JSON.parse(raw.arguments);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return { ok: false, error: `Arguments for ${raw.provider_call_id} must parse to a JSON object`, acceptedCalls: [] };
        }
        parsedArgs = parsed as Record<string, unknown>;
      } catch {
        return { ok: false, error: `Malformed JSON arguments for ${raw.provider_call_id}`, acceptedCalls: [] };
      }
    } else if (typeof raw.arguments === 'object' && raw.arguments !== null && !Array.isArray(raw.arguments)) {
      parsedArgs = raw.arguments;
    } else {
      return { ok: false, error: `Invalid arguments type for ${raw.provider_call_id}`, acceptedCalls: [] };
    }

    acceptedCalls.push({
      call_id: mintCallId(),
      provider_call_id: raw.provider_call_id,
      name: raw.name,
      parsedArgs,
      rawArguments: raw.arguments,
    });
  }

  return {
    ok: true,
    acceptedCalls,
    reasoning_details: envelope.reasoning_details,
    rawToolCalls: envelope.tool_calls,
  };
}

export function canRunConcurrently(
  calls: AcceptedToolCall[],
  registry: Map<string, ToolRegistration>,
  ledger: RecoveryLedgerState,
  effectiveConcurrency: number,
): boolean {
  if (effectiveConcurrency <= 1 || calls.length <= 1) return false;
  if (ledger.slot !== null) return false;
  if (ledger.unknownOutcomes.length > 0) return false;

  for (const call of calls) {
    const reg = registry.get(call.name);
    if (!reg || reg.idempotent !== true || reg.concurrentSafe !== true) {
      return false;
    }
  }
  return true;
}

export async function dispatchToolBatch(
  calls: AcceptedToolCall[],
  registry: Map<string, ToolRegistration>,
  ledger: RecoveryLedgerState,
  budget: BudgetState,
  config: ParallelDispatchConfig,
  nowMs: () => number = () => Date.now(),
): Promise<ToolResult[]> {
  const { effectiveConcurrency } = validateDispatchConfig(config);
  const concurrent = canRunConcurrently(calls, registry, ledger, effectiveConcurrency);
  const results: Array<ToolResult | undefined> = new Array(calls.length);

  let batchAborted = false;
  const startedCount = calls.length;

  const runOne = async (index: number): Promise<void> => {
    const call = calls[index];
    const reg = registry.get(call.name);

    if (batchAborted) {
      results[index] = {
        call_id: call.call_id,
        provider_call_id: call.provider_call_id,
        name: call.name,
        started: false,
        outcome: 'unstarted',
        unstartedReason: 'batch_aborted',
      };
      return;
    }

    if (config.deadlineMs !== undefined && nowMs() >= config.deadlineMs) {
      batchAborted = true;
      results[index] = {
        call_id: call.call_id,
        provider_call_id: call.provider_call_id,
        name: call.name,
        started: false,
        outcome: 'unstarted',
        unstartedReason: 'deadline_exceeded',
      };
      return;
    }

    if (reg?.service && ledger.quarantinedServices.has(reg.service)) {
      batchAborted = true;
      results[index] = {
        call_id: call.call_id,
        provider_call_id: call.provider_call_id,
        name: call.name,
        started: false,
        outcome: 'unstarted',
        unstartedReason: 'batch_aborted',
      };
      return;
    }

    // Atomic budget reservation
    if (budget.stepsRemaining < 1 || budget.usageRemaining < 1) {
      batchAborted = true;
      results[index] = {
        call_id: call.call_id,
        provider_call_id: call.provider_call_id,
        name: call.name,
        started: false,
        outcome: 'unstarted',
        unstartedReason: 'budget_exhausted',
      };
      return;
    }

    budget.stepsRemaining -= 1;
    budget.usageRemaining -= 1;
    budget.reservedSteps += 1;
    budget.reservedUsage += 1;

    if (!reg) {
      batchAborted = true;
      results[index] = {
        call_id: call.call_id,
        provider_call_id: call.provider_call_id,
        name: call.name,
        started: true,
        outcome: 'known_error',
        error: `Unknown tool: ${call.name}`,
      };
      return;
    }

    if (reg.validateArgs && call.parsedArgs && !reg.validateArgs(call.parsedArgs)) {
      batchAborted = true;
      results[index] = {
        call_id: call.call_id,
        provider_call_id: call.provider_call_id,
        name: call.name,
        started: true,
        outcome: 'invalid_args',
        error: `Invalid arguments for ${call.name}`,
      };
      return;
    }

    try {
      const value = await reg.execute(call.parsedArgs ?? {}, { call_id: call.call_id });
      results[index] = {
        call_id: call.call_id,
        provider_call_id: call.provider_call_id,
        name: call.name,
        started: true,
        outcome: 'success',
        value,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.toLowerCase().includes('timeout');
      const isUnknown = message.toLowerCase().includes('unknown');
      const outcome: ToolOutcomeKind = isUnknown ? 'unknown' : isTimeout ? 'timeout' : 'known_error';
      batchAborted = true;
      results[index] = {
        call_id: call.call_id,
        provider_call_id: call.provider_call_id,
        name: call.name,
        started: true,
        outcome,
        error: message,
      };
    }
  };

  if (concurrent) {
    // Bounded worker pool over lazy task thunks
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < startedCount) {
        const idx = nextIndex;
        nextIndex += 1;
        await runOne(idx);
      }
    };
    const workers = Array.from({ length: Math.min(effectiveConcurrency, startedCount) }, () => worker());
    await Promise.all(workers);
  } else {
    for (let i = 0; i < startedCount; i += 1) {
      await runOne(i);
    }
  }

  const finalResults = results.map((r) => r!);

  // Aggregate outcomes into RecoveryLedger: bind single slot to first unknown, else first known failure, in emitted order.
  let firstUnknown: ToolResult | undefined;
  let firstFailure: ToolResult | undefined;

  for (const res of finalResults) {
    if (!res.started) continue;
    if (res.outcome === 'unknown') {
      const reg = registry.get(res.name);
      ledger.unknownOutcomes.push({ call_id: res.call_id, toolName: res.name, service: reg?.service });
      if (reg?.service) {
        ledger.quarantinedServices.add(reg.service);
      }
      if (!firstUnknown) firstUnknown = res;
    } else if (res.outcome !== 'success' && !firstFailure) {
      firstFailure = res;
    }
  }

  const slotCandidate = firstUnknown ?? firstFailure;
  if (slotCandidate && ledger.slot === null) {
    const reg = registry.get(slotCandidate.name);
    ledger.slot = {
      call_id: slotCandidate.call_id,
      toolName: slotCandidate.name,
      service: reg?.service,
      outcome: slotCandidate.outcome as 'unknown' | 'known_error' | 'timeout' | 'invalid_args',
      attemptsRemaining: 1,
    };
  }

  return finalResults;
}

export interface TurnMessage {
  role: 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: RawToolCall[];
  reasoning_details?: unknown;
  call_id?: string;
  provider_call_id?: string;
}

export function compactTurnGroups(messages: TurnMessage[], maxMessages: number): TurnMessage[] {
  if (messages.length <= maxMessages) return messages;

  // Group assistant tool_calls with all following tool results
  const groups: TurnMessage[][] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const group: TurnMessage[] = [msg];
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        group.push(messages[j]);
        j += 1;
      }
      groups.push(group);
      i = j;
    } else {
      groups.push([msg]);
      i += 1;
    }
  }

  const kept: TurnMessage[] = [];
  let count = 0;
  for (let g = groups.length - 1; g >= 0; g -= 1) {
    const group = groups[g];
    if (count + group.length <= maxMessages || kept.length === 0) {
      kept.unshift(...group);
      count += group.length;
    } else {
      break;
    }
  }
  return kept;
}
