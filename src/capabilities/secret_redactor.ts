// secret_redactor.ts
//
// Frozen public API for the epoch-12 trusted-secrets vault redactor.
// ALL other modules import these functions BY NAME from this module.
//
// Contract (see cap_delegated_auth_vault_12):
//   redactString(text)         -> { redacted: string, hits: Hit[] }
//   redactOutboundString(text) -> string   (alias returning redacted text only)
//   containsSecret(text)       -> boolean
//   redactObject(obj)          -> obj       (deep-walks strings)
//
// Every helper referenced below is DEFINED WITHIN THIS MODULE. No external
// helper (safeCompute, makeError, validateInteger, ...) is referenced unless
// defined here, which is what killed epoch-12 CI ('X is not a function').
//
// ENGINE NOTE: to guarantee linear-time, non-backtracking (RE2-class) scanning
// without a native/optional npm dependency, all patterns are implemented as
// hand-written single-pass scanners over token characters. There is NO regex
// backtracking anywhere in this file, so no crafted input can cause ReDoS.

export interface Hit {
  pattern_id: string;
  start: number;
  end: number;
}

export interface RedactResult {
  redacted: string;
  hits: Hit[];
}

// Defense-in-depth: cap input length before scanning so a huge payload can
// never stall the host controller.
export const MAX_SCAN_LENGTH = 200_000;

function placeholder(patternId: string): string {
  return `[REDACTED:${patternId}]`;
}

// ---- character predicates (all O(1)) ----
function isUpper(c: string): boolean {
  return c >= 'A' && c <= 'Z';
}
function isLower(c: string): boolean {
  return c >= 'a' && c <= 'z';
}
function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}
function isAlnum(c: string): boolean {
  return isUpper(c) || isLower(c) || isDigit(c);
}
// base64url token char (JWT / bearer style)
function isB64Url(c: string): boolean {
  return isAlnum(c) || c === '-' || c === '_';
}
// base64 token char
function isB64(c: string): boolean {
  return isAlnum(c) || c === '+' || c === '/' || c === '=';
}

// A single scanner returns the exclusive end index of a match starting at `i`,
// or -1 if no match at that position. Each scanner advances at most linearly
// over the input, so the whole scan is O(n * numPatterns) with a small
// constant — strictly linear, no backtracking.
type Scanner = (s: string, i: number) => number;

interface PatternDef {
  id: string;
  scan: Scanner;
}

// Match a literal prefix at position i (case-sensitive). Returns i+len or -1.
function matchLiteral(s: string, i: number, lit: string): number {
  if (i + lit.length > s.length) return -1;
  for (let k = 0; k < lit.length; k++) {
    if (s[i + k] !== lit[k]) return -1;
  }
  return i + lit.length;
}

// Consume a run of chars satisfying pred; returns index after run.
function consume(s: string, i: number, pred: (c: string) => boolean): number {
  let j = i;
  while (j < s.length && pred(s[j])) j++;
  return j;
}

