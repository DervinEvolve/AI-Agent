export {
  FAIL_CLOSED_POINTS,
  IMMUTABLE_EXEMPT_TOOLS,
  MAX_HOOKS,
  MAX_NOTICE_BYTES,
  DEFAULT_REPEAT_N,
  DEFAULT_NO_PROGRESS_K,
  DEFAULT_OSCILLATION_MIN,
  DEFAULT_POST_WATERMARK_M,
  canonicalArgsDigest,
  canonicalize,
  denyAllowedAt,
  evaluateStall,
  interpretHookOutcome,
  isFailClosed,
  isNoticeTooLong,
  noticeByteLength,
  resolveExemptTools,
  runHook,
} from "./types.js";

export type {
  HookConfig,
  HookContext,
  HookDecision,
  HookDecisionKind,
  HookPoint,
  HookRunResult,
  RegisteredHook,
  StallConfig,
  StallRecord,
  StallRule,
  StallVerdict,
  StallWindowState,
} from "./types.js";

export {
  createStallState,
  observeStall,
  pushStallRecord,
} from "./stall_detector.js";
export type { StallDetectorState } from "./stall_detector.js";

export {
  applyHooks,
  createHookRuntimeState,
  hooksForPoint,
  latestModelFacingNotice,
} from "./runtime_hooks.js";
export type {
  ApplyHooksResult,
  HookRuntimeState,
  HookTraceEvent,
  NoticeRecord,
} from "./runtime_hooks.js";
