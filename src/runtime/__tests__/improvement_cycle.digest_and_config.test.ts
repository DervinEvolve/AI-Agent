import { createHash } from 'node:crypto';
import { runImprovementCycle, ImprovementCycleConfigError, sha256Hex } from '../improvement_cycle';
import type { ImprovementCycleConfig } from '../improvement_cycle';

describe('sha256Hex (overlay identity digest)', () => {
  it('matches published SHA-256 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae5e223b00361a396177a2c20017ae5f61f223');
  });

  it('hashes the exact UTF-8 bytes of the text', () => {
    const text = 'Prefer search before answering \u2014 caf\u00e9 \ud83d\ude80';
    const expected = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
    expect(sha256Hex(text)).toBe(expected);
    // Not the latin1 interpretation of the same string.
    const latin1 = createHash('sha256').update(Buffer.from('caf\u00e9', 'latin1')).digest('hex');
    expect(sha256Hex('caf\u00e9')).not.toBe(latin1);
  });

  it('is deterministic, 64 lowercase hex chars, and sensitive to any byte change', () => {
    const a = sha256Hex('overlay text');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex('overlay text')).toBe(a);
    expect(sha256Hex('overlay text ')).not.toBe(a);
    expect(sha256Hex('Overlay text')).not.toBe(a);
  });
});

describe('runImprovementCycle configuration errors happen before any adapter call', () => {
  function build(over: Partial<ImprovementCycleConfig>) {
    const calls = { trials: 0, proposals: 0 };
    const config: ImprovementCycleConfig = {
      principal: { id: 'alice', authenticated: true },
      incumbent: {
        configDigest: 'cfg-1',
        model: 'scripted',
        overlay: 'none',
        toolNames: ['search'],
        hasWorkspaceMutatingTool: false,
        workspaceMounted: false,
      },
      suite: {
        id: 's',
        tasks: [0, 1, 2, 3].map((i) => ({ id: 't' + i, contract: { id: 'c' + i }, payload: 'task text' })),
      },
      split: { dev: [0, 1], holdout: [2, 3] },
      trialsPerTask: 1,
      maxCandidates: 1,
      maxOverlayBytes: 200,
      maxGeneration: 4,
      proposer: {
        disclosureDestination: 'scripted-proposer',
        propose: async () => {
          calls.proposals++;
          return null;
        },
      },
      caps: { maxModelCalls: 100 },
      runTrial: async () => {
        calls.trials++;
        throw new Error('runTrial must not be reached on a configuration error');
      },
      ...over,
    };
    return { config, calls };
  }

  async function expectConfigError(over: Partial<ImprovementCycleConfig>) {
    const { config, calls } = build(over);
    let caught: unknown;
    try {
      await runImprovementCycle(config);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ImprovementCycleConfigError);
    expect(calls.trials).toBe(0);
    expect(calls.proposals).toBe(0);
  }

  it('rejects trialsPerTask above the 1-5 range', async () => {
    await expectConfigError({ trialsPerTask: 6 });
  });

  it('rejects a dev/holdout split that is not disjoint', async () => {
    await expectConfigError({ split: { dev: [0, 1], holdout: [1, 2] } });
  });
});
