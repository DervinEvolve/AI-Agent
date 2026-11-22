/**
 * Untrusted-origin argument rule (taint tripwire).
 *
 * Before a side-effecting tool call (write_file, run_code, network/URL fetch,
 * delegate_task), each string-valued argument is checked against the
 * transcript: after NFKC normalization, casefolding, and whitespace
 * collapsing, any span of >= 12 characters that appears in untrusted output
 * (tool outputs, retrieval passages, sub-agent reports) and in no user
 * message marks the argument as untrusted-origin. One base64-decoded pass of
 * each untrusted text is also checked.
 *
 * This is a tripwire, not a guarantee: paraphrased or fragment-composed
 * payloads are known to evade it. Read-only calls are exempt.
 */

export type TranscriptRole = 'user' | 'assistant' | 'tool_output';

export interface TranscriptEvent {
  role: TranscriptRole;
  text: string;
  /** Identifier of the producing call, e.g. a tool call_id. */
  source?: string;
}

export interface TaintFinding {
  /** The matching span (normalized form), >= MIN_SPAN chars. */
  span: string;
  /** Source (call_id) of the untrusted event the span first appeared in. */
  source: string;
  /** True when the span matched a base64-decoded pass of untrusted text. */
  viaBase64: boolean;
}

export interface TaintResult {
  untrustedOrigin: boolean;
  findings: TaintFinding[];
}

export type GuardAction = 'proceed' | 'ask' | 'drop';

export interface GuardDecision {
  tool: string;
  action: GuardAction;
  allowed: boolean;
  findings: TaintFinding[];
  /** Human-facing note quoting the span and its source, when flagged. */
  note?: string;
}

export const MIN_SPAN = 12;

export const SIDE_EFFECTING_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'run_code',
  'http_fetch',
  'fetch_url',
  'network_request',
  'delegate_task',
]);

/** NFKC + casefold + whitespace collapse. Applied identically to arguments
 * and transcript texts so span provenance survives normalization. */
export function normalizeForTaint(input: string): string {
  return input.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Extract base64-decoded printable text from an untrusted string. Only
 * tokens of >= 16 base64 chars are attempted, and only decodes that yield
 * mostly-printable UTF-8 of >= 8 chars are kept, to limit coincidental
 * false positives on benign base64-looking text.
 */
export function decodeBase64Candidates(text: string): string[] {
  const out: string[] = [];
  const re = /[A-Za-z0-9+/]{16,}={0,2}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      const decoded = Buffer.from(m[0], 'base64').toString('utf8');
      if (decoded.length < 8) continue;
      let printable = 0;
      for (const ch of decoded) {
        if (/[ -~\n\t]/.test(ch)) printable++;
      }
      if (printable / decoded.length > 0.9) out.push(decoded);
    } catch {
      // not valid base64; ignore
    }
  }
  return out;
}

interface Corpus {
  userJoined: string;
  untrusted: Array<{ normalized: string; source: string; viaBase64: boolean }>;
}

function buildCorpus(transcript: TranscriptEvent[]): Corpus {
  const userTexts: string[] = [];
  const untrusted: Corpus['untrusted'] = [];
  for (const ev of transcript) {
    if (ev.role === 'user') {
      userTexts.push(normalizeForTaint(ev.text));
    } else if (ev.role === 'tool_output') {
      const source = ev.source ?? 'tool_output';
      untrusted.push({ normalized: normalizeForTaint(ev.text), source, viaBase64: false });
      for (const decoded of decodeBase64Candidates(ev.text)) {
        untrusted.push({
          normalized: normalizeForTaint(decoded),
          source,
          viaBase64: true,
        });
      }
    }
  }
  return {
    userJoined: userTexts.join('\n'),
    untrusted,
  };
}

/**
 * Check a single string argument against the transcript. A span of
 * MIN_SPAN or more normalized characters that occurs (whole) in some
 * untrusted text and in no user message marks the argument untrusted-origin.
 */
