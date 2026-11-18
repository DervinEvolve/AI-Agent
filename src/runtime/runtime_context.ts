export interface ToolSchemaLike {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  idempotent?: boolean;
}  

export interface ProtectedState {
  instructions: string;
  step: number;
  turn: number;
  intentId: string | null;
  remainingAllowance: number;
}

export interface TranscriptEntry {
  call_id: string;
  toolName: string;
  status: string;
  truncated: boolean;
  preview: string;
}

export interface BoundedRequest {
  overflow: false;
  protected: {
    task: string;
    state: ProtectedState;
    tools: ToolSchemaLike[];
  };
  untrusted_observations: TranscriptEntry[];
  serializedBytes: number;
}

export type ContextRenderResult = BoundedRequest | { overflow: true };

export class RuntimeContextManager {
  render(
    task: string,
    protectedState: ProtectedState,
    transcript: TranscriptEntry[],
    toolSchemas: ToolSchemaLike[],
    maxBytes = 32_768,
  ): ContextRenderResult {
    const payload = {
      protected: {
        task,
        state: protectedState,
        tools: toolSchemas,
      },
      untrusted_observations: transcript.map((entry) => ({
        call_id: entry.call_id,
        toolName: entry.toolName,
        status: entry.status,
        truncated: entry.truncated,
        preview: entry.preview,
      })),
    };

    const serialized = JSON.stringify(payload);
    const serializedBytes = Buffer.byteLength(serialized, 'utf8');
    if (serializedBytes > maxBytes) {
      return { overflow: true };
    }

    return {
      overflow: false,
      ...payload,
      serializedBytes,
    };
  }
}
