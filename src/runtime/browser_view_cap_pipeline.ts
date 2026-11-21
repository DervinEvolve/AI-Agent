/**
 * Classify-before-view-cap pipeline for browser tool results
 * (cap_browser_interaction_13, classification_order + view_cap_contract).
 *
 * Order is fixed and enforced here:
 *   1. classify the FULL, intact result (classifier is injected; the shared
 *      classifier stays authoritative, this module does not define one),
 *   2. store the full output,
 *   3. build the capped transcript view.
 *
 * The classifier is never handed the capped view, and truncation is never a
 * classifier input. call_id, status and the truncation marker live outside the
 * payload. Recall pages the stored full output by byte offset.
 *
 * This module is self-contained on purpose: it imports nothing from the rest
 * of the runtime. See docs/browser-classify-before-view-cap.md.
 */

export const VIEW_CAP_BYTES = 24 * 1024;

export interface BrowserResultLike {
  call_id: string;
  output: string;
}

export interface FullOutputStore {
  put(callId: string, fullOutput: string): void;
  get(callId: string): string | undefined;
}

export class MapFullOutputStore implements FullOutputStore {
  private readonly items = new Map<string, string>();
  put(callId: string, fullOutput: string): void {
    this.items.set(callId, fullOutput);
  }
  get(callId: string): string | undefined {
    return this.items.get(callId);
  }
}

export interface TruncationMarker {
  truncated: true;
  total_bytes: number;
  view_bytes: number;
  /** Byte offset at which recall should continue. */
  next_offset: number;
}

export interface CappedView<C> {
  call_id: string;
  status: C;
  truncation: TruncationMarker | null;
  payload: string;
}

export interface Utf8Cap {
  text: string;
  truncated: boolean;
  viewBytes: number;
  totalBytes: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function assertCap(n: number, name: string): void {
  if (!Number.isInteger(n) || n <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

/** Cap text at maxBytes of UTF-8 without splitting a multibyte character. */
export function capUtf8(text: string, maxBytes: number = VIEW_CAP_BYTES): Utf8Cap {
  assertCap(maxBytes, 'maxBytes');
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) {
    return { text, truncated: false, viewBytes: bytes.length, totalBytes: bytes.length };
  }
  let cut = maxBytes;
  while (cut > 0 && isContinuation(bytes[cut])) cut--;
  return {
    text: decoder.decode(bytes.subarray(0, cut)),
    truncated: true,
    viewBytes: cut,
    totalBytes: bytes.length,
  };
}

export interface ClassifyThenCapInput<R extends BrowserResultLike, C> {
  result: R;
  /** The shared classifier. Receives the full, intact result exactly once. */
  classify: (fullResult: R) => C;
  store: FullOutputStore;
  capBytes?: number;
}

export function classifyThenCap<R extends BrowserResultLike, C>(
  input: ClassifyThenCapInput<R, C>,
): CappedView<C> {
  const { result, classify, store } = input;
  const capBytes = input.capBytes ?? VIEW_CAP_BYTES;
  assertCap(capBytes, 'capBytes');

  // 1. classify from the full result, before any cap exists
  const status = classify(result);
  // 2. store the full output
  store.put(result.call_id, result.output);
  // 3. build the capped view
  const capped = capUtf8(result.output, capBytes);

  return {
    call_id: result.call_id,
    status,
    truncation: capped.truncated
      ? {
          truncated: true,
          total_bytes: capped.totalBytes,
          view_bytes: capped.viewBytes,
          next_offset: capped.viewBytes,
        }
      : null,
    payload: capped.text,
  };
}

export interface RecallPage {
  call_id: string;
  found: boolean;
  text: string;
  offset: number;
  next_offset: number;
  total_bytes: number;
  done: boolean;
}

/**
 * Page the stored FULL output by byte offset. Pages never split a multibyte
 * character and always make progress, so advancing next_offset until done
 * reproduces the full output exactly.
 */
export function recallPage(
  store: FullOutputStore,
  callId: string,
  offset = 0,
  limitBytes: number = VIEW_CAP_BYTES,
): RecallPage {
  assertCap(limitBytes, 'limitBytes');
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError('offset must be a non-negative integer');
  }
  const full = store.get(callId);
  if (full === undefined) {
    return { call_id: callId, found: false, text: '', offset, next_offset: offset, total_bytes: 0, done: true };
  }
  const bytes = encoder.encode(full);
  const total = bytes.length;
  if (offset >= total) {
    return { call_id: callId, found: true, text: '', offset, next_offset: total, total_bytes: total, done: true };
  }
  if (isContinuation(bytes[offset])) {
    throw new RangeError('offset is not on a character boundary; use next_offset from the previous page');
  }
  let end = Math.min(offset + limitBytes, total);
  while (end > offset && end < total && isContinuation(bytes[end])) end--;
  if (end <= offset) {
    // limit smaller than one character: emit that whole character
    end = offset + 1;
    while (end < total && isContinuation(bytes[end])) end++;
  }
  return {
    call_id: callId,
    found: true,
    text: decoder.decode(bytes.subarray(offset, end)),
    offset,
    next_offset: end,
    total_bytes: total,
    done: end >= total,
  };
}

/** Recall the whole stored output by advancing offsets. */
export function recallAll(store: FullOutputStore, callId: string, limitBytes: number = VIEW_CAP_BYTES): string | undefined {
  if (store.get(callId) === undefined) return undefined;
  let out = '';
  let offset = 0;
  for (;;) {
    const page = recallPage(store, callId, offset, limitBytes);
    out += page.text;
    if (page.done) return out;
    offset = page.next_offset;
  }
}
