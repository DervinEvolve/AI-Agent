# Semantic memory: encoding foundation only

Delivery status: **specified, not implemented as an executable retrieval service**. This additive contribution implements canonical artifact encoding, raw-byte digest verification, and normalized 384-component little-endian float32 vector encoding. It does not enable semantic memory or register a tool. No production fake encoder or lexical fallback is supplied.

## Preflight limitations

The supplied file listing was available, but file contents, repository SHA, shell execution, and package installation were not available in this contribution environment. Consequently the main SHA, existing interfaces, baseline suite, full-suite result, registry strictness, and worker startup compatibility remain unverified. No tests are claimed to have run. The developer's permitted paths exclude manifests and lockfiles, so pinning a new embedding dependency also requires a separate authorized change.

## Public foundation interface

`src/capabilities/semantic_snapshot_encoding.ts` exports:

- `requireWellFormedUnicode(value: string): void`
- `canonicalJson(value: unknown): string`
- `canonicalArtifactBytes(payload: unknown): Buffer`
- `artifactDigest(bytes: Uint8Array): string`
- `decodeCanonicalArtifact(bytes: Uint8Array, expectedDigest: string): unknown`
- `encodeSemanticVector(input: readonly number[] | Float32Array | Float64Array): string`
- `decodeSemanticVector(encoded: string): Float32Array`

Decoding canonical artifacts validates encoding and digest only. It must not be used as a substitute for complete snapshot-schema validation, principal ownership, or publication authorization. Hashes establish byte identity, not authorship. Canonical serialization accepts JSON data objects, rejects accessors and exotic values, and bounds nesting to 128. Its final output limit is 64 MiB; this is not a streaming allocation bound. A future schema validator must enforce corpus bounds before encoding.

## Symbol-to-test map

`semantic_snapshot_encoding.test.ts` covers canonical serialization and golden bytes/digest, malformed Unicode, non-JSON values, UTF-16 key ordering, duplicate-key/noncanonical-byte rejection, raw digest mismatch, float32 rounding, little-endian representation, negative zero, defensive copies, and invalid vectors. These are deterministic encoding tests only—not retrieval, orchestration, persistence, or real-model integration evidence.

## Remaining blockers

Stages A, B, and C are not complete. Required work includes inspecting the actual retrieval/runtime interfaces; runtime mounting and strict tool admission; shared-deadline worker cleanup and taint; observations and shape-2 citations; full versioned snapshot schema; principal-bound authorization; secure no-clobber durable publication and cross-process loading; and the lazily imported, locally provisioned real encoder. Disabled runtime behavior is unchanged because no existing module is modified or imports this foundation.

Real-model integration was not executed. No Recall@5, MRR@5, latency, fingerprint, code SHA, or improvement claim is available. Missing model artifacts remain a deployment blocker. Both the complete existing Vitest suite and the opted-in real-model suite still require execution before any service-delivery claim.