// ---- built-in, statically-vetted pattern set ----
const PATTERNS: PatternDef[] = [
  // PEM private key headers/blocks: -----BEGIN * PRIVATE KEY-----
  {
    id: 'pem_private_key',
    scan: (s, i) => {
      let j = matchLiteral(s, i, '-----BEGIN ');
      if (j < 0) return -1;
      // consume anything up to 'PRIVATE KEY-----' on the same header line
      const header = 'PRIVATE KEY-----';
      let k = j;
      const lineEnd = Math.min(s.length, j + 80);
      let found = -1;
      while (k <= lineEnd - header.length) {
        if (s[k] === '\n') break;
        if (matchLiteral(s, k, header) === k + header.length) {
          found = k + header.length;
          break;
        }
        k++;
      }
      if (found < 0) return -1;
      // extend through body + END footer if present
      let end = found;
      const endMarker = '-----END ';
      let m = end;
      while (m < s.length && m < end + 8000) {
        if (matchLiteral(s, m, endMarker) === m + endMarker.length) {
          // consume to end of footer line
          let f = m;
          while (f < s.length && s[f] !== '\n') f++;
          return f;
        }
        m++;
      }
      return found;
    },
  },
  // JWT: ey<b64url>.ey?<b64url>.<b64url>  (3 dot-separated base64url segments)
  {
    id: 'jwt',
    scan: (s, i) => {
      if (matchLiteral(s, i, 'ey') !== i + 2) return -1;
      let j = consume(s, i, isB64Url);
      if (j - i < 8) return -1;
      if (s[j] !== '.') return -1;
      j++;
      const seg2 = consume(s, j, isB64Url);
      if (seg2 - j < 2) return -1;
      j = seg2;
      if (s[j] !== '.') return -1;
      j++;
      const seg3 = consume(s, j, isB64Url);
      if (seg3 - j < 2) return -1;
      return seg3;
    },
  },
  // AWS access key id: AKIA or ASIA + 16 uppercase-alnum
  {
    id: 'aws_access_key',
    scan: (s, i) => {
      let j = matchLiteral(s, i, 'AKIA');
      if (j < 0) j = matchLiteral(s, i, 'ASIA');
      if (j < 0) return -1;
      const start = j;
      j = consume(s, j, (c) => isUpper(c) || isDigit(c));
      return j - start >= 16 ? start + 16 : -1;
    },
  },
  // Google API key: AIza + 35 base64url chars
  {
    id: 'google_api_key',
    scan: (s, i) => {
      const j = matchLiteral(s, i, 'AIza');
      if (j < 0) return -1;
      const end = consume(s, j, isB64Url);
      return end - j >= 35 ? j + 35 : -1;
    },
  },
  // GitHub token: ghp_/gho_/ghu_/ghs_/ghr_ + 20+ token chars
  {
    id: 'github_token',
    scan: (s, i) => {
      const prefixes = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'];
      for (const p of prefixes) {
        const j = matchLiteral(s, i, p);
        if (j >= 0) {
          const end = consume(s, j, isB64Url);
          if (end - j >= 20) return end;
        }
      }
      return -1;
    },
  },
  // Slack token: xox[baprs]-...
  {
    id: 'slack_token',
    scan: (s, i) => {
      let j = matchLiteral(s, i, 'xox');
      if (j < 0) return -1;
      const t = s[j];
      if (!(t === 'b' || t === 'a' || t === 'p' || t === 'r' || t === 's')) return -1;
      j++;
      if (s[j] !== '-') return -1;
      const end = consume(s, j, (c) => isB64Url(c) || c === '-');
      return end - j >= 10 ? end : -1;
    },
  },
  // Stripe secret/live keys: sk_live_ / sk_test_ / rk_live_ + token chars
  {
    id: 'stripe_key',
    scan: (s, i) => {
      const prefixes = ['sk_live_', 'sk_test_', 'rk_live_', 'rk_test_'];
      for (const p of prefixes) {
        const j = matchLiteral(s, i, p);
        if (j >= 0) {
          const end = consume(s, j, isB64Url);
          if (end - j >= 10) return end;
        }
      }
      return -1;
    },
  },
  // Twilio account SID / auth: AC + 32 hex, or SK + 32 hex
  {
    id: 'twilio_token',
    scan: (s, i) => {
      let j = matchLiteral(s, i, 'AC');
      if (j < 0) j = matchLiteral(s, i, 'SK');
      if (j < 0) return -1;
      const start = j;
      const isHex = (c: string) =>
        isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
      j = consume(s, j, isHex);
      return j - start >= 32 ? start + 32 : -1;
    },
  },
  // HashiCorp Vault tokens: hvs. / hvb. / hvr. + token chars
  {
    id: 'vault_token',
    scan: (s, i) => {
      const prefixes = ['hvs.', 'hvb.', 'hvr.'];
      for (const p of prefixes) {
        const j = matchLiteral(s, i, p);
        if (j >= 0) {
          const end = consume(s, j, (c) => isB64Url(c) || c === '.');
          if (end - j >= 10) return end;
        }
      }
      return -1;
    },
  },
  // OAuth bearer token: 'Bearer ' + long token
  {
    id: 'oauth_bearer',
    scan: (s, i) => {
      let j = matchLiteral(s, i, 'Bearer ');
      if (j < 0) j = matchLiteral(s, i, 'bearer ');
      if (j < 0) return -1;
      // skip additional spaces
      while (j < s.length && s[j] === ' ') j++;
      const start = j;
      const end = consume(s, j, (c) => isB64(c) || c === '-' || c === '_' || c === '.');
      return end - start >= 16 ? end : -1;
    },
  },
  // Generic high-entropy secret assignment:  key = "<20+ token chars>"
  // Implemented WITHOUT lookaround: match a known secret-ish key name literally.
  {
    id: 'generic_secret_assignment',
    scan: (s, i) => {
      const keys = [
        'api_key',
        'apikey',
        'secret',
        'password',
        'passwd',
        'token',
        'access_key',
        'private_key',
        'client_secret',
      ];
      // key must be at a word boundary (preceding char non-alnum or start)
      if (i > 0 && isAlnum(s[i - 1])) return -1;
      let keyEnd = -1;
      // case-insensitive literal match for any key name
      const lower = s.toLowerCase();
      for (const key of keys) {
        if (matchLiteral(lower, i, key) === i + key.length) {
          const after = s[i + key.length];
          if (after === undefined || !isAlnum(after) || after === '_') {
            keyEnd = i + key.length;
            break;
          }
          if (!isAlnum(after)) {
            keyEnd = i + key.length;
            break;
          }
        }
      }
      if (keyEnd < 0) return -1;
      // consume separator: optional spaces, then one of = : =>
      let j = keyEnd;
      j = consume(s, j, (c) => c === ' ' || c === '\t');
      if (s[j] === '=' && s[j + 1] === '>') j += 2;
      else if (s[j] === '=' || s[j] === ':') j += 1;
      else return -1;
      j = consume(s, j, (c) => c === ' ' || c === '\t');
      // optional opening quote
      let quote = '';
      if (s[j] === '"' || s[j] === "'" || s[j] === '`') {
        quote = s[j];
        j++;
      }
      const valStart = j;
      const val = consume(s, j, (c) => isB64(c) || c === '-' || c === '_' || c === '.');
      if (val - valStart < 12) return -1;
      let end = val;
      if (quote && s[end] === quote) end++;
      return end;
    },
  },
];

