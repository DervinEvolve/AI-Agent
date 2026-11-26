import { createHash } from 'node:crypto';

/**
 * RFC 8785 (JCS) canonical JSON for JSON-compatible values.
 *
 * Object members are sorted by UTF-16 code units (the default JS string
 * order), numbers and strings use the ECMAScript serialisation that JCS
 * mandates. Values that are not JSON (undefined, functions, bigint, non-finite
 * numbers, lone surrogates, cycles) throw rather than being silently dropped,
 * because a digest over a lossy encoding would be ambiguous.
 */
const MAX_DEPTH = 64;

function assertWellFormed(s: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) throw new TypeError('canonical_json: lone surrogate');
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new TypeError('canonical_json: lone surrogate');
    }
  }
}

function serialize(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new TypeError('canonical_json: too deep or cyclic');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonical_json: non-finite number');
      return JSON.stringify(value);
    case 'string':
      assertWellFormed(value);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((v) => serialize(v, depth + 1)).join(',') + ']';
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('canonical_json: non-plain object');
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const k of keys) {
        assertWellFormed(k);
        parts.push(JSON.stringify(k) + ':' + serialize(obj[k], depth + 1));
      }
      return '{' + parts.join(',') + '}';
    }
    default:
      throw new TypeError('canonical_json: unsupported type ' + typeof value);
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, 0);
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** interface_digest = sha256(JCS({server_id, name, inputSchema})) over the ORIGINAL schema. */
export function interfaceDigest(input: {
  server_id: string;
  name: string;
  inputSchema: unknown;
}): string {
  return sha256Hex(
    canonicalJsonBytes({
      server_id: input.server_id,
      name: input.name,
      inputSchema: input.inputSchema,
    }),
  );
}

/** The exact bytes handed to the authorizer and digested for duplicate detection. */
export function canonicalArgumentBytes(args: unknown): Uint8Array {
  return canonicalJsonBytes(args);
}

export function argsDigest(args: unknown): string {
  return sha256Hex(canonicalArgumentBytes(args));
}
