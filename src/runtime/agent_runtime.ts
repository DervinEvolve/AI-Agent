import { ActionDecoder, type Citation } from './action_decoder';
import type { ObservedRecord } from './evidence_validator';
import { Finalizer, type TaskContract } from './finalizer';
import { ObservationStore } from './observation_store';
import { OutcomeClassifier, type ToolResultLike } from './outcome_classifier';
import { RecoveryLedger, type LedgerSnapshot, type UnresolvedItem } from './recovery_ledger';
import {
  RuntimeContextManager,
  type ToolSchemaLike,
  type TranscriptEntry,
} from './runtime_context';

export interface UsageInfo {
  tokens?: number;
  cost?: number;
}

export interface ModelAdapter {
  complete(request: unknown): Promise<{
    response: unknown;
    usage?: UsageInfo;
  }>;
}

export interface ToolRegistryLike {
  call(name: string, args: Record<string, unknown>): Promise<ToolResultLike>;
  isIdempotent(name: string): boolean;
  listSchemas?: () => ToolSchemaLike[];
}

export interface HostConfig {
  registry: ToolRegistryLike;
  toolSchemas?: ToolSchemaLike[];
  classifier?: OutcomeClassifier;
  contract?: TaskContract;
  max_steps?: number;
  max_turns?: number;
  max_tokens?: number;
  max_cost?: number;
  max_context_bytes?: number;
  deadline_ms?: number;
  finalization_reserve_ms?: number;
  preview_limit?: number;
}

export interface RunReport {
  outcome: 'completion' | 'incomplete' | 'failed';
  answer: string;
  citations: Citation[];
  steps: number;
  turns: number;
  usage: { knownTokens: number; knownCost: number; unknownUsageSeen: boolean };
  ledger: LedgerSnapshot;
  unresolved: UnresolvedItem[];
  capabilities: Record<string, string>;
  validator: 'subset';
  reasons: string[];
}

const UNAVAILABLE_SERVICES: Record<string, string> = {
  run_code: 'unavailable',
  workspace: 'unavailable',
  web: 'unavailable',
  browser: 'unavailable',
  MCP: 'unavailable',
  memory: 'unavailable',
  skills: 'unavailable',
  compaction_summarizer: 'unavailable',
  delegation: 'unavailable',
  durability: 'unavailable',
  live_adapter: 'unavailable',
};

const RECALL_SCHEMA: ToolSchemaLike = {
  name: 'recall',
  description: 'Read-only bounded recall of a stored observation by call_id.',
  idempotent: true,
  inputSchema: {
    type: 'object',
    properties: {
      call_id: { type: 'string' },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 4096 },
    },
    required: ['call_id'],
    additionalProperties: false,
  },
};

