export type ChildOutcome =
  | 'completed'
  | 'failed'
  | 'step_limit'
  | 'turn_limit'
  | 'deadline'
  | 'cancelled'
  | 'not_started'
  | 'error';

export type DelegateManyClassifierOutcome =
  | 'pre_execution_rejection'
  | 'success'
  | 'known_failure'
  | 'unknown';

export interface ParallelDelegationConfig {
  enabled: boolean;
  maxFanOut: number;
  maxConcurrency: number;
}

export interface DelegateManyTaskInput {
  subtask_id: string;
  task: string;
  allowed_tools?: string[];
  max_steps?: number;
  timeout_ms?: number;
}

export interface ChildCitationRecord {
  child_call_id: string;
  tool_name: string;
  success: boolean;
}

export interface DelegateManySubtaskResult {
  subtask_id: string;
  task_index: number;
  child_started: boolean;
  outcome: ChildOutcome;
  summary: string;
  citations: ChildCitationRecord[];
  steps_used: number;
  error?: string;
  termination_confirmed: boolean;
  cleanup_confirmed: boolean;
}

export interface DelegateManyOutput {
  started: boolean;
  rejected?: boolean;
  ok: boolean;
  settled: boolean;
  total_tasks: number;
  completed_count: number;
  failed_count: number;
  truncated: boolean;
  termination_confirmed: boolean;
  cleanup_confirmed: boolean;
  results: DelegateManySubtaskResult[];
  error?: string;
  stored_report_id?: string;
}

export const DENIED_DELEGATE_MANY_TOOLS = new Set<string>([
  'delegate_task',
  'delegate_many',
  'search_knowledge',
  'search_web',
  'fetch_web',
  'read_web',
  'search_memory',
  'read_memory',
  'write_memory',
  'run_code',
  'run_command',
  'write_file',
  'edit_file',
]);

const SUBTASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SUMMARY_BYTES = 2048;
const MAX_TRANSCRIPT_VIEW_BYTES = 32 * 1024;

