import {
  artifactDigest, canonicalArtifactBytes, canonicalJson, decodeCanonicalArtifact,
  decodeSemanticVector, encodeSemanticVector, requireWellFormedUnicode,
} from '../semantic_snapshot_encoding';

// Encoding evidence only; these fixtures are not embedding or retrieval evidence.
describe('semantic snapshot encoding primitives', () => {
  it('has golden canonical bytes and a known SHA-256 fixture', () => {
    expect(canonicalJson({ z: -0, a: [1e30, '\n', true] })).toBe('{"a":[1e+30,"\\n",true],"z":0}');
    expect(canonicalArtifactBytes({}).toString('hex')).toBe('7b7d');
    expect(artifactDigest(canonicalArtifactBytes({}))).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
    expect(canonicalJson({ '\ue000': 2, '😀': 1 })).toBe('{"😀":1,"":2}');
  });

  it('rejects malformed Unicode and non-JSON values without calling accessors', () => {
    for (const value of ['\ud800', '\udfff', 'x\ud800y']) {
      expect(() => requireWellFormedUnicode(value)).toThrow('invalid_unicode');
    }
    requireWellFormedUnicode('x😀y');
    for (const value of [NaN, Infinity, undefined, new Date(), [undefined], new Array(1)]) {
      expect(() => canonicalJson(value)).toThrow();
    }
    let invoked = false;
    const object = Object.defineProperty({}, 'value', { enumerable: true, get() { invoked = true; return 1; } });
    expect(() => canonicalJson(object)).toThrow('non_json_property');
    expect(invoked).toBe(false);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow('cyclic_value');
  });

  it('rejects noncanonical bytes even when their digest matches', () => {
    for (const text of ['{ "a":1}', '{"a":1,"a":1}', '{"z":0,"a":1}', '{"a":-0}', '{"a":"\\u0061"}']) {
      const bytes = Buffer.from(text);
      expect(() => decodeCanonicalArtifact(bytes, artifactDigest(bytes))).toThrow('noncanonical_artifact');
    }
    const invalidUtf8 = Buffer.from([34, 0xff, 34]);
    expect(() => decodeCanonicalArtifact(invalidUtf8, artifactDigest(invalidUtf8))).toThrow('noncanonical_artifact');
    const bytes = canonicalArtifactBytes({ source: 'unchanged 😀\n' });
    expect(decodeCanonicalArtifact(bytes, artifactDigest(bytes))).toEqual({ source: 'unchanged 😀\n' });
    expect(() => decodeCanonicalArtifact(bytes, '0'.repeat(64))).toThrow('digest_mismatch');
  });

  it('rounds float32, canonicalizes negative zero, and copies defensively', () => {
    const vector = new Array<number>(384).fill(-0);
    vector[0] = 1;
    vector[1] = 2;
    const encoded = encodeSemanticVector(vector);
    vector[0] = 100;
    const decoded = decodeSemanticVector(encoded);
    expect(decoded[0]).toBe(Math.fround(1 / Math.sqrt(5)));
    expect(decoded[1]).toBe(Math.fround(2 / Math.sqrt(5)));
    expect(Object.is(decoded[2], -0)).toBe(false);
    decoded[0] = 0;
    expect(decodeSemanticVector(encoded)[0]).toBe(Math.fround(1 / Math.sqrt(5)));
    const unit = new Array<number>(384).fill(0);
    unit[0] = 1;
    expect(Buffer.from(encodeSemanticVector(unit), 'base64').subarray(0, 8).toString('hex')).toBe('0000803f00000000');
  });

  it('fails closed on invalid dimensions, numbers, zero norm and altered encodings', () => {
    expect(() => encodeSemanticVector([1])).toThrow('vector_dimension');
    const vector = new Array<number>(384).fill(0);
    expect(() => encodeSemanticVector(vector)).toThrow('vector_zero');
    for (const value of [NaN, Infinity, 1e100]) {
      vector[0] = value;
      expect(() => encodeSemanticVector(vector)).toThrow('vector_component');
    }
    vector[0] = 1;
    const encoded = encodeSemanticVector(vector);
    expect(() => decodeSemanticVector(encoded + '=')).toThrow('vector_encoding');
    expect(() => decodeSemanticVector(encoded + '\n')).toThrow('vector_encoding');
    const bytes = Buffer.from(encoded, 'base64');
    bytes.writeFloatLE(-0, 4);
    expect(() => decodeSemanticVector(bytes.toString('base64'))).toThrow('vector_component');
    bytes.writeFloatLE(0, 4);
    bytes.writeFloatLE(2, 0);
    expect(() => decodeSemanticVector(bytes.toString('base64'))).toThrow('vector_norm');
  });
});
