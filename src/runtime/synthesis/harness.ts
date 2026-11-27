import { createHash } from 'crypto';
import {
  SYNTHESIS_ASSERTION_EXIT_CODE,
  SynthesisCheckResult,
  SynthesisFeedback,
  SynthesisFeedbackItem,
} from './types';

const TRUNCATION_MARKER = '\n...[truncated]';

export function computeDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function truncateUtf8(input: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(input, 'utf8');
  if (buf.byteLength <= maxBytes) {
    return { text: input, truncated: false };
  }
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  if (maxBytes <= markerBytes) {
    return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated: true };
  }
  const sliceLen = maxBytes - markerBytes;
  const sliced = buf.subarray(0, sliceLen).toString('utf8');
  return { text: sliced + TRUNCATION_MARKER, truncated: true };
}

export function wrapCheckWithHostHarness(
  candidate: string,
  checkCode: string,
  assertionExitCode: number = SYNTHESIS_ASSERTION_EXIT_CODE,
): string {
  const candidateJson = JSON.stringify(candidate);
  return [
    'import json, sys',
    `CANDIDATE = json.loads(${JSON.stringify(candidateJson)})`,
    `SYNTHESIS_ASSERTION_EXIT_CODE = ${assertionExitCode}`,
    'def synth_assert(cond, msg="assertion failed"):',
    '    if not cond:',
    '        sys.stderr.write(str(msg) + "\n")',
    '        sys.exit(SYNTHESIS_ASSERTION_EXIT_CODE)',
    '',
    checkCode,
  ].join('\n');
}

export function buildSynthesisFeedback(
  round: number,
  failedChecks: Array<{ id: string; hypothesis: string; result: SynthesisCheckResult }>,
  maxFeedbackBytes: number,
): SynthesisFeedback {
  const header = `[UNTRUSTED_SYNTHESIS_FEEDBACK round=${round}]\n`;
  const footer = `[/UNTRUSTED_SYNTHESIS_FEEDBACK]`;
  const items: SynthesisFeedbackItem[] = [];
  let body = '';

  for (const entry of failedChecks) {
    const linePrefix = `- ${entry.id} (${entry.hypothesis}): `;
    const rawLine = linePrefix + entry.result.output;
    const candidateBody = body + (body ? '\n' : '') + rawLine;
    const totalBytes = Buffer.byteLength(header + candidateBody + '\n' + footer, 'utf8');
    if (totalBytes <= maxFeedbackBytes) {
      body = candidateBody;
      items.push({
        id: entry.id,
        hypothesis: entry.hypothesis,
        output: entry.result.output,
        truncated: entry.result.truncated,
      });
    } else {
      const remaining = Math.max(
        0,
        maxFeedbackBytes -
          Buffer.byteLength(header + (body ? body + '\n' : '') + '\n' + footer, 'utf8'),
      );
      if (remaining > 0) {
        const clipped = truncateUtf8(rawLine, remaining);
        body = body + (body ? '\n' : '') + clipped.text;
        items.push({
          id: entry.id,
          hypothesis: entry.hypothesis,
          output: clipped.text,
          truncated: true,
        });
      }
      break;
    }
  }

  const rendered = `${header}${body}${body ? '\n' : ''}${footer}`;
  return {
    round,
    label: 'UNTRUSTED_SYNTHESIS_FEEDBACK',
    items,
    rendered,
    byteLength: Buffer.byteLength(rendered, 'utf8'),
  };
}
