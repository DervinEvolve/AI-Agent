import type { BoardMutationContext, CommitmentBoard } from './board';
import type { CommitmentKind, CommitmentRefInput, CommitmentResolution } from './types';

export const BOARD_TOOL_NAMES = [
  'read_commitments',
  'record_commitment',
  'resolve_commitment',
] as const;

export type BoardToolName = (typeof BOARD_TOOL_NAMES)[number];

export function isBoardToolName(name: string): name is BoardToolName {
  return (BOARD_TOOL_NAMES as readonly string[]).includes(name);
}

export function filterBoardToolsForChild<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((t) => !isBoardToolName(t.name));
}

export interface CommitmentBoardToolDefinition {
  name: BoardToolName;
  description: string;
  idempotent: boolean;
  concurrentSafe: boolean;
  recoveryNeutral: true;
  alwaysVisible: true;
  execute: (args: Record<string, unknown>, ctx: BoardMutationContext) => Promise<unknown>;
}

export function createCommitmentBoardTools(
  board: CommitmentBoard
): CommitmentBoardToolDefinition[] {
  return [
    {
      name: 'read_commitments',
      description: 'Read a deterministic bounded page of the commitment board projection.',
      idempotent: true,
      concurrentSafe: true,
      recoveryNeutral: true,
      alwaysVisible: true,
      execute: async (args) => {
        return board.readCommitments({
          status: args.status === 'all' ? 'all' : 'active',
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          offset: typeof args.offset === 'number' ? args.offset : undefined,
        });
      },
    },
    {
      name: 'record_commitment',
      description: 'Record a new decision or open_question on the commitment board.',
      idempotent: false,
      concurrentSafe: false,
      recoveryNeutral: true,
      alwaysVisible: true,
      execute: async (args, ctx) => {
        return board.recordCommitment(
          {
            kind: args.kind as CommitmentKind,
            summary: args.summary as string,
            refs: args.refs as CommitmentRefInput[] | undefined,
            supersedes_id: args.supersedes_id as string | undefined,
          },
          ctx
        );
      },
    },
    {
      name: 'resolve_commitment',
      description: 'Resolve an active commitment as answered or abandoned.',
      idempotent: false,
      concurrentSafe: false,
      recoveryNeutral: true,
      alwaysVisible: true,
      execute: async (args, ctx) => {
        return board.resolveCommitment(
          {
            commitment_id: args.commitment_id as string,
            resolution: args.resolution as CommitmentResolution,
            summary: args.summary as string,
            refs: args.refs as CommitmentRefInput[] | undefined,
          },
          ctx
        );
      },
    },
  ];
}