export function checkUntrustedOrigin(
  argument: string,
  transcript: TranscriptEvent[],
): TaintResult {
  const normalizedArg = normalizeForTaint(argument);
  const findings: TaintFinding[] = [];
  if (normalizedArg.length < MIN_SPAN) {
    return { untrustedOrigin: false, findings };
  }
  const corpus = buildCorpus(transcript);
  if (corpus.untrusted.length === 0) {
    return { untrustedOrigin: false, findings };
  }

  for (let i = 0; i + MIN_SPAN <= normalizedArg.length; i++) {
    const window = normalizedArg.slice(i, i + MIN_SPAN);
    if (corpus.userJoined.includes(window)) continue;
    for (const un of corpus.untrusted) {
      if (!un.normalized.includes(window)) continue;
      // Expand the window to the maximal contiguous match inside this text.
      let start = i;
      let end = i + MIN_SPAN;
      while (
        start > 0 &&
        un.normalized.includes(normalizedArg.slice(start - 1, end)) &&
        !corpus.userJoined.includes(normalizedArg.slice(start - 1, end))
      ) {
        start--;
      }
      while (
        end < normalizedArg.length &&
        un.normalized.includes(normalizedArg.slice(start, end + 1)) &&
        !corpus.userJoined.includes(normalizedArg.slice(start, end + 1))
      ) {
        end++;
      }
      findings.push({
        span: normalizedArg.slice(start, end),
        source: un.source,
        viaBase64: un.viaBase64,
      });
      return { untrustedOrigin: true, findings };
    }
  }
  return { untrustedOrigin: false, findings };
}

/** Collect string values from a flat or nested argument object. */
function collectStringArgs(args: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (prefix: string, value: unknown): void => {
    if (typeof value === 'string') {
      out.push([prefix, value]);
    } else if (Array.isArray(value)) {
      value.forEach((v, idx) => walk(`${prefix}[${idx}]`, v));
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(prefix ? `${prefix}.${k}` : k, v);
      }
    }
  };
  for (const [k, v] of Object.entries(args)) walk(k, v);
  return out;
}

/**
 * Apply the untrusted-origin rule to a pending tool call.
 *
 * - Read-only tools are exempt (action 'proceed').
 * - If the transcript has no untrusted output at all, proceed.
 * - If any string argument is untrusted-origin, the call may not be used
 *   silently: mode 'ask' returns action 'ask' (pause and confirm with the
 *   user, quoting the span and source), mode 'drop' returns action 'drop'
 *   (skip the call and note that retrieved content tried to steer it).
 */
export function checkSideEffectCall(
  tool: string,
  args: Record<string, unknown>,
  transcript: TranscriptEvent[],
  mode: 'ask' | 'drop' = 'drop',
): GuardDecision {
  const hasUntrusted = transcript.some((ev) => ev.role === 'tool_output');
  if (!SIDE_EFFECTING_TOOLS.has(tool) || !hasUntrusted) {
    return { tool, action: 'proceed', allowed: true, findings: [] };
  }
  const findings: TaintFinding[] = [];
  for (const [argName, value] of collectStringArgs(args)) {
    const res = checkUntrustedOrigin(value, transcript);
    if (res.untrustedOrigin) {
      for (const f of res.findings) {
        findings.push({ ...f, source: `${argName} <- ${f.source}` });
      }
    }
  }
  if (findings.length === 0) {
    return { tool, action: 'proceed', allowed: true, findings };
  }
  const quoted = findings
    .map((f) => `"${f.span}" (source: ${f.source}${f.viaBase64 ? ', base64-decoded' : ''})`)
    .join('; ');
  const note =
    mode === 'ask'
      ? `Retrieved content may be steering this action; confirm with the user before proceeding. Untrusted-origin span: ${quoted}`
      : `Dropped ${tool}: retrieved content tried to steer the action. Untrusted-origin span: ${quoted}`;
  return {
    tool,
    action: mode,
    allowed: false,
    findings,
    note,
  };
}
