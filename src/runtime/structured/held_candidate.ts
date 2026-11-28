import { createHash } from "node:crypto";

/** Minimal held-candidate seam for the first syntactic final_answer. */
export interface HeldCandidate {
  text: string;
  digest: string;
}

export class HeldCandidateSeam {
  private held: HeldCandidate | null = null;

  hold(text: string): void {
    if (typeof text !== "string") throw new TypeError("candidate text required");
    this.held = { text, digest: digestText(text) };
  }

  digest(): string | null {
    return this.held ? this.held.digest : null;
  }

  /** Release the held candidate unchanged to consolidated gates. */
  releaseToGates(): HeldCandidate | null {
    const current = this.held;
    this.held = null;
    return current;
  }

  drop(): void {
    this.held = null;
  }

  isHeld(): boolean {
    return this.held !== null;
  }

  peek(): HeldCandidate | null {
    return this.held ? { text: this.held.text, digest: this.held.digest } : null;
  }
}

export function digestText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function holdCandidate(seam: HeldCandidateSeam, text: string): void {
  seam.hold(text);
}

export function digestCandidate(seam: HeldCandidateSeam): string | null {
  return seam.digest();
}

export function releaseCandidate(seam: HeldCandidateSeam): HeldCandidate | null {
  return seam.releaseToGates();
}

export function dropCandidate(seam: HeldCandidateSeam): void {
  seam.drop();
}