export function hasLoneSurrogates(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function truncateUtf8(str: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) {
    return { text: str, truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--;
  }
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

export function validateParallelDelegationConfig(raw: unknown): ParallelDelegationConfig {
  if (raw === undefined) {
    return { enabled: false, maxFanOut: 4, maxConcurrency: 4 };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('delegation.parallel must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const allowedKeys = new Set(['enabled', 'maxFanOut', 'maxConcurrency']);
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown delegation.parallel key: ${key}`);
    }
  }
  if (typeof obj.enabled !== 'boolean') {
    throw new Error('delegation.parallel.enabled must be a boolean');
  }
  if (!obj.enabled) {
    return { enabled: false, maxFanOut: 4, maxConcurrency: 4 };
  }
  const maxFanOut = obj.maxFanOut === undefined ? 4 : obj.maxFanOut;
  if (typeof maxFanOut !== 'number' || !Number.isInteger(maxFanOut) || maxFanOut < 2 || maxFanOut > 8) {
    throw new Error('delegation.parallel.maxFanOut must be an integer between 2 and 8');
  }
  const maxConcurrency = obj.maxConcurrency === undefined ? maxFanOut : obj.maxConcurrency;
  if (
    typeof maxConcurrency !== 'number' ||
    !Number.isInteger(maxConcurrency) ||
    maxConcurrency < 1 ||
    maxConcurrency > 8 ||
    maxConcurrency > maxFanOut
  ) {
    throw new Error('delegation.parallel.maxConcurrency must be an integer between 1 and maxFanOut');
  }
  return { enabled: true, maxFanOut, maxConcurrency };
}

export function isEligibleForDelegateMany(
  tool: { name: string; idempotent?: boolean },
  allowedTools: ReadonlySet<string>,
): boolean {
  if (!allowedTools.has(tool.name)) return false;
  if (tool.idempotent !== true) return false;
  if (DENIED_DELEGATE_MANY_TOOLS.has(tool.name)) return false;
  if (tool.name.startsWith('skill_') || tool.name.startsWith('mcp_')) return false;
  return true;
}

export function computeChildEligibleSet(
  registryTools: Array<{ name: string; idempotent?: boolean }>,
  allowedTools: string[],
): Set<string> {
  const allowed = new Set(allowedTools);
  const eligible = new Set<string>();
  for (const tool of registryTools) {
    if (isEligibleForDelegateMany(tool, allowed)) {
      eligible.add(tool.name);
    }
  }
  return eligible;
}

export interface ValidateArgsOptions {
  maxFanOut: number;
  eligibleTools: ReadonlySet<string>;
  hostMaxChildSteps: number;
  hostMaxChildTimeoutMs: number;
}

export function validateDelegateManyArgs(
  raw: unknown,
  opts: ValidateArgsOptions,
): { valid: true; tasks: DelegateManyTaskInput[] } | { valid: false; error: string; started: false } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { valid: false, error: 'invalid_args: arguments must be an object', started: false };
  }
  const obj = raw as Record<string, unknown>;
  const topKeys = Object.keys(obj);
  if (topKeys.length !== 1 || topKeys[0] !== 'tasks') {
    return { valid: false, error: 'invalid_args: unknown or missing top-level keys', started: false };
  }
  if (!Array.isArray(obj.tasks) || obj.tasks.length < 1 || obj.tasks.length > opts.maxFanOut) {
    return {
      valid: false,
      error: `invalid_args: tasks must be an array of 1..${opts.maxFanOut} items`,
      started: false,
    };
  }

  const allowedTaskKeys = new Set(['subtask_id', 'task', 'allowed_tools', 'max_steps', 'timeout_ms']);
  const seenIds = new Set<string>();
  const validated: DelegateManyTaskInput[] = [];

  for (let i = 0; i < obj.tasks.length; i++) {
    const item = obj.tasks[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { valid: false, error: `invalid_args: task[${i}] must be an object`, started: false };
    }
    const t = item as Record<string, unknown>;
    for (const key of Object.keys(t)) {
      if (!allowedTaskKeys.has(key)) {
        return { valid: false, error: `invalid_args: unknown key ${key} in task[${i}]`, started: false };
      }
    }
    if (typeof t.subtask_id !== 'string' || !SUBTASK_ID_RE.test(t.subtask_id)) {
      return { valid: false, error: `invalid_args: invalid subtask_id in task[${i}]`, started: false };
    }
    if (seenIds.has(t.subtask_id)) {
      return { valid: false, error: `invalid_args: duplicate subtask_id ${t.subtask_id}`, started: false };
    }
    seenIds.add(t.subtask_id);

    if (typeof t.task !== 'string' || hasLoneSurrogates(t.task)) {
      return { valid: false, error: `invalid_args: invalid task string in task[${i}]`, started: false };
    }
    const taskBytes = Buffer.byteLength(t.task, 'utf8');
    if (taskBytes < 1 || taskBytes > 4000) {
      return { valid: false, error: `invalid_args: task[${i}] must be 1..4000 UTF-8 bytes`, started: false };
    }

    let allowed_tools: string[] | undefined;
    if (t.allowed_tools !== undefined) {
      if (!Array.isArray(t.allowed_tools) || !t.allowed_tools.every((x) => typeof x === 'string')) {
        return { valid: false, error: `invalid_args: allowed_tools in task[${i}] must be string[]`, started: false };
      }
      for (const toolName of t.allowed_tools) {
        if (!opts.eligibleTools.has(toolName)) {
          return {
            valid: false,
            error: `invalid_args: ineligible tool ${toolName} in task[${i}]`,
            started: false,
          };
        }
      }
      allowed_tools = [...t.allowed_tools];
    }

    let max_steps: number | undefined;
    if (t.max_steps !== undefined) {
      if (typeof t.max_steps !== 'number' || !Number.isInteger(t.max_steps) || t.max_steps < 1 || t.max_steps > opts.hostMaxChildSteps) {
        return { valid: false, error: `invalid_args: invalid max_steps in task[${i}]`, started: false };
      }
      max_steps = t.max_steps;
    }

    let timeout_ms: number | undefined;
    if (t.timeout_ms !== undefined) {
      if (
        typeof t.timeout_ms !== 'number' ||
        !Number.isInteger(t.timeout_ms) ||
        t.timeout_ms < 100 ||
        t.timeout_ms > opts.hostMaxChildTimeoutMs
      ) {
        return { valid: false, error: `invalid_args: invalid timeout_ms in task[${i}]`, started: false };
      }
      timeout_ms = t.timeout_ms;
    }

    validated.push({
      subtask_id: t.subtask_id,
      task: t.task,
      allowed_tools,
      max_steps,
      timeout_ms,
    });
  }

  return { valid: true, tasks: validated };
}

export function classifyDelegateManyOutcome(params: {
  started: boolean;
  outerStatus: 'ok' | 'timeout';
  settled: boolean;
  ok: boolean;
}): DelegateManyClassifierOutcome {
  if (!params.started) return 'pre_execution_rejection';
  if (params.outerStatus === 'timeout' || !params.settled) return 'unknown';
  return params.ok ? 'success' : 'known_failure';
}

export function validateDelegateManyCitation(
  citation: Record<string, unknown>,
  currentRunResults: Map<string, DelegateManyOutput>,
): { valid: true } | { valid: false; reason: string } {
  if ('passage_id' in citation && citation.passage_id !== undefined) {
    return { valid: false, reason: 'passage_id is rejected for delegate_many citations' };
  }
  const { call_id, subtask_id, child_call_id } = citation;
  if (typeof call_id !== 'string' || !call_id) {
    return { valid: false, reason: 'missing call_id' };
  }
  if (typeof subtask_id !== 'string' || !subtask_id) {
    return { valid: false, reason: 'missing subtask_id' };
  }
  if (typeof child_call_id !== 'string' || !child_call_id) {
    return { valid: false, reason: 'missing child_call_id' };
  }

  const parentOutput = currentRunResults.get(call_id);
  if (!parentOutput || !parentOutput.settled) {
    return { valid: false, reason: 'parent delegate_many call not found or not settled' };
  }

  const subtask = parentOutput.results.find((r) => r.subtask_id === subtask_id);
  if (!subtask) {
    return { valid: false, reason: `subtask_id ${subtask_id} not found in call ${call_id}` };
  }
  if (subtask.outcome !== 'completed') {
    return { valid: false, reason: `subtask ${subtask_id} did not complete (outcome=${subtask.outcome})` };
  }

  const match = subtask.citations.find((c) => c.child_call_id === child_call_id && c.success === true);
  if (!match) {
    return { valid: false, reason: `child_call_id ${child_call_id} not found with success=true` };
  }
  return { valid: true };
}

export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.tail;
    this.tail = prev.then(() => next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export interface ChildExecutionContext {
  parentCallId: string;
  subtask: DelegateManyTaskInput;
  taskIndex: number;
  signal: AbortSignal;
  reserveParentStep: () => boolean;
  completeWithMutex: <T>(fn: () => Promise<T>) => Promise<T>;
  reportUnknownUsage: () => void;
}

export interface ExecuteDelegateManyOptions {
  parentCallId: string;
  rawArgs: unknown;
  config: ParallelDelegationConfig;
  eligibleTools: ReadonlySet<string>;
  hostMaxChildSteps: number;
  hostMaxChildTimeoutMs: number;
  parentRecoverySlotOpen: boolean;
  hasUnresolvedUnknown: boolean;
  remainingParentSteps: { count: number };
  cleanupAllowanceMs?: number;
  parentSignal?: AbortSignal;
  storeFullReport: (report: DelegateManyOutput) => string | null;
  runChild: (ctx: ChildExecutionContext) => Promise<Omit<DelegateManySubtaskResult, 'subtask_id' | 'task_index'>>;
}

export async function executeDelegateMany(opts: ExecuteDelegateManyOptions): Promise<DelegateManyOutput> {
  if (opts.parentRecoverySlotOpen || opts.hasUnresolvedUnknown) {
    return {
      started: false,
      rejected: true,
      ok: false,
      settled: true,
      total_tasks: 0,
      completed_count: 0,
      failed_count: 0,
      truncated: false,
      termination_confirmed: true,
      cleanup_confirmed: true,
      results: [],
      error: 'pre_execution_rejection: open recovery slot or unresolved unknown outcome',
    };
  }

  const validation = validateDelegateManyArgs(opts.rawArgs, {
    maxFanOut: opts.config.maxFanOut,
    eligibleTools: opts.eligibleTools,
    hostMaxChildSteps: opts.hostMaxChildSteps,
    hostMaxChildTimeoutMs: opts.hostMaxChildTimeoutMs,
  });
  if (!validation.valid) {
    return {
      started: false,
      rejected: true,
      ok: false,
      settled: true,
      total_tasks: 0,
      completed_count: 0,
      failed_count: 0,
      truncated: false,
      termination_confirmed: true,
      cleanup_confirmed: true,
      results: [],
      error: validation.error,
    };
  }

  const tasks = validation.tasks;
  const results: DelegateManySubtaskResult[] = tasks.map((t, idx) => ({
    subtask_id: t.subtask_id,
    task_index: idx,
    child_started: false,
    outcome: 'not_started',
    summary: '',
    citations: [],
    steps_used: 0,
    termination_confirmed: true,
    cleanup_confirmed: true,
  }));

  const completeMutex = new AsyncMutex();
  const globalAbort = new AbortController();
  let unknownUsageTriggered = false;
  let nextIndex = 0;
  let closedForLateWrites = false;

  const onParentAbort = () => globalAbort.abort();
  if (opts.parentSignal) {
    if (opts.parentSignal.aborted) globalAbort.abort();
    else opts.parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  const reserveParentStep = (): boolean => {
    if (opts.remainingParentSteps.count <= 0) return false;
    opts.remainingParentSteps.count -= 1;
    return true;
  };

  const runWorker = async (): Promise<void> => {
    while (true) {
      if (globalAbort.signal.aborted || unknownUsageTriggered) return;
      const idx = nextIndex++;
      if (idx >= tasks.length) return;
      const subtask = tasks[idx];
      const childAbort = new AbortController();
      const onGlobalAbort = () => childAbort.abort();
      globalAbort.signal.addEventListener('abort', onGlobalAbort, { once: true });

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (subtask.timeout_ms !== undefined) {
        timeoutId = setTimeout(() => childAbort.abort(), subtask.timeout_ms);
      }

      try {
        const childPromise = opts.runChild({
          parentCallId: opts.parentCallId,
          subtask,
          taskIndex: idx,
          signal: childAbort.signal,
          reserveParentStep,
          completeWithMutex: (fn) => completeMutex.runExclusive(fn),
          reportUnknownUsage: () => {
            unknownUsageTriggered = true;
            globalAbort.abort();
          },
        });

        const cleanupMs = opts.cleanupAllowanceMs ?? 50;
        const outcome = await Promise.race([
          childPromise.then((res) => ({ kind: 'done' as const, res })),
          new Promise<{ kind: 'unsettled' }>((resolve) => {
            childAbort.signal.addEventListener(
              'abort',
              () => {
                setTimeout(() => resolve({ kind: 'unsettled' }), cleanupMs);
              },
              { once: true },
            );
          }),
        ]);

        if (closedForLateWrites) return;

        if (outcome.kind === 'unsettled') {
          results[idx] = {
            subtask_id: subtask.subtask_id,
            task_index: idx,
            child_started: true,
            outcome: 'error',
            summary: '',
            citations: [],
            steps_used: 0,
            error: 'child did not settle within cleanup allowance',
            termination_confirmed: false,
            cleanup_confirmed: false,
          };
          globalAbort.abort();
          return;
        }

        const trunc = truncateUtf8(outcome.res.summary, MAX_SUMMARY_BYTES);
        results[idx] = {
          subtask_id: subtask.subtask_id,
          task_index: idx,
          ...outcome.res,
          summary: trunc.text,
        };
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        globalAbort.signal.removeEventListener('abort', onGlobalAbort);
      }
    }
  };

  const poolSize = Math.min(opts.config.maxConcurrency, tasks.length);
  await Promise.all(Array.from({ length: poolSize }, () => runWorker()));
  closedForLateWrites = true;
  if (opts.parentSignal) {
    opts.parentSignal.removeEventListener('abort', onParentAbort);
  }

  const termination_confirmed = results.every((r) => r.termination_confirmed);
  const cleanup_confirmed = results.every((r) => r.cleanup_confirmed);
  const settled = termination_confirmed && cleanup_confirmed;
  const completed_count = results.filter((r) => r.outcome === 'completed').length;
  const failed_count = results.length - completed_count;
  const ok = settled && completed_count === results.length;

  const fullReport: DelegateManyOutput = {
    started: true,
    ok,
    settled,
    total_tasks: results.length,
    completed_count,
    failed_count,
    truncated: false,
    termination_confirmed,
    cleanup_confirmed,
    results,
  };

  const storedId = opts.storeFullReport(fullReport);
  if (!storedId) {
    return {
      started: true,
      ok: false,
      settled: true,
      total_tasks: results.length,
      completed_count: 0,
      failed_count: results.length,
      truncated: false,
      termination_confirmed,
      cleanup_confirmed,
      results: [],
      error: 'failed to persist full report to ObservationStore',
    };
  }

  const serializedBytes = Buffer.byteLength(JSON.stringify(fullReport), 'utf8');
  return {
    ...fullReport,
    truncated: serializedBytes > MAX_TRANSCRIPT_VIEW_BYTES,
    stored_report_id: storedId,
  };
}
