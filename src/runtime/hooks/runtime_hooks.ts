import type { HookConfig, HookContext, HookDecision, HookPoint } from "./types.js";
import {
  MAX_HOOKS,
  isNoticeTooLong,
  runHook,
  type HookRunResult,
} from "./types.js";

export interface HookTraceEvent {
  hook_point: HookPoint;
  decision: string;
  hook_error: boolean;
  fail_closed: boolean;
  notice_rejected?: boolean;
  elapsed_ms: number;
  call_id?: string;
  tool_name?: string;
}

export interface NoticeRecord {
  text: string;
  point: HookPoint;
  turn_index: number;
  /** pre_finalize notices are host metadata only, not model-facing. */
  model_facing: boolean;
}

export interface HookRuntimeState {
  enabled: boolean;
  trace: HookTraceEvent[];
  notices: NoticeRecord[];
  elided_notice_count: number;
  hook_errors: number;
}

export function createHookRuntimeState(
  config: HookConfig | undefined,
): HookRuntimeState {
  return {
    enabled: Boolean(config && config.hooks && config.hooks.length > 0),
    trace: [],
    notices: [],
    elided_notice_count: 0,
    hook_errors: 0,
  };
}

export function hooksForPoint(config: HookConfig | undefined, point: HookPoint) {
  if (!config?.hooks) return [];
  const all = config.hooks.filter((h) => h.point === point);
  return all.slice(0, MAX_HOOKS);
}

export interface ApplyHooksResult {
  denied: boolean;
  results: HookRunResult[];
  model_notice?: string;
}

/**
 * Apply registered hooks at a point. Does not grant tools, reset budgets,
 * open or close recovery slots, alter constraints, or mutate arguments.
 */
export function applyHooks(
  config: HookConfig | undefined,
  state: HookRuntimeState,
  point: HookPoint,
  ctx: HookContext,
): ApplyHooksResult {
  const hooks = hooksForPoint(config, point);
  if (hooks.length === 0) {
    return { denied: false, results: [] };
  }
  const results: HookRunResult[] = [];
  let denied = false;
  for (const hook of hooks) {
    const result = runHook(point, hook.fn, ctx, hook.time_budget_ms);
    results.push(result);
    state.trace.push({
      hook_point: point,
      decision: result.decision,
      hook_error: result.hook_error,
      fail_closed: result.fail_closed,
      notice_rejected: result.notice_rejected,
      elapsed_ms: result.elapsed_ms,
      call_id: ctx.call_id,
      tool_name: ctx.tool_name,
    });
    if (result.hook_error) {
      state.hook_errors += 1;
      if (result.fail_closed) denied = true;
    }
    if (result.decision === "deny") {
      denied = true;
    }
    if (result.notice && !isNoticeTooLong(result.notice)) {
      const modelFacing = point !== "pre_finalize";
      state.notices.push({
        text: result.notice,
        point,
        turn_index: ctx.turn_index,
        model_facing: modelFacing,
      });
      const facing = state.notices.filter((n) => n.model_facing);
      if (facing.length > 1) {
        state.elided_notice_count += facing.length - 1;
      }
    }
  }
  const facing = state.notices.filter((n) => n.model_facing);
  const latest = facing.length > 0 ? facing[facing.length - 1].text : undefined;
  return { denied, results, model_notice: latest };
}

export function latestModelFacingNotice(
  state: HookRuntimeState,
): string | undefined {
  const facing = state.notices.filter((n) => n.model_facing);
  if (facing.length === 0) return undefined;
  return facing[facing.length - 1].text;
}

export type { HookDecision };
