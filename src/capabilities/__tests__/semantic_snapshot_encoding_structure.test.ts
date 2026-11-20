import { canonicalJson } from '../semantic_snapshot_encoding';

// Canonical encoding evidence only, not retrieval or model-quality evidence.
describe('canonical snapshot object traversal', () => {
  it('canonicalizes repeated shared subtrees without treating aliasing as a cycle', () => {
    const shared = Object.freeze({ z: '😀\n', a: -0 });
    const left = Object.freeze({
      z: Object.freeze([shared, shared]),
      a: shared,
    });
    const right = {
      a: { a: 0, z: '😀\n' },
      z: [{ a: 0, z: '😀\n' }, { z: '😀\n', a: 0 }],
    };

    const expected = '{"a":{"a":0,"z":"😀\\n"},"z":[{"a":0,"z":"😀\\n"},{"a":0,"z":"😀\\n"}]}';
    expect(canonicalJson(left)).toBe(expected);
    expect(canonicalJson(right)).toBe(expected);
    // Serialization must not sort or normalize the caller's objects in place.
    expect(Object.keys(shared)).toEqual(['z', 'a']);
    expect(Object.is(shared.a, -0)).toBe(true);
    expect(left.z[0]).toBe(left.z[1]);
  });

  it('rejects a back edge through an array but permits serialization after it is removed', () => {
    const children: unknown[] = [];
    const root = { children, label: 'source' };
    children.push({ parent: root });
    expect(() => canonicalJson(root)).toThrow();

    children.splice(0, 1, { value: 2 }, { value: 1 });
    expect(canonicalJson(root)).toBe('{"children":[{"value":2},{"value":1}],"label":"source"}');
  });

  it('orders numeric-looking object keys lexicographically while retaining array order', () => {
    const record = Object.create(null) as Record<string, unknown>;
    record['2'] = [2, 1];
    record['10'] = { b: false, a: null };
    record['1'] = 'first';
    expect(canonicalJson(record)).toBe('{"1":"first","10":{"a":null,"b":false},"2":[2,1]}');
  });
});
