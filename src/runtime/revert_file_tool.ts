/**
 * Registered `revert_file` tool: voluntary abandon of an intent's edit.
 *
 * Wraps the PreMutationSnapshotStore. Idempotent (no snapshot -> success
 * no-op), scoped to the caller's intent, and never touches files outside the
 * intent's snapshot set.
 */
import {
  PreMutationSnapshotStore,
  renderRevertNote,
} from "./premutation_snapshot.ts";

export interface RevertFileTool {
  name: "revert_file";
  description: string;
  parameters: {
    type: "object";
    properties: { path: { type: "string"; description: string } };
    required: string[];
  };
  execute(args: { path: string }, context: { intentId: string }): Promise<{
    reverted: boolean;
    message: string;
  }>;
}

export function createRevertFileTool(
  store: PreMutationSnapshotStore,
): RevertFileTool {
  return {
    name: "revert_file",
    description:
      "Restore a file to its pre-intent snapshot baseline. Idempotent: does nothing if no snapshot exists for the current intent and path. Never reverts committed (gate-passed) edits.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path of the file to revert to its pre-intent baseline.",
        },
      },
      required: ["path"],
    },
    async execute(args, context) {
      const path = String(args?.path ?? "");
      if (!path) {
        return { reverted: false, message: "revert_file: missing path" };
      }
      const reverted = await store.revertFile(context.intentId, path);
      if (!reverted) {
        return {
          reverted: false,
          message: `revert_file: no snapshot for ${path} in this intent; nothing to revert (idempotent no-op).`,
        };
      }
      return {
        reverted: true,
        message: `revert_file: restored ${path} to its pre-intent baseline.`,
      };
    },
  };
}

/**
 * Automatic revert path used when the recovery allowance is exhausted while
 * the verification gate still fails: reverts the whole intent (multi-file
 * all-or-nothing) and returns the structured note for the agent's context.
 */
export async function autoRevertExhaustedIntent(
  store: PreMutationSnapshotStore,
  intentId: string,
): Promise<{ note: string | null }> {
  const result = await store.revertIntent(intentId);
  const note = store.buildRevertNote(intentId);
  if (result.reverted.length === 0 && result.skippedNonExistent.length === 0 && !note) {
    return { note: null };
  }
  return { note: note ? renderRevertNote(note) : null };
}
