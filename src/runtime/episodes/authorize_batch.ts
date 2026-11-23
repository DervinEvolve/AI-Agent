import { canonicalBytes, EPISODE_CAPS } from './types';

export interface EpisodeAuthorizationRequest {
  readonly principal: string;
  readonly purpose: 'episode';
  /** Detached copy: mutation cannot change the retained envelope or records. */
  readonly bytes: Uint8Array;
}

export type EpisodeAuthorizer = (request: EpisodeAuthorizationRequest) => unknown | Promise<unknown>;
export interface AuthorizationTimer {
  schedule(callback: () => void, milliseconds: number): () => void;
}
const timer: AuthorizationTimer = {
  schedule(callback, milliseconds) {
    const handle = setTimeout(callback, milliseconds);
    return () => clearTimeout(handle);
  },
};

export type BatchAuthorization =
  | { approved: false; reason: 'missing_authorizer' | 'invalid_batch' | 'denied' | 'timeout' | 'authorization_error' }
  | { approved: true; envelopeBytes: Uint8Array; recordBytes: readonly Uint8Array[] };

/**
 * Exact-byte authorization boundary, not a persistence API or runtime mount.
 * Caller must validate episode schema and attach published terminal metadata
 * before invoking this function. Approval is the literal boolean true only.
 * A synchronous callback which never returns cannot be preempted here.
 */
export async function authorizeEpisodeBatch(options: {
  principal: string;
  records: readonly unknown[];
  authorize?: EpisodeAuthorizer;
  timeoutMs?: number;
  timer?: AuthorizationTimer;
}): Promise<BatchAuthorization> {
  if (!options.authorize) return { approved: false, reason: 'missing_authorizer' };
  const timeout = options.timeoutMs ?? EPISODE_CAPS.defaultAuthorizationTimeoutMs;
  let records: Uint8Array[];
  let envelope: Uint8Array;
  try {
    if (!options.principal || !Number.isInteger(timeout) || timeout < 1 ||
        timeout > EPISODE_CAPS.maximumAuthorizationTimeoutMs ||
        options.records.length > EPISODE_CAPS.candidates) throw new Error('Invalid batch');
    records = options.records.map(record => canonicalBytes(record, EPISODE_CAPS.episodeBytes));
    if (records.reduce((sum, record) => sum + record.byteLength, 0) > EPISODE_CAPS.bufferedBytes) {
      throw new Error('Buffer limit exceeded');
    }
    // Reconstruct from private canonical snapshots, never from caller objects.
    envelope = canonicalBytes({
      principal: options.principal,
      purpose: 'episode',
      records: records.map(record => JSON.parse(new TextDecoder().decode(record))),
    }, EPISODE_CAPS.envelopeBytes);
  } catch {
    return { approved: false, reason: 'invalid_batch' };
  }

  return new Promise(resolve => {
    let settled = false;
    let cancel = () => {};
    const finish = (result: BatchAuthorization) => {
      if (settled) return;
      settled = true;
      try { cancel(); } catch { /* Cleanup failure cannot grant authorization. */ }
      resolve(result);
    };
    try {
      cancel = (options.timer ?? timer).schedule(() => finish({ approved: false, reason: 'timeout' }), timeout);
      if (settled) { cancel(); return; }
      const result = options.authorize!(Object.freeze({
        principal: options.principal,
        purpose: 'episode' as const,
        bytes: envelope.slice(),
      }));
      Promise.resolve(result).then(approval => {
        if (approval !== true) finish({ approved: false, reason: 'denied' });
        else finish({ approved: true, envelopeBytes: envelope, recordBytes: records });
      }, () => finish({ approved: false, reason: 'authorization_error' }));
    } catch {
      finish({ approved: false, reason: 'authorization_error' });
    }
  });
}
