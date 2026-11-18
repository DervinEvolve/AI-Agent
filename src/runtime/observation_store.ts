import type { ToolResultLike } from './outcome_classifier';

export interface StoredObservation {
  call_id: string;
  toolName: string;
  status: string;
  started: boolean;
  truncated: boolean;
  totalLength: number;
  snapshot: unknown;
  serializedPreview: string;
}

export type RecallView =
  | {
      found: true;
      call_id: string;
      status: string;
      offset: number;
      limit: number;
      totalLength: number;
      hasMore: boolean;
      content: string;
    }
  | {
      found: false;
      error: 'not_found';
    };

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function safeBoundedSerialize(value: unknown, maxChars = 100_000): string {
  const seen = new WeakSet<object>();
  try {
    const str = JSON.stringify(value, (_key, val) => {
      if (typeof val === 'function') {
        return '[Function]';
      }
      if (typeof val === 'bigint') {
        return val.toString();
      }
      if (val !== null && typeof val === 'object') {
        if (seen.has(val)) {
          return '[Circular]';
        }
        seen.add(val);
      }
      return val;
    });
    if (str === undefined) {
      return String(value).slice(0, maxChars);
    }
    return str.length > maxChars ? str.slice(0, maxChars) : str;
  } catch {
    return String(value).slice(0, maxChars);
  }
}

function safeClone(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    const serialized = safeBoundedSerialize(value);
    try {
      return JSON.parse(serialized);
    } catch {
      return serialized;
    }
  }
}

export class ObservationStore {
  private readonly entries = new Map<string, StoredObservation>();
  private readonly previewLimit: number;
  private counter = 0;

  constructor(previewLimit = 256) {
    this.previewLimit = previewLimit;
  }

  append(result: ToolResultLike): StoredObservation {
    this.counter += 1;
    const callId = result.call_id ?? `call_${this.counter}`;
    const toolName = result.toolName ?? result.tool ?? 'unknown';
    const cloned = deepFreeze(safeClone(result.output ?? null));
    const fullText = safeBoundedSerialize(cloned);
    const truncated = fullText.length > this.previewLimit;
    const serializedPreview = truncated
      ? fullText.slice(0, this.previewLimit)
      : fullText;

    const entry: StoredObservation = Object.freeze({
      call_id: callId,
      toolName,
      status: result.status,
      started: result.started ?? true,
      truncated,
      totalLength: fullText.length,
      snapshot: cloned,
      serializedPreview,
      fullText,
    }) as StoredObservation & { fullText: string };

    this.entries.set(callId, entry);
    return entry;
  }

  recall(callId: string, offset = 0, limit = 256): RecallView {
    const entry = this.entries.get(callId) as
      | (StoredObservation & { fullText?: string })
      | undefined;
    if (!entry) {
      return { found: false, error: 'not_found' };
    }
    const fullText = entry.fullText ?? safeBoundedSerialize(entry.snapshot);
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.max(1, Math.min(4096, Math.floor(limit)));
    const slice = fullText.slice(safeOffset, safeOffset + safeLimit);
    return {
      found: true,
      call_id: entry.call_id,
      status: entry.status,
      offset: safeOffset,
      limit: safeLimit,
      totalLength: fullText.length,
      hasMore: safeOffset + slice.length < fullText.length,
      content: slice,
    };
  }

  get(callId: string): StoredObservation | undefined {
    return this.entries.get(callId);
  }

  list(): StoredObservation[] {
    return Array.from(this.entries.values());
  }
}
