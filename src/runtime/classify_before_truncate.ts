export type OutcomeClassification = 'success' | 'known_failure' | 'unknown';

export interface ToolResultLike {
  status?: string;
  output?: { ok?: boolean; [key: string]: unknown } | string;
  termination_confirmed?: boolean;
  cleanup_confirmed?: boolean;
  [key: string]: unknown;
}

export const BROWSER_VIEW_CAP_BYTES = 24 * 1024;

/**
 * Classifies a complete in-hand ToolResult before any transcript view truncation.
 *
 * Order-only fix: this never reads ObservationStore and never classifies from a
 * truncated view. It uses the outer status, output.ok, termination_confirmed,
 * and cleanup_confirmed exactly as they exist on the full result.
 */
export function classifyBeforeTruncate(result: ToolResultLike): OutcomeClassification {
  if (!result || typeof result !== 'object') {
    return 'unknown';
  }

  const outerStatus = result.status;
  const output = result.output;
  const ok = typeof output === 'object' && output !== null ? output.ok : undefined;
  const terminationConfirmed = result.termination_confirmed;
  const cleanupConfirmed = result.cleanup_confirmed;

  if (outerStatus !== undefined && outerStatus !== 'ok') {
    return 'known_failure';
  }

  if (ok === false) {
    return 'known_failure';
  }

  if (terminationConfirmed === false || cleanupConfirmed === false) {
    return 'unknown';
  }

  if (outerStatus === 'ok' && ok === true && terminationConfirmed !== false && cleanupConfirmed !== false) {
    return 'success';
  }

  return 'unknown';
}

export interface StoredObservation {
  id: string;
  value: unknown;
  fullOutput: string;
}

export interface RecallPage {
  nodes: StoredObservation[];
  nextOffset: number;
  hasMore: boolean;
}

/**
 * A minimal bounded recall store that keeps full values in memory and returns
 * pages by advancing offsets. It is intentionally independent of network or
 * refetching: every stored node and its full value can be recovered by walking
 * pages until hasMore is false.
 */
export class PagedRecallStore {
  private nodes: StoredObservation[] = [];
  private nextId = 1;

  store(value: unknown): string {
    const id = `obs-${this.nextId++}`;
    const fullOutput = typeof value === 'string' ? value : JSON.stringify(value);
    this.nodes.push({ id, value, fullOutput });
    return id;
  }

  recall(offset: number, limit: number): RecallPage {
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.max(1, Math.floor(limit));
    const page = this.nodes.slice(safeOffset, safeOffset + safeLimit);
    const nextOffset = safeOffset + page.length;

    return {
      nodes: page,
      nextOffset,
      hasMore: nextOffset < this.nodes.length,
    };
  }
}
