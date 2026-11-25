import type { InferencePermitLease, InferencePermitPort } from "./types.js";
import { MAX_CONCURRENT_INFERENCE_HARD_MAX } from "./types.js";

export class FifoInferencePermit implements InferencePermitPort {
  private held = 0;
  private seq = 0;
  private peakHeld = 0;
  private queue: Array<{
    resolve: (lease: InferencePermitLease) => void;
    reject: (err: Error) => void;
    signal?: AbortSignal;
  }> = [];

  constructor(private readonly maxConcurrent: number) {
    if (maxConcurrent < 1 || maxConcurrent > MAX_CONCURRENT_INFERENCE_HARD_MAX) {
      throw new Error("inference_permit_out_of_range");
    }
  }

  inFlight(): number {
    return this.held;
  }

  peak(): number {
    return this.peakHeld;
  }

  queued(): number {
    return this.queue.length;
  }

  acquire(signal?: AbortSignal): Promise<InferencePermitLease> {
    if (signal?.aborted) return Promise.reject(new Error("cancelled"));
    if (this.held < this.maxConcurrent && this.queue.length === 0) {
      return Promise.resolve(this.grant());
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal };
      const onAbort = () => {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new Error("cancelled"));
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  release(lease: InferencePermitLease): void {
    if (lease.released) return;
    lease.released = true;
    this.held = Math.max(0, this.held - 1);
    this.pump();
  }

  private grant(): InferencePermitLease {
    this.held += 1;
    if (this.held > this.peakHeld) this.peakHeld = this.held;
    return { id: ++this.seq, released: false };
  }

  private pump(): void {
    while (this.held < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      if (next.signal?.aborted) {
        next.reject(new Error("cancelled"));
        continue;
      }
      next.resolve(this.grant());
    }
  }
}
