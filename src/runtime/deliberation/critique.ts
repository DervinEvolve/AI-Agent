import { DELIBERATION_CAPS as CAPS, Critique, CritiqueRejectReason } from './types';

export type CritiqueParseResult =
  | { ok: true; critique: Critique; canonical: string }
  | { ok: false; reason: CritiqueRejectReason };

const ALLOWED_KEYS = new Set(['verdict', 'concerns', 'assumptions', 'suggested_check']);

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function boundedStrings(v: unknown, maxItems: number, maxBytes: number): v is string[] {
  if (!Array.isArray(v) || v.length > maxItems) return false;
  return v.every((s) => typeof s === 'string' && utf8Bytes(s) <= maxBytes);
}

/**
 * Strict parser for the critic output. Anything outside the schema is rejected;
 * nothing is repaired or coerced. The canonical form (fixed key order) is what
 * a revision request shows, never the raw model text.
 */
export function parseCritique(text: unknown, maxCritiqueBytes: number): CritiqueParseResult {
  if (typeof text !== 'string') return { ok: false, reason: 'not_text' };
  if (utf8Bytes(text) > maxCritiqueBytes) return { ok: false, reason: 'oversize' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'bad_json' };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not_object' };
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(k)) return { ok: false, reason: 'unknown_field' };
  }
  if (obj.verdict !== 'proceed' && obj.verdict !== 'reconsider') return { ok: false, reason: 'bad_verdict' };
  if (!boundedStrings(obj.concerns, CAPS.maxConcerns, CAPS.maxItemBytes)) return { ok: false, reason: 'bad_concerns' };
  if (!boundedStrings(obj.assumptions, CAPS.maxAssumptions, maxCritiqueBytes)) {
    return { ok: false, reason: 'bad_assumptions' };
  }
  const critique: Critique = {
    verdict: obj.verdict,
    concerns: [...obj.concerns],
    assumptions: [...obj.assumptions],
  };
  if ('suggested_check' in obj) {
    const sc = obj.suggested_check;
    if (typeof sc !== 'string' || utf8Bytes(sc) > CAPS.maxItemBytes) return { ok: false, reason: 'bad_suggested_check' };
    critique.suggested_check = sc;
  }
  const canonical = JSON.stringify(critique);
  if (utf8Bytes(canonical) > maxCritiqueBytes) return { ok: false, reason: 'oversize' };
  return { ok: true, critique, canonical };
}
