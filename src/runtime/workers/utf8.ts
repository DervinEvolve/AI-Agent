/** UTF-8 boundary slicing aligned with jobs sliceLogBytes discipline. */

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function splitUtf8(text: string, maxBytes: number): { head: string; rest: string; split: boolean } {
  if (maxBytes < 0) maxBytes = 0;
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { head: text, rest: "", split: false };
  let n = maxBytes;
  while (n > 0 && (bytes[n] & 0b1100_0000) === 0b1000_0000) n -= 1;
  const dec = new TextDecoder();
  return {
    head: dec.decode(bytes.slice(0, n)),
    rest: dec.decode(bytes.slice(n)),
    split: true,
  };
}

export function clampUtf8(text: string, maxBytes: number): string {
  return splitUtf8(text, maxBytes).head;
}
