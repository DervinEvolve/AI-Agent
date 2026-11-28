export type DestinationKind = 'mcp_server' | 'egress_origin';

export interface AuthzPolicy {
  allowedMethods: string[];
  allowedPathPrefixes: string[];
}

export type SecretSource =
  | Uint8Array
  | string
  | (() => Uint8Array | string | Promise<Uint8Array | string>);

export interface SecretBinding {
  secret_ref: string;
  destination: {
    kind: DestinationKind;
    key: string;
  };
  secret: SecretSource;
  injection: {
    header_name: string;
  };
  authzPolicy: AuthzPolicy;
}

export interface SecretVaultConfig {
  enabled: boolean;
  principal: string;
  runConfigDigest: string;
  bindings?: SecretBinding[];
  maxBindings?: number;
  sentinel?: string;
  allowChildCredentials?: boolean;
}

export const RedactionReason = {
  NONE: 'none',
  REDACTED: 'redacted',
  REDACTION_ERROR: 'redaction_error',
  SECRET_BEARING_EXPORT_REFUSED: 'secret_bearing_export_refused',
  CREDENTIAL_UNAVAILABLE: 'credential_unavailable',
  CREDENTIAL_TRANSPORT_UNSUPPORTED: 'credential_transport_unsupported',
} as const;

export type RedactionReason = (typeof RedactionReason)[keyof typeof RedactionReason];

export const SecretCaps = {
  MIN_SECRET_BYTES: 16,
  MAX_SECRET_BYTES: 4096,
  DEFAULT_MAX_BINDINGS: 16,
  HARD_MAX_BINDINGS: 64,
  DEFAULT_SENTINEL: '[REDACTED]',
  DEFAULT_MAX_REDACTION_OUTPUT_BYTES: 1_000_000,
  MAX_REDACTION_ERROR_BYTES: 256,
} as const;

export interface RedactionResult {
  output: Uint8Array;
  replaced: number;
  reason: RedactionReason;
  truncated: boolean;
  error?: string;
}

export interface RedactOptions {
  sentinel?: string;
  maxOutputBytes?: number;
}

function normalizeSecret(secret: Uint8Array | string): Uint8Array {
  if (typeof secret === 'string') {
    return new TextEncoder().encode(secret);
  }
  return secret.slice();
}

function toUint8Array(input: Uint8Array | string): Uint8Array {
  if (typeof input === 'string') {
    return new TextEncoder().encode(input);
  }
  return input.slice();
}

function bytesEqual(haystack: Uint8Array, needle: Uint8Array, offset: number): boolean {
  for (let j = 0; j < needle.length; j += 1) {
    if (haystack[offset + j] !== needle[j]) {
      return false;
    }
  }
  return true;
}

function concatBytes(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

function truncateBytes(bytes: Uint8Array, max: number): string {
  const truncated = bytes.slice(0, max);
  return new TextDecoder('utf-8', { fatal: false }).decode(truncated);
}

function errorResult(err: unknown): RedactionResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    output: new Uint8Array(0),
    replaced: 0,
    reason: RedactionReason.REDACTION_ERROR,
    truncated: false,
    error: truncateBytes(new TextEncoder().encode(message), SecretCaps.MAX_REDACTION_ERROR_BYTES),
  };
}

export class SecretRedactor {
  private readonly secrets: Uint8Array[];
  private readonly sentinel: Uint8Array;
  private readonly maxOutputBytes: number;

  constructor(secrets: Iterable<Uint8Array | string>, options: RedactOptions = {}) {
    const secretList = Array.from(secrets, normalizeSecret).filter((secret) => secret.length > 0);
    secretList.sort((a, b) => b.length - a.length);
    this.secrets = secretList;
    const sentinel = options.sentinel ?? SecretCaps.DEFAULT_SENTINEL;
    this.sentinel = new TextEncoder().encode(sentinel);
    this.maxOutputBytes = options.maxOutputBytes ?? SecretCaps.DEFAULT_MAX_REDACTION_OUTPUT_BYTES;
  }

  redact(input: Uint8Array | string): RedactionResult {
    try {
      const bytes = toUint8Array(input);
      if (this.secrets.length === 0) {
        return {
          output: bytes.slice(),
          replaced: 0,
          reason: RedactionReason.NONE,
          truncated: false,
        };
      }

      const parts: Uint8Array[] = [];
      let total = 0;
      let replaced = 0;
      let i = 0;

      while (i < bytes.length) {
        let matched = false;
        for (const secret of this.secrets) {
          if (i + secret.length <= bytes.length && bytesEqual(bytes, secret, i)) {
            parts.push(this.sentinel);
            total += this.sentinel.length;
            replaced += 1;
            i += secret.length;
            matched = true;
            break;
          }
        }

        if (!matched) {
          parts.push(Uint8Array.of(bytes[i]));
          total += 1;
          i += 1;
        }
      }

      if (total > this.maxOutputBytes) {
        return {
          output: new Uint8Array(0),
          replaced: 0,
          reason: RedactionReason.REDACTION_ERROR,
          truncated: false,
          error: truncateBytes(
            new TextEncoder().encode(`redaction output exceeded ${this.maxOutputBytes} bytes`),
            SecretCaps.MAX_REDACTION_ERROR_BYTES,
          ),
        };
      }

      return {
        output: concatBytes(parts, total),
        replaced,
        reason: replaced > 0 ? RedactionReason.REDACTED : RedactionReason.NONE,
        truncated: false,
      };
    } catch (err) {
      return errorResult(err);
    }
  }
}

export function redactBytes(
  input: Uint8Array | string,
  secrets: readonly (Uint8Array | string)[],
  options?: RedactOptions,
): RedactionResult {
  try {
    const redactor = new SecretRedactor(secrets, options);
    return redactor.redact(input);
  } catch (err) {
    return errorResult(err);
  }
}
