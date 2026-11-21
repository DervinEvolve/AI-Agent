import {
  VIEW_CAP_BYTES,
  MapFullOutputStore,
  capUtf8,
  classifyThenCap,
  recallAll,
  recallPage,
} from '../browser_view_cap_pipeline';

interface TestResult {
  call_id: string;
  dispatched: boolean;
  output: string;
  error?: string;
}

// Test-local stand-in applying the retained ruling; the production classifier
// is injected by the caller and is not redefined by the module under test.
function testClassifier(r: TestResult): 'success' | 'failure' | 'unknown' {
  if (r.dispatched === false) return 'failure';
  if (r.error) return 'unknown';
  return 'success';
}

const byteLen = (s: string) => new TextEncoder().encode(s).length;

function bigPage(n: number): { nodes: { id: number; role: string; value: string }[]; output: string } {
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: i,
    role: 'textbox',
    value: `värde-${i}-` + '日本語'.repeat(8),
  }));
  return { nodes, output: JSON.stringify({ nodes }) };
}

describe('classifyThenCap', () => {
  it('caps an oversized page at 24 KiB with a marker and classifies identically to uncapped', () => {
    const { output } = bigPage(2000);
    expect(byteLen(output)).toBeGreaterThan(VIEW_CAP_BYTES);
    const result: TestResult = { call_id: 'c1', dispatched: true, output };

    const capped = classifyThenCap({ result, classify: testClassifier, store: new MapFullOutputStore() });
    const uncapped = classifyThenCap({
      result,
      classify: testClassifier,
      store: new MapFullOutputStore(),
      capBytes: byteLen(output),
    });

    expect(uncapped.truncation).toBeNull();
    expect(uncapped.payload).toBe(output);
    expect(capped.status).toBe('success');
    expect(capped.status).toBe(uncapped.status);
    expect(capped.call_id).toBe('c1');
    expect(byteLen(capped.payload)).toBeLessThanOrEqual(VIEW_CAP_BYTES);
    expect(capped.truncation).toEqual({
      truncated: true,
      total_bytes: byteLen(output),
      view_bytes: byteLen(capped.payload),
      next_offset: byteLen(capped.payload),
    });
    // marker is outside the payload: payload is a pure prefix of the output
    expect(output.startsWith(capped.payload)).toBe(true);
    expect(capped.payload).not.toContain('\uFFFD');
  });

  it('recall with advancing offsets returns every node and full values', () => {
    const { nodes, output } = bigPage(2000);
    const store = new MapFullOutputStore();
    const view = classifyThenCap({
      result: { call_id: 'c2', dispatched: true, output },
      classify: testClassifier,
      store,
    });

    let text = view.payload;
    let offset = view.truncation!.next_offset;
    let pages = 0;
    for (;;) {
      const page = recallPage(store, 'c2', offset, 4097);
      expect(page.found).toBe(true);
      expect(page.next_offset).toBeGreaterThan(page.offset);
      text += page.text;
      pages++;
      if (page.done) break;
      offset = page.next_offset;
    }
    expect(pages).toBeGreaterThan(1);
    expect(text).toBe(output);
    expect(JSON.parse(text).nodes).toEqual(nodes);
    expect(recallAll(store, 'c2', 1000)).toBe(output);
  });

  it('hands the classifier the full result exactly once, before store and cap', () => {
    const { output } = bigPage(2000);
    const order: string[] = [];
    const seen: string[] = [];
    const store = new MapFullOutputStore();
    const spyStore = {
      put(id: string, full: string) {
        order.push('store');
        store.put(id, full);
      },
      get: (id: string) => store.get(id),
    };
    const result: TestResult = { call_id: 'c3', dispatched: true, output };
    classifyThenCap({
      result,
      classify: (r) => {
        order.push('classify');
        seen.push(r.output);
        expect(store.get('c3')).toBeUndefined();
        return testClassifier(r);
      },
      store: spyStore,
    });
    expect(order).toEqual(['classify', 'store']);
    expect(seen).toEqual([output]);
    expect(store.get('c3')).toBe(output);
    expect(result.output).toBe(output);
  });

  it('truncation never changes failure/unknown either', () => {
    const { output } = bigPage(2000);
    const store = new MapFullOutputStore();
    const notDispatched = classifyThenCap({
      result: { call_id: 'f', dispatched: false, output },
      classify: testClassifier,
      store,
    });
    const errored = classifyThenCap({
      result: { call_id: 'u', dispatched: true, output, error: 'timeout' },
      classify: testClassifier,
      store,
    });
    expect(notDispatched.status).toBe('failure');
    expect(errored.status).toBe('unknown');
    expect(notDispatched.truncation?.truncated).toBe(true);
  });

  it('a result of exactly 24 KiB gets no marker; one byte more does', () => {
    const store = new MapFullOutputStore();
    const exact = 'a'.repeat(VIEW_CAP_BYTES);
    const v = classifyThenCap({ result: { call_id: 'e', dispatched: true, output: exact }, classify: testClassifier, store });
    expect(v.truncation).toBeNull();
    expect(v.payload).toBe(exact);

    const over = classifyThenCap({
      result: { call_id: 'o', dispatched: true, output: exact + 'a' },
      classify: testClassifier,
      store,
    });
    expect(over.truncation?.view_bytes).toBe(VIEW_CAP_BYTES);
    expect(over.truncation?.total_bytes).toBe(VIEW_CAP_BYTES + 1);
  });
});

describe('capUtf8 / recallPage edges', () => {
  it('caps by bytes and never splits a multibyte character', () => {
    const text = 'é'.repeat(10); // 20 bytes
    const c = capUtf8(text, 7);
    expect(c.truncated).toBe(true);
    expect(c.viewBytes).toBe(6);
    expect(c.text).toBe('ééé');
    expect(c.totalBytes).toBe(20);

    const emoji = capUtf8('a😀b', 3);
    expect(emoji.text).toBe('a');
    expect(emoji.viewBytes).toBe(1);
  });

  it('pages make progress even when the limit is smaller than a character', () => {
    const store = new MapFullOutputStore();
    store.put('m', '😀😀é');
    expect(recallAll(store, 'm', 1)).toBe('😀😀é');
    const p = recallPage(store, 'm', 0, 1);
    expect(p.text).toBe('😀');
    expect(p.next_offset).toBe(4);
  });

  it('reports missing ids, end-of-output, and bad arguments', () => {
    const store = new MapFullOutputStore();
    store.put('x', 'héllo');
    expect(recallPage(store, 'nope').found).toBe(false);
    expect(recallAll(store, 'nope')).toBeUndefined();
    const end = recallPage(store, 'x', 999);
    expect(end).toMatchObject({ found: true, text: '', done: true, total_bytes: 6 });
    expect(() => recallPage(store, 'x', 2)).toThrow(RangeError);
    expect(() => recallPage(store, 'x', -1)).toThrow(RangeError);
    expect(() => recallPage(store, 'x', 0, 0)).toThrow(RangeError);
    expect(() => capUtf8('a', 0)).toThrow(RangeError);
  });
});
