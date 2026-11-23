/** Inclusive wire-size limits. Sizes are UTF-8 bytes, not UTF-16 lengths. */
export const EPISODE_CAPS = Object.freeze({
  episodeBytes: 4096,
  excerptBytes: 512,
  candidates: 128,
  retainedEpisodes: 10000,
  retainedBytes: 32 * 1024 * 1024,
  bufferedBytes: 512 * 1024,
  envelopeBytes: 528 * 1024,
  queryBytes: 512,
  toolOutputBytes: 8 * 1024,
  searchLimit: 8,
  defaultSearchLimit: 5,
  defaultTtlMs: 30 * 86400000,
  maximumTtlMs: 90 * 86400000,
  defaultAuthorizationTimeoutMs: 1000,
  maximumAuthorizationTimeoutMs: 5000,
});

export type CanonicalJson = null | boolean | number | string | CanonicalJson[] |
  { [key: string]: CanonicalJson };

function validateString(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('Unpaired surrogate');
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError('Unpaired surrogate');
    }
  }
}

/**
 * RFC 8785 serialization for JSON data. Rejects non-JSON objects, accessors,
 * sparse arrays, cycles, nonfinite numbers and lone surrogates. Does not call
 * toJSON or normalize Unicode. Hosts must not supply adversarial JS proxies.
 */
export function canonicalize(value: unknown): string {
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): string {
    if (depth > 64) throw new RangeError('Canonical JSON depth exceeded');
    if (item === null) return 'null';
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'string') {
      validateString(item);
      return JSON.stringify(item);
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('Nonfinite number');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new TypeError('Not JSON data');
    if (ancestors.has(item)) throw new TypeError('Cyclic JSON');
    ancestors.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Object.getOwnPropertySymbols(item).length) throw new TypeError('Symbol property');
      const get = (key: string): unknown => {
        const descriptor = descriptors[key];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          throw new TypeError('Expected enumerable JSON data property');
        }
        return descriptor.value;
      };
      if (Array.isArray(item)) {
        if (Object.keys(descriptors).length !== item.length + 1) {
          throw new TypeError('Sparse or extended array');
        }
        const values: string[] = [];
        for (let i = 0; i < item.length; i++) values.push(visit(get(String(i)), depth + 1));
        return '[' + values.join(',') + ']';
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Not a JSON object');
      return '{' + Object.keys(descriptors).sort().map(key => {
        validateString(key);
        return JSON.stringify(key) + ':' + visit(get(key), depth + 1);
      }).join(',') + '}';
    } finally {
      ancestors.delete(item);
    }
  }
  return visit(value, 0);
}

export function canonicalBytes(value: unknown, maximumBytes: number): Uint8Array {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new RangeError('Invalid byte limit');
  const bytes = new TextEncoder().encode(canonicalize(value));
  if (bytes.byteLength > maximumBytes) throw new RangeError('Canonical byte limit exceeded');
  return bytes;
}
