import {
  TEARDOWN_RESERVE_DEFAULT_MS,
  TEARDOWN_RESERVE_HARD_MAX_MS,
  WORKER_REASON,
  type SharedReserveBucket,
} from "./types.js";

export interface ReserveClaim {
  ok: true;
  bucket: SharedReserveBucket;
  reserveMs: number;
  subtractedOnce: true;
}

export interface ReserveReject {
  ok: false;
  reason: typeof WORKER_REASON.INCOMPATIBLE_COMOUNT | typeof WORKER_REASON.STARTUP_REJECTED;
}

/**
 * Subtract one shared teardown reserve from the run deadline.
 * Jobs/composition co-mount must pass the same bucket; a second claim does not subtract again.
 * Incompatible jobs mount is rejected rather than double-subtracted.
 */
export function claimSharedTeardownReserve(input: {
  deadlineMs: number;
  requestedMs?: number;
  jobsMounted?: boolean;
  jobsReserveCompatible?: boolean;
  compositionMounted?: boolean;
  bucket?: SharedReserveBucket;
}): ReserveClaim | ReserveReject {
  const requested = input.requestedMs ?? TEARDOWN_RESERVE_DEFAULT_MS;
  if (requested < 0 || requested > TEARDOWN_RESERVE_HARD_MAX_MS) {
    return { ok: false, reason: WORKER_REASON.STARTUP_REJECTED };
  }
  if (input.jobsMounted && input.jobsReserveCompatible === false) {
    return { ok: false, reason: WORKER_REASON.INCOMPATIBLE_COMOUNT };
  }
  if (input.compositionMounted && input.jobsMounted && input.jobsReserveCompatible === false) {
    return { ok: false, reason: WORKER_REASON.INCOMPATIBLE_COMOUNT };
  }
  const bucket: SharedReserveBucket = input.bucket ?? {
    claimed: false,
    reserveMs: 0,
    owner: null,
    subtractedFromDeadline: false,
  };
  if (bucket.claimed) {
    return { ok: true, bucket, reserveMs: bucket.reserveMs, subtractedOnce: true };
  }
  if (input.deadlineMs < requested) {
    return { ok: false, reason: WORKER_REASON.STARTUP_REJECTED };
  }
  bucket.claimed = true;
  bucket.reserveMs = requested;
  bucket.owner = "workers+shared";
  bucket.subtractedFromDeadline = true;
  return { ok: true, bucket, reserveMs: requested, subtractedOnce: true };
}

export function operationalDeadline(runDeadlineMs: number, bucket: SharedReserveBucket): number {
  if (!bucket.subtractedFromDeadline) return runDeadlineMs;
  return runDeadlineMs - bucket.reserveMs;
}
