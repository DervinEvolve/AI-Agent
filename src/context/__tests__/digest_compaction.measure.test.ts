import {
  COMPACTION_TARGET_RATIO,
  DEFAULT_KEEP_RECENT_GROUPS,
  DIGEST_MAX_BYTES,
  LIST_RECALLS_MAX_OUTPUT_BYTES,
  MAX_KEEP_RECENT_GROUPS,
  MIN_KEEP_RECENT_GROUPS,
  measureRequestBytes,
  parseContextCompactionOption,
} from '../digest_compaction';

function utf8(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

describe('spec constants (cap_context_compaction_mount_38)', () => {
  it('match the specified bounds', () => {
    expect(DIGEST_MAX_BYTES).toBe(4096);
    expect(LIST_RECALLS_MAX_OUTPUT_BYTES).toBe(4096);
    expect(COMPACTION_TARGET_RATIO).toBe(0.7);
    expect(DEFAULT_KEEP_RECENT_GROUPS).toBe(4);
    expect(MIN_KEEP_RECENT_GROUPS).toBe(2);
    expect(MAX_KEEP_RECENT_GROUPS).toBe(16);
    expect(DEFAULT_KEEP_RECENT_GROUPS).toBeGreaterThanOrEqual(MIN_KEEP_RECENT_GROUPS);
    expect(DEFAULT_KEEP_RECENT_GROUPS).toBeLessThanOrEqual(MAX_KEEP_RECENT_GROUPS);
  });
});

describe('measureRequestBytes as the shared admission/compaction measure', () => {
  it('counts UTF-8 bytes, not UTF-16 code units, for multi-byte text', () => {
    // {"t":""} is 8 bytes
    expect(measureRequestBytes({ t: '' })).toBe(8);
    // 2-byte character
    expect(measureRequestBytes({ t: '\u00e9' })).toBe(10);
    // 3-byte character
    expect(measureRequestBytes({ t: '\u20ac' })).toBe(11);
    // non-BMP: 2 UTF-16 code units, 4 UTF-8 bytes
    const emoji = '\u{1F600}';
    expect(emoji.length).toBe(2);
    expect(measureRequestBytes({ t: emoji })).toBe(12);
  });

  it('measures the serialized form, including JSON escapes', () => {
    // a quote and a newline each serialize as a 2-byte escape
    expect(measureRequestBytes({ t: '"' })).toBe(10);
    expect(measureRequestBytes({ t: '\n' })).toBe(10);
    // undefined array slots serialize as null
    expect(measureRequestBytes([undefined])).toBe(6);
  });

  it('equals the byte length of the exact JSON serialization for a realistic request', () => {
    const request = {
      instructions: 'be careful \u{1F512}',
      tools: [{ name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      digest: '[step 1] read_file call_1 ok 500B',
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'call_9', name: 'read_file' }] },
        { role: 'tool', tool_call_id: 'call_9', content: 'h\u00e9llo "w\u00f6rld"\n\u{1F600}' },
      ],
    };
    expect(measureRequestBytes(request)).toBe(utf8(request));
    expect(measureRequestBytes(request, 0)).toBe(utf8(request));
  });

  it('adds response headroom exactly once', () => {
    const request = { messages: [{ role: 'user', content: 'hi' }] };
    const base = measureRequestBytes(request);
    expect(measureRequestBytes(request, 1)).toBe(base + 1);
    expect(measureRequestBytes(request, 1024)).toBe(base + 1024);
  });

  it('distinguishes exactly-at-limit from one byte over', () => {
    const make = (n: number) => ({ task: 'do it', messages: [{ role: 'tool', content: 'a'.repeat(n) }] });
    const limit = measureRequestBytes(make(100), 64);
    // exactly at the limit: not over
    expect(measureRequestBytes(make(100), 64) > limit).toBe(false);
    // one more ASCII byte of content: exactly one byte over
    expect(measureRequestBytes(make(101), 64)).toBe(limit + 1);
    // one more byte of headroom is equivalent to one more byte of content
    expect(measureRequestBytes(make(100), 65)).toBe(limit + 1);
  });

  it('grows by 4 bytes per non-BMP character added', () => {
    const make = (n: number) => ({ content: '\u{1F600}'.repeat(n) });
    const zero = measureRequestBytes(make(0));
    expect(measureRequestBytes(make(1))).toBe(zero + 4);
    expect(measureRequestBytes(make(25))).toBe(zero + 100);
  });

  it('is deterministic and does not mutate the request', () => {
    const request = { a: [1, 2, 3], b: { c: 'x' } };
    const snapshot = JSON.stringify(request);
    const first = measureRequestBytes(request, 10);
    const second = measureRequestBytes(request, 10);
    expect(first).toBe(second);
    expect(JSON.stringify(request)).toBe(snapshot);
  });

  it('rejects headroom that is not a non-negative integer', () => {
    expect(() => measureRequestBytes({}, -1)).toThrow(TypeError);
    expect(() => measureRequestBytes({}, 1.5)).toThrow(TypeError);
    expect(() => measureRequestBytes({}, Number.NaN)).toThrow(TypeError);
    expect(() => measureRequestBytes({}, Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it('rejects requests that have no JSON serialization', () => {
    expect(() => measureRequestBytes(undefined)).toThrow(TypeError);
    expect(() => measureRequestBytes(() => 1)).toThrow(TypeError);
    expect(() => measureRequestBytes(Symbol('s'))).toThrow(TypeError);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => measureRequestBytes(circular)).toThrow();
  });
});

describe('parseContextCompactionOption strictness', () => {
  it('defaults keepRecentGroups when enabled', () => {
    expect(parseContextCompactionOption({ enabled: true })).toMatchObject({
      enabled: true,
      keepRecentGroups: DEFAULT_KEEP_RECENT_GROUPS,
    });
  });

  it('accepts both ends of the keepRecentGroups range', () => {
    expect(
      parseContextCompactionOption({ enabled: true, keepRecentGroups: MIN_KEEP_RECENT_GROUPS }),
    ).toMatchObject({ enabled: true, keepRecentGroups: 2 });
    expect(
      parseContextCompactionOption({ enabled: true, keepRecentGroups: MAX_KEEP_RECENT_GROUPS }),
    ).toMatchObject({ enabled: true, keepRecentGroups: 16 });
  });

  it('rejects keepRecentGroups just outside the range', () => {
    expect(() =>
      parseContextCompactionOption({ enabled: true, keepRecentGroups: MIN_KEEP_RECENT_GROUPS - 1 }),
    ).toThrow();
    expect(() =>
      parseContextCompactionOption({ enabled: true, keepRecentGroups: MAX_KEEP_RECENT_GROUPS + 1 }),
    ).toThrow();
  });

  it('rejects an unknown key such as summarizer on an enabled option', () => {
    expect(() => parseContextCompactionOption({ enabled: true, summarizer: {} })).toThrow();
  });
});
