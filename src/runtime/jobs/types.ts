export type JobState = 'running' | 'exited' | 'stopped' | 'killed_limit' | 'lost';

export const JOB_REASONS = [
  'job_not_running',
  'job_budget_exceeded',
  'job_exec_limit',
  'job_family_blocked',
] as const;
export type JobReason = (typeof JOB_REASONS)[number];

export const JOB_CAPS = {
  headBytes: 256 * 1024,
  ringBytes: 768 * 1024,
  outputBytes: 8 * 1024,
  maxPollWaitMs: 10000,
} as const;

export interface JobConfig {
  enabled: boolean;
  maxConcurrent: number;
  maxStarts: number;
  maxJobSeconds: number;
}

export interface JobRecord {
  job_id: string;
  state: JobState;
  exit_code?: number;
  started_at: number;
  ended_at?: number;
}

export interface JobPort {
  start(argv: string[]): Promise<{ job_id: string; started_at: number }>;
  poll(job_id: string): Promise<JobRecord>;
  stop(job_id: string): Promise<{ termination_confirmed: boolean; cleanup_confirmed: boolean }>;
}

export interface LogSlice {
  data: string;
  next_offset: number;
  gap?: { from: number; to: number };
  dropped_bytes: number;
}

/**
 * Slice a stream of total length `total` that retains head [0,head) and ring [total-ring,total).
 * `buf` holds the retained bytes: head bytes followed by ring bytes (or whole stream if no drop).
 */
export function sliceLogBytes(
  full: Uint8Array,
  total: number,
  offset: number,
  limit: number,
  tail = false,
  head: number = JOB_CAPS.headBytes,
  ring: number = JOB_CAPS.ringBytes,
): LogSlice {
  const dropped = Math.max(0, total - head - ring);
  const tailStart = total - ring;
  const byteAt = (abs: number): number =>
    abs < head || dropped === 0 ? full[abs] : full[head + (abs - tailStart)];
  let start = tail ? Math.max(0, total - limit) : Math.max(0, offset);
  let gap: { from: number; to: number } | undefined;
  if (dropped > 0 && start >= head && start < tailStart) {
    gap = { from: start, to: tailStart };
    start = tailStart;
  }
  if (dropped > 0 && start < head && start + limit > head) limit = head - start;
  let end = Math.min(total, start + Math.max(0, limit));
  if (start >= total) return { data: '', next_offset: total, gap, dropped_bytes: dropped };
  // skip leading continuation bytes
  while (start < end && (byteAt(start) & 0xc0) === 0x80) start++;
  // trim incomplete trailing code point
  if (end < total || true) {
    let i = end;
    let back = 0;
    while (i > start && back < 4 && (byteAt(i - 1) & 0xc0) === 0x80) {
      i--;
      back++;
    }
    if (i > start) {
      const lead = byteAt(i - 1);
      const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (need > back + 1) end = i - 1;
    }
  }
  const out = new Uint8Array(Math.max(0, end - start));
  for (let k = 0; k < out.length; k++) out[k] = byteAt(start + k);
  return {
    data: new TextDecoder().decode(out),
    next_offset: end,
    gap,
    dropped_bytes: dropped,
  };
}
