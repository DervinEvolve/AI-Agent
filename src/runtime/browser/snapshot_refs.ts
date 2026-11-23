import type {
  PageIdentity,
  SnapshotRef,
  SnapshotRefResolution,
} from './types';

export function resolveSnapshotRef(
  ref: SnapshotRef,
  expectedRunId: string,
  activeSnapshotId: string | null,
  activeRefs: ReadonlyMap<string, SnapshotRef>,
  currentIdentity: PageIdentity,
): SnapshotRefResolution {
  if (ref.run_id !== expectedRunId) {
    return { ok: false, reason: 'cross_run_ref' };
  }
  if (!activeSnapshotId || ref.snapshot_id !== activeSnapshotId) {
    return { ok: false, reason: 'stale_snapshot_id' };
  }
  const stored = activeRefs.get(ref.ref_id);
  if (!stored) {
    return { ok: false, reason: 'missing_ref' };
  }
  if (stored.document_id !== currentIdentity.documentId) {
    return { ok: false, reason: 'document_changed' };
  }
  if (stored.dom_generation !== currentIdentity.domGeneration) {
    return { ok: false, reason: 'dom_generation_changed' };
  }
  if (stored.target_id !== ref.target_id) {
    return { ok: false, reason: 'target_identity_mismatch' };
  }
  return { ok: true, ref: stored };
}
