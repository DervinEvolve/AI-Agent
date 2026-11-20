import { createHash } from 'node:crypto';

/** Encoding primitives only: these do not authorize, publish, or load a corpus. */
export const SEMANTIC_VECTOR_DIMENSION = 384;
export const MAX_SEMANTIC_ARTIFACT_BYTES = 64 * 1024 * 1024;

export function requireWellFormedUnicode(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('invalid_unicode');
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error('invalid_unicode');
    }
  }
}

/**
 * RFC 8785 serialization of JSON data. Rejects non-JSON JS values rather than
 * invoking toJSON or silently omitting them. Keys sort by UTF-16 code units.
 * Accessors, exotic objects, sparse arrays and cycles are not JSON data.
 */
export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  function visit(item: unknown, depth: number): string {
    if (depth > 128) throw new Error('artifact_depth');
    if (item === null) return 'null';
    if (typeof item === 'string') {
      requireWellFormedUnicode(item);
      return JSON.stringify(item);
    }
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('invalid_number');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new Error('non_json_value');
    if (active.has(item)) throw new Error('cyclic_value');
    const array = Array.isArray(item);
    const proto = Object.getPrototypeOf(item);
    if (!array && proto !== Object.prototype && proto !== null) throw new Error('non_json_object');
    if (Object.getOwnPropertySymbols(item).length) throw new Error('non_json_key');
    active.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const read = (key: string): unknown => {
        const descriptor = descriptors[key];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          throw new Error('non_json_property');
        }
        return descriptor.value;
      };
      if (array) {
        const values = item as unknown[];
        if (Object.keys(descriptors).length !== values.length + 1) throw new Error('non_json_array');
        const parts: string[] = [];
        for (let i = 0; i < values.length; i++) parts.push(visit(read(String(i)), depth + 1));
        return '[' + parts.join(',') + ']';
      }
      const parts = Object.keys(descriptors).sort().map(key => {
        requireWellFormedUnicode(key);
        return JSON.stringify(key) + ':' + visit(read(key), depth + 1);
      });
      return '{' + parts.join(',') + '}';
    } finally {
      active.delete(item);
    }
  }
  return visit(value, 0);
}

export function canonicalArtifactBytes(payload: unknown): Buffer {
  const bytes = Buffer.from(canonicalJson(payload), 'utf8');
  if (bytes.length > MAX_SEMANTIC_ARTIFACT_BYTES) throw new Error('artifact_size');
  return bytes;
}

export function artifactDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Checks raw-byte identity before parsing and requires canonical byte equality.
 * This is an encoding check, NOT complete snapshot-schema or principal validation.
 * Returned data is freshly parsed; caller-owned buffers are never retained.
 */
export function decodeCanonicalArtifact(bytes: Uint8Array, expectedDigest: string): unknown {
  if (!/^[0-9a-f]{64}$/.test(expectedDigest)) throw new Error('invalid_digest');
  if (bytes.byteLength > MAX_SEMANTIC_ARTIFACT_BYTES) throw new Error('artifact_size');
  const copy = Buffer.from(bytes);
  if (artifactDigest(copy) !== expectedDigest) throw new Error('digest_mismatch');
  let value: unknown;
  try {
    value = JSON.parse(copy.toString('utf8'));
  } catch {
    throw new Error('invalid_json');
  }
  // Also rejects duplicate keys, invalid UTF-8, BOMs and alternate escapes.
  if (!canonicalArtifactBytes(value).equals(copy)) throw new Error('noncanonical_artifact');
  return value;
}

/** Normalize a defensive copy and encode authoritative little-endian float32. */
export function encodeSemanticVector(input: readonly number[] | Float32Array | Float64Array): string {
  if (input.length !== SEMANTIC_VECTOR_DIMENSION) throw new Error('vector_dimension');
  const values = Array.from(input);
  let scale = 0;
  for (const value of values) {
    if (!Number.isFinite(value) || Math.abs(value) > 3.4028234663852886e38) throw new Error('vector_component');
    scale = Math.max(scale, Math.abs(value));
  }
  if (scale === 0) throw new Error('vector_zero');
  // Scaled norm avoids overflow/underflow without changing the direction.
  let squared = 0;
  for (const value of values) squared += (value / scale) ** 2;
  const norm = Math.sqrt(squared);
  const bytes = Buffer.alloc(SEMANTIC_VECTOR_DIMENSION * 4);
  for (let i = 0; i < values.length; i++) {
    const rounded = Math.fround((values[i] / scale) / norm);
    bytes.writeFloatLE(rounded === 0 ? 0 : rounded, i * 4);
  }
  const encoded = bytes.toString('base64');
  decodeSemanticVector(encoded);
  return encoded;
}

/** Validate stored bytes without renormalizing or rewriting authoritative data. */
export function decodeSemanticVector(encoded: string): Float32Array {
  // 1536 bytes encode to exactly 2048 unpadded base64 characters.
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]{2048}$/.test(encoded)) throw new Error('vector_encoding');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error('vector_encoding');
  const result = new Float32Array(SEMANTIC_VECTOR_DIMENSION);
  let squared = 0;
  for (let i = 0; i < result.length; i++) {
    const value = bytes.readFloatLE(i * 4);
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error('vector_component');
    result[i] = value;
    squared += value * value;
  }
  if (squared === 0) throw new Error('vector_zero');
  // Tolerance permits float32 rounding, not arbitrary unnormalized vectors.
  if (Math.abs(squared - 1) > 1e-6) throw new Error('vector_norm');
  return result;
}
