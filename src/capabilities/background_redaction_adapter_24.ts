export type RedactionContext = Record<string, unknown>;

export interface RedactionRecord {
  kind?: string;
  start?: number;
  end?: number;
  replacement?: string;
  [key: string]: unknown;
}

export interface RedactionResult {
  text: string;
  redactions: RedactionRecord[];
  blocked: boolean;
}

export interface BackgroundRedactionAdapter {
  redact(text: string, context?: RedactionContext): RedactionResult | Promise<RedactionResult>;
}

export type LegacyRedactorCallable = (
  text: string,
  context?: RedactionContext,
) => string | RedactionResult | Promise<string | RedactionResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function coerceRedactionResult(value: unknown): RedactionResult {
  if (!isRecord(value)) {
    throw new TypeError("Redaction adapter returned a non-object result");
  }

  if (typeof value.text !== "string") {
    throw new TypeError("Redaction adapter result must include text:string");
  }

  if (!Array.isArray(value.redactions)) {
    throw new TypeError("Redaction adapter result must include redactions:list");
  }

  if (typeof value.blocked !== "boolean") {
    throw new TypeError("Redaction adapter result must include blocked:bool");
  }

  return {
    text: value.text,
    redactions: value.redactions as RedactionRecord[],
    blocked: value.blocked,
  };
}

export class RedactionAdapter implements BackgroundRedactionAdapter {
  private readonly backend: BackgroundRedactionAdapter;

  constructor(backend: BackgroundRedactionAdapter) {
    if (!backend || typeof backend.redact !== "function") {
      throw new TypeError("RedactionAdapter requires an object exposing redact(text, context)");
    }

    this.backend = backend;
  }

  async redact(text: string, context?: RedactionContext): Promise<RedactionResult> {
    return coerceRedactionResult(await this.backend.redact(text, context));
  }

  static fromCallable(callable: LegacyRedactorCallable): RedactionAdapter {
    if (typeof callable !== "function") {
      throw new TypeError("RedactionAdapter.fromCallable requires a function");
    }

    return new RedactionAdapter({
      async redact(text: string, context?: RedactionContext): Promise<RedactionResult> {
        const result = await callable(text, context);

        if (typeof result === "string") {
          return {
            text: result,
            redactions: [],
            blocked: false,
          };
        }

        return coerceRedactionResult(result);
      },
    });
  }
}

export async function redactSafely(
  adapter: BackgroundRedactionAdapter,
  text: string,
  context?: RedactionContext,
): Promise<RedactionResult> {
  try {
    return coerceRedactionResult(await adapter.redact(text, context));
  } catch (error) {
    return {
      text: "[redaction failed]",
      redactions: [
        {
          kind: "redaction_error",
          message: error instanceof Error ? error.message : "Unknown redaction adapter error",
        },
      ],
      blocked: true,
    };
  }
}
