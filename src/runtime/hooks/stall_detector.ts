import {
  type StallConfig,
  type StallRecord,
  type StallRule,
  type StallVerdict,
  evaluateStall,
  resolveExemptTools,
} from "./types.js";

export interface StallDetectorState {
  window: StallRecord[];
  next_seq: number;
  watermark_seq: number | null;
  watermark_rule?: StallRule;
  notice_turn?: number;
  notices: string[];
  aborted: boolean;
}

export function createStallState(): StallDetectorState {
  return {
    window: [],
    next_seq: 1,
    watermark_seq: null,
    notices: [],
    aborted: false,
  };
}

const MAX_WINDOW = 64;

export function pushStallRecord(
  state: StallDetectorState,
  partial: Omit<StallRecord, "seq">,
): StallRecord {
  const rec: StallRecord = { ...partial, seq: state.next_seq };
  state.next_seq += 1;
  state.window.push(rec);
  if (state.window.length > MAX_WINDOW) {
    state.window.splice(0, state.window.length - MAX_WINDOW);
  }
  return rec;
}

export function observeStall(
  state: StallDetectorState,
  config: StallConfig | undefined,
  currentTurn: number,
): StallVerdict {
  if (state.aborted) {
    return {
      flagged: true,
      abort: true,
      notice: false,
      reason: "stall_detected",
      rule: state.watermark_rule,
    };
  }
  const exempt = resolveExemptTools(config?.exempt_tools);
  const verdict = evaluateStall(state.window, config, state.watermark_seq, {
    watermark_rule: state.watermark_rule,
    notice_turn: state.notice_turn,
    current_turn: currentTurn,
    exempt,
  });
  if (verdict.notice && verdict.watermark_index !== undefined) {
    state.watermark_seq = verdict.watermark_index;
    state.watermark_rule = verdict.rule;
    state.notice_turn = currentTurn;
  }
  if (verdict.abort) {
    state.aborted = true;
  }
  return verdict;
}
