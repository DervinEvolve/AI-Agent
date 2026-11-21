/**
 * Pre-mutation snapshot store (snapshot-on-first-write) + revert support.
 *
 * Before the first write of any file-editing intent, the runtime captures the
 * file's current bytes into a per-intent snapshot store keyed by
 * (intent_id, path). All repair attempts within that intent share the one
 * snapshot. Snapshots are discarded only when the verification gate passes;
 * if the recovery allowance is exhausted while the gate still fails, the
 * runtime reverts every snapshot in the intent atomically (all-or-nothing:
 * restore files first, then discard) and marks the intent failed-and-reverted.
 *
 * Safety semantics (mirroring proven prior art):
 * - capture failures are contained and never break the tool call
 * - restore is overwrite-only: it never deletes files created after capture
 * - revert_file is idempotent: no snapshot -> no-op
 * - it never touches files outside the intent's snapshot set
 * - permissions are preserved alongside bytes
 */

export interface SnapshotRecord {
  /** Absolute-or-workspace-relative path that was snapshotted. */
  readonly path: string;
  /** Byte-for-byte pre-mutation content; null means the file did not exist. */
  readonly content: string | null;
  /** File mode captured at snapshot time (e.g. 0o644), if available. */
  readonly mode: number | null;
  /** Monotonic capture sequence, for stable revert ordering. */
  readonly seq: number;
}

export interface IntentRevertResult {
  reverted: string[];
  /** Files whose snapshot said "did not exist" — restore leaves them alone. */
  skippedNonExistent: string[];
}

export interface IntentRevertNote {
  intentId: string;
  revertedPaths: string[];
  attempts: number;
  lastGateError: string | null;
  revertedAtBaseline: true;
}

/** Minimal fs surface the store needs; injected for testability. */
export interface SnapshotFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string, mode?: number | null): Promise<void>;
  statMode(path: string): Promise<number | null>;
  exists(path: string): Promise<boolean>;
}

export class PreMutationSnapshotStore {
  private intents = new Map<string, Map<string, SnapshotRecord>>();
  private nextSeq = 0;
  private attempts = new Map<string, number>();
  private lastGateErrors = new Map<string, string>();
  private revertedIntents = new Set<string>();

  constructor(private readonly fs: SnapshotFs) {}

  /**
   * Snapshot-on-first-write: captures (intentId, path) if not yet present.
   * Returns true if a new snapshot was taken, false if one already existed.
   * Capture failures are contained: an unreadable-but-existing file is
   * recorded with content null only when it truly does not exist; a genuine
   * read error is swallowed and reported via the returned status so the
   * calling tool call is never broken.
   */
  async capture(
    intentId: string,
    path: string,
  ): Promise<{ captured: boolean; ok: boolean }> {
    if (this.revertedIntents.has(intentId)) {
      // Intent already failed-and-reverted: do not re-snapshot a rolled-back
      // baseline; treat as unchanged.
      return { captured: false, ok: false };
    }
    const perIntent = this.ensureIntent(intentId);
    if (perIntent.has(path)) return { captured: false, ok: true };
    let content: string | null = null;
    let mode: number | null = null;
    let ok = true;
    try {
      const exists = await this.fs.exists(path);
      if (exists) {
        content = await this.fs.readFile(path);
        mode = await this.fs.statMode(path);
      }
    } catch {
      // Contained failure: never break the tool call. Record nothing so a
      // later revert cannot restore stale bytes.
      return { captured: false, ok: false };
    }
    perIntent.set(path, { path, content, mode, seq: this.nextSeq++ });
    return { captured: true, ok: true };
  }

  hasSnapshot(intentId: string, path: string): boolean {
    return this.intents.get(intentId)?.has(path) ?? false;
  }

  snapshotPaths(intentId: string): string[] {
    const perIntent = this.intents.get(intentId);
    if (!perIntent) return [];
    return [...perIntent.values()].sort((a, b) => a.seq - b.seq).map((r) => r.path);
  }