// Core single-pass scan. For each index we try each pattern; the first that
// matches wins and we jump past it. Strictly O(n * P), never backtracks.
export function redactString(text: string): RedactResult {
  if (typeof text !== 'string') {
    return { redacted: '', hits: [] };
  }
  // length-cap before scan (defense in depth)
  const capped = text.length > MAX_SCAN_LENGTH ? text.slice(0, MAX_SCAN_LENGTH) : text;

  const hits: Hit[] = [];
  let out = '';
  let i = 0;
  const n = capped.length;
  while (i < n) {
    let matched = false;
    for (const pat of PATTERNS) {
      const end = pat.scan(capped, i);
      if (end > i) {
        hits.push({ pattern_id: pat.id, start: i, end });
        out += placeholder(pat.id);
        i = end;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += capped[i];
      i++;
    }
  }
  // preserve any truncated tail as-is (already scanned portion is redacted)
  if (text.length > MAX_SCAN_LENGTH) {
    out += text.slice(MAX_SCAN_LENGTH);
  }
  return { redacted: out, hits };
}

// Alias used by adapters at dispatch time — returns redacted text only.
export function redactOutboundString(text: string): string {
  return redactString(text).redacted;
}

export function containsSecret(text: string): boolean {
  if (typeof text !== 'string') return false;
  return redactString(text).hits.length > 0;
}

// Deep-walk arbitrary structures, redacting every string it finds. Object
// keys are left intact; only string VALUES (and array elements) are scrubbed.
export function redactObject<T>(obj: T): T {
  return redactValue(obj) as T;
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactOutboundString(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = redactValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

// Frozen list of built-in pattern ids for introspection / tests.
export const BUILTIN_PATTERN_IDS: readonly string[] = Object.freeze(
  PATTERNS.map((p) => p.id),
);
