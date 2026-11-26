import type { CommitmentBoardConfig, CommitmentEntry } from './types';

export const COMMITMENT_BOARD_LABEL_START = '[UNTRUSTED_COMMITMENT_BOARD_DATA]';
export const COMMITMENT_BOARD_LABEL_END = '[/UNTRUSTED_COMMITMENT_BOARD_DATA]';

export interface RenderedCommitmentBoard {
  text: string;
  bytes: number;
  rendered_count: number;
  elided_count: number;
}

export function renderCommitmentBoard(
  entries: CommitmentEntry[],
  config: Pick<CommitmentBoardConfig, 'maxActiveEntries' | 'maxRenderedBytes'>
): RenderedCommitmentBoard {
  const activeNewestFirst = entries
    .filter((e) => e.status === 'active')
    .slice()
    .sort((a, b) => b.created_at_seq - a.created_at_seq);

  const capped = activeNewestFirst.slice(0, config.maxActiveEntries);
  const kept: CommitmentEntry[] = [];

  const buildText = (items: CommitmentEntry[], elided: number): string => {
    const payload = JSON.stringify({ elided_count: elided, entries: items });
    return `${COMMITMENT_BOARD_LABEL_START}\n${payload}\n${COMMITMENT_BOARD_LABEL_END}`;
  };

  for (const item of capped) {
    const candidate = [...kept, item];
    const elided = activeNewestFirst.length - candidate.length;
    const text = buildText(candidate, elided);
    if (Buffer.byteLength(text, 'utf8') <= config.maxRenderedBytes) {
      kept.push(item);
    } else {
      break;
    }
  }

  const elided_count = activeNewestFirst.length - kept.length;
  const text = buildText(kept, elided_count);
  const bytes = Buffer.byteLength(text, 'utf8');

  return {
    text,
    bytes,
    rendered_count: kept.length,
    elided_count,
  };
}