  recordAttempt(intentId: string, gateError: string | null): void {
    this.attempts.set(intentId, (this.attempts.get(intentId) ?? 0) + 1);
    if (gateError !== null) this.lastGateErrors.set(intentId, gateError);
  }

  attemptsFor(intentId: string): number {
    return this.attempts.get(intentId) ?? 0;
  }

  lastGateErrorFor(intentId: string): string | null {
    return this.lastGateErrors.get(intentId) ?? null;
  }

  isReverted(intentId: string): boolean {
    return this.revertedIntents.has(intentId);
  }

  /**
   * Gate passed: discard the intent's snapshots. Committed edits are never
   * reverts — after discard, revertFile is a no-op for this intent.
   */
  discard(intentId: string): void {
    this.intents.delete(intentId);
  }

  /**
   * Explicit, single-path revert. Idempotent: no snapshot for
   * (intentId, path) -> no-op. Never touches files outside the snapshot set.
   */
  async revertFile(intentId: string, path: string): Promise<boolean> {
    const record = this.intents.get(intentId)?.get(path);
    if (!record) return false;
    await this.restoreRecords([record]);
    this.intents.get(intentId)!.delete(path);
    return true;
  }

  /**
   * All-or-nothing intent revert: restore every snapshot byte-for-byte
   * (preserving mode), then discard the intent's snapshot set. Files that did
   * not exist pre-intent are left in place (overwrite-only semantics).
   */
  async revertIntent(intentId: string): Promise<IntentRevertResult> {
    const perIntent = this.intents.get(intentId);
    if (!perIntent || perIntent.size === 0) {
      this.revertedIntents.add(intentId);
      return { reverted: [], skippedNonExistent: [] };
    }
    const records = [...perIntent.values()].sort((a, b) => a.seq - b.seq);
    const toRestore = records.filter((r) => r.content !== null);
    const skipped = records.filter((r) => r.content === null).map((r) => r.path);
    // Restore ALL files first; only then discard. A crash mid-way leaves the
    // snapshots intact so a retry can finish the revert (never partial).
    await this.restoreRecords(toRestore);
    this.intents.delete(intentId);
    this.revertedIntents.add(intentId);
    return { reverted: toRestore.map((r) => r.path), skippedNonExistent: skipped };
  }

  /**
   * Build the structured context note appended after an automatic revert.
   */
  buildRevertNote(intentId: string): IntentRevertNote | null {
    if (!this.revertedIntents.has(intentId)) return null;
    return {
      intentId,
      revertedPaths: this.snapshotPaths(intentId),
      attempts: this.attemptsFor(intentId),
      lastGateError: this.lastGateErrorFor(intentId),
      revertedAtBaseline: true,
    };
  }

  private async restoreRecords(records: SnapshotRecord[]): Promise<void> {
    for (const r of records) {
      await this.fs.writeFile(r.path, r.content as string, r.mode);
    }
  }

  private ensureIntent(intentId: string): Map<string, SnapshotRecord> {
    let perIntent = this.intents.get(intentId);
    if (!perIntent) {
      perIntent = new Map();
      this.intents.set(intentId, perIntent);
    }
    return perIntent;
  }
}

/**
 * Render the revert note as a human/tool-visible context message instructing
 * the agent to treat the file as unchanged and replan (or report blocked).
 */
export function renderRevertNote(note: IntentRevertNote): string {
  const paths = note.revertedPaths.length
    ? note.revertedPaths.join(", ")
    : "(no snapshots were captured)";
  return [
    `[intent ${note.intentId}] FAILED AND REVERTED.`,
    `File(s): ${paths}`,
    `Attempts: ${note.attempts}`,
    `Last gate error: ${note.lastGateError ?? "none recorded"}`,
    "The file(s) are back at their pre-intent baseline byte-for-byte.",
    "Treat the file(s) as UNCHANGED: do not build later steps on the failed edit.",
    "Replan with a different strategy or report this intent as blocked.",
  ].join("\n");
}