export class AgentRuntime {
  async run(task: string, adapter: ModelAdapter, hostConfig: HostConfig): Promise<RunReport> {
    const maxSteps = hostConfig.max_steps ?? 16;
    const maxTurns = hostConfig.max_turns ?? 16;
    const startTime = Date.now();
    const deadlineMs = hostConfig.deadline_ms;
    const reserveMs = hostConfig.finalization_reserve_ms ?? 50;

    const store = new ObservationStore(hostConfig.preview_limit ?? 256);
    const classifier = hostConfig.classifier ?? new OutcomeClassifier();
    const ledger = new RecoveryLedger();
    const contextManager = new RuntimeContextManager();
    const decoder = new ActionDecoder();
    const finalizer = new Finalizer();

    const baseSchemas = hostConfig.registry.listSchemas
      ? hostConfig.registry.listSchemas()
      : hostConfig.toolSchemas ?? [];
    const toolSchemas: ToolSchemaLike[] = [
      ...baseSchemas.filter((s) => s.name !== 'recall'),
      RECALL_SCHEMA,
    ];

    const transcript: TranscriptEntry[] = [];
    const observations = new Map<string, ObservedRecord>();
    const toolOutputsByCallId = new Map<
      string,
      { toolName: string; status: string; output: unknown }
    >();

    let steps = 0;
    let turns = 0;
    let consecutiveRejects = 0;
    let knownTokens = 0;
    let knownCost = 0;
    let unknownUsageSeen = false;
    let callCounter = 0;
    const reasons: string[] = [];

    const buildReport = (
      outcome: RunReport['outcome'],
      answer: string,
      citations: Citation[] = [],
    ): RunReport => {
      const snapshot = ledger.getSnapshot();
      return {
        outcome,
        answer,
        citations,
        steps,
        turns,
        usage: { knownTokens, knownCost, unknownUsageSeen },
        ledger: snapshot,
        unresolved: snapshot.unresolved,
        capabilities: { ...UNAVAILABLE_SERVICES },
        validator: 'subset',
        reasons,
      };
    };

    while (turns < maxTurns && steps < maxSteps) {
      if (hostConfig.max_tokens !== undefined) {
        if (unknownUsageSeen || knownTokens >= hostConfig.max_tokens) {
          reasons.push(unknownUsageSeen ? 'unknown_usage_under_cap' : 'token_cap_exhausted');
          return buildReport('incomplete', 'Budget cap reached before completion.');
        }
      }
      if (hostConfig.max_cost !== undefined) {
        if (unknownUsageSeen || knownCost >= hostConfig.max_cost) {
          reasons.push(unknownUsageSeen ? 'unknown_usage_under_cap' : 'cost_cap_exhausted');
          return buildReport('incomplete', 'Cost cap reached before completion.');
        }
      }

      const ledgerSnap = ledger.getSnapshot();
      const rendered = contextManager.render(
        task,
        {
          instructions: 'Use registered tools and cite call_id evidence.',
          step: steps,
          turn: turns,
          intentId: ledgerSnap.intentId,
          remainingAllowance: ledgerSnap.remainingAllowance,
        },
        transcript,
        toolSchemas,
        hostConfig.max_context_bytes,
      );

      if (rendered.overflow) {
        reasons.push('context_overflow');
        return buildReport('incomplete', 'Context capacity exceeded.');
      }

      let remainingWaitMs: number | undefined;
      if (deadlineMs !== undefined) {
        remainingWaitMs = deadlineMs - (Date.now() - startTime) - reserveMs;
        if (remainingWaitMs <= 0) {
          reasons.push('deadline_exceeded');
          return buildReport('incomplete', 'Deadline exceeded.');
        }
      }

      turns += 1;
      let completionResult: { response: unknown; usage?: UsageInfo };
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        const completePromise = adapter.complete(rendered);
        completePromise.catch(() => {});

        if (remainingWaitMs !== undefined) {
          completionResult = await Promise.race([
            completePromise.then((res) => {
              settled = true;
              return res;
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                if (!settled) {
                  reject(new Error('complete_timeout'));
                }
              }, remainingWaitMs);
            }),
          ]);
        } else {
          completionResult = await completePromise;
          settled = true;
        }
      } catch {
        reasons.push('complete_timeout_or_error');
        return buildReport('incomplete', 'Model completion timed out or failed.');
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }

      if (!completionResult.usage) {
        if (hostConfig.max_tokens !== undefined || hostConfig.max_cost !== undefined) {
          unknownUsageSeen = true;
        }
      } else {
        if (typeof completionResult.usage.tokens === 'number') {
          knownTokens += completionResult.usage.tokens;
        } else if (hostConfig.max_tokens !== undefined) {
          unknownUsageSeen = true;
        }
        if (typeof completionResult.usage.cost === 'number') {
          knownCost += completionResult.usage.cost;
        } else if (hostConfig.max_cost !== undefined) {
          unknownUsageSeen = true;
        }
      }

      const action = decoder.decode(completionResult.response, toolSchemas);
      if (action.kind === 'rejected') {
        consecutiveRejects += 1;
        reasons.push(`action_rejected:${action.reason}`);
        if (consecutiveRejects >= 3) {
          reasons.push('three_consecutive_rejects');
          return buildReport('failed', 'Run failed after three consecutive invalid actions.');
        }
        continue;
      }

      consecutiveRejects = 0;

      if (action.kind === 'plan_revision') {
        continue;
      }

      if (action.kind === 'final_answer') {
        ledger.closeOnFinalize();
        const fin = finalizer.finalize(
          action.text,
          action.citations,
          {
            observations,
            unresolved: ledger.getSnapshot().unresolved,
            toolOutputsByCallId,
          },
          hostConfig.contract,
          action.claimsNoToolEvidence,
        );
        reasons.push(...fin.reasons);
        return buildReport(fin.published, action.text, action.citations ?? []);
      }

      // tool_call
      const isRecall = action.toolName === 'recall';
      const idempotent = isRecall ? true : hostConfig.registry.isIdempotent(action.toolName);
      const admission = ledger.admit(action.toolName, idempotent, isRecall);
      if (!admission.allowed) {
        reasons.push(admission.reason);
        transcript.push({
          call_id: `refused_${++callCounter}`,
          toolName: action.toolName,
          status: 'refused',
          truncated: false,
          preview: admission.reason,
        });
        continue;
      }

      steps += 1;
      callCounter += 1;
      const callId = `call_${callCounter}`;

      let rawResult: ToolResultLike;
      if (isRecall) {
        const recallOut = store.recall(
          String(action.arguments.call_id),
          typeof action.arguments.offset === 'number' ? action.arguments.offset : 0,
          typeof action.arguments.limit === 'number' ? action.arguments.limit : 256,
        );
        rawResult = {
          call_id: callId,
          toolName: 'recall',
          status: recallOut.found ? 'ok' : 'error',
          output: recallOut,
          started: true,
        };
      } else {
        rawResult = await hostConfig.registry.call(action.toolName, action.arguments);
        rawResult = { ...rawResult, call_id: rawResult.call_id ?? callId, toolName: action.toolName };
      }

      const stored = store.append(rawResult);
      const classification = isRecall ? 'success' : classifier.classify(rawResult);
      ledger.record(stored.call_id, classification, action.toolName, idempotent, isRecall);

      observations.set(stored.call_id, {
        call_id: stored.call_id,
        started: stored.started,
        classification,
      });
      toolOutputsByCallId.set(stored.call_id, {
        toolName: action.toolName,
        status: stored.status,
        output: stored.snapshot,
      });

      transcript.push({
        call_id: stored.call_id,
        toolName: stored.toolName,
        status: stored.status,
        truncated: stored.truncated,
        preview: stored.serializedPreview,
      });
    }

    reasons.push(steps >= maxSteps ? 'max_steps_reached' : 'max_turns_reached');
    return buildReport('incomplete', 'Run reached step or turn limit.');
  }
}
