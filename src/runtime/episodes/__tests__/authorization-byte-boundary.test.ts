import { canonicalBytes, EPISODE_CAPS } from '../types';
import { authorizeEpisodeBatch } from '../authorize_batch';

describe('episode batch UTF-8 record boundary', () => {
  // A JSON string has two quote bytes. Emoji consume four UTF-8 bytes
  // each, despite occupying only two JavaScript string code units.
  const available = EPISODE_CAPS.episodeBytes - 2;
  const exact = '😀'.repeat(Math.floor(available / 4)) + 'x'.repeat(available % 4);

  it('authorizes an inclusive-cap multibyte record and retains its exact bytes', async () => {
    let calls = 0;
    let authorizedEnvelope: Uint8Array | undefined;
    const result = await authorizeEpisodeBatch({
      principal: 'boundary-principal',
      records: [exact],
      authorize(request) {
        calls++;
        expect(request.principal).toBe('boundary-principal');
        expect(request.purpose).toBe('episode');
        authorizedEnvelope = request.bytes.slice();
        return true;
      },
    });

    expect(calls).toBe(1);
    expect(result.approved).toBe(true);
    if (!result.approved) throw new Error('Expected boundary record approval');
    expect(result.recordBytes).toHaveLength(1);
    expect(result.recordBytes[0].byteLength).toBe(EPISODE_CAPS.episodeBytes);
    expect(result.recordBytes[0]).toEqual(canonicalBytes(exact, EPISODE_CAPS.episodeBytes));
    expect(result.envelopeBytes).toEqual(authorizedEnvelope);
    expect(JSON.parse(new TextDecoder().decode(result.envelopeBytes)).records).toEqual([exact]);
  });

  it('rejects the entire batch before authorization when a later record exceeds the byte cap', async () => {
    let calls = 0;
    const oversized = exact + 'é';
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength)
      .toBe(EPISODE_CAPS.episodeBytes + 2);

    const result = await authorizeEpisodeBatch({
      principal: 'boundary-principal',
      records: [{ outcome: 'unknown' }, oversized],
      authorize() {
        calls++;
        return true;
      },
    });

    expect(calls).toBe(0);
    expect(result).toEqual({ approved: false, reason: 'invalid_batch' });
    expect('recordBytes' in result).toBe(false);
    expect('envelopeBytes' in result).toBe(false);
  });
});
