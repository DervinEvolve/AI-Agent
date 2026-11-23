import { canonicalize, canonicalBytes, EPISODE_CAPS } from '../types';
import { authorizeEpisodeBatch } from '../authorize_batch';

 describe('episodic canonical authorization boundary', () => {
  it('sorts recursively without Unicode normalization and uses ECMAScript numbers', () => {
    expect(canonicalize({ z: -0, a: { z: 1e30, a: 'e\u0301' } })).toBe('{"a":{"a":"é","z":1e+30},"z":0}');
    expect(canonicalize({ '\ue000': 1, '😀': 2 })).toBe('{"😀":2,"":1}');
  });

  it('rejects unsupported data without executing getters', () => {
    for (const value of [NaN, Infinity, undefined, '\ud800', '\udc00', new Date(), [, 1]]) {
      expect(() => canonicalize(value)).toThrow();
    }
    let touched = false;
    expect(() => canonicalize({ get value() { touched = true; return 1; } })).toThrow();
    expect(touched).toBe(false);
    const cycle: any = {}; cycle.self = cycle;
    expect(() => canonicalize(cycle)).toThrow();
  });

  it('uses inclusive byte limits', () => {
    const exact = 'x'.repeat(EPISODE_CAPS.excerptBytes - 2);
    expect(canonicalBytes(exact, EPISODE_CAPS.excerptBytes).length).toBe(EPISODE_CAPS.excerptBytes);
    expect(() => canonicalBytes(exact + 'é', EPISODE_CAPS.excerptBytes)).toThrow();
  });

  it('binds approval to snapshots despite callback mutation', async () => {
    const source = { outcome: 'unknown' };
    let seen = '';
    const result = await authorizeEpisodeBatch({ principal: 'p', records: [source], authorize(request) {
      seen = new TextDecoder().decode(request.bytes);
      request.bytes.fill(0);
      source.outcome = 'success';
      return true;
    } });
    expect(result.approved).toBe(true);
    if (!result.approved) throw new Error('Expected approval');
    expect(new TextDecoder().decode(result.envelopeBytes)).toBe(seen);
    expect(new TextDecoder().decode(result.recordBytes[0])).toBe('{"outcome":"unknown"}');
    expect(JSON.parse(seen).records).toEqual([{ outcome: 'unknown' }]);
  });

  it('ignores late approval using an injected timer', async () => {
    let expire = () => {};
    let approve: (value: boolean) => void = () => {};
    const pending = authorizeEpisodeBatch({ principal: 'p', records: [],
      timer: { schedule(callback) { expire = callback; return () => {}; } },
      authorize: () => new Promise<boolean>(resolve => { approve = resolve; }),
    });
    expire();
    expect(await pending).toEqual({ approved: false, reason: 'timeout' });
    approve(true);
    expect(await pending).toEqual({ approved: false, reason: 'timeout' });
  });

  it('fails closed on absent, malformed, throwing and oversized authorization', async () => {
    const base = { principal: 'p', records: [] };
    expect(await authorizeEpisodeBatch(base)).toEqual({ approved: false, reason: 'missing_authorizer' });
    expect(await authorizeEpisodeBatch({ ...base, authorize: () => ({ approved: true }) })).toEqual({ approved: false, reason: 'denied' });
    expect(await authorizeEpisodeBatch({ ...base, authorize: () => { throw new Error('private'); } })).toEqual({ approved: false, reason: 'authorization_error' });
    let calls = 0;
    const result = await authorizeEpisodeBatch({ ...base, records: ['x'.repeat(EPISODE_CAPS.episodeBytes)], authorize: () => { calls++; return true; } });
    expect(result).toEqual({ approved: false, reason: 'invalid_batch' });
    expect(calls).toBe(0);
  });
});
