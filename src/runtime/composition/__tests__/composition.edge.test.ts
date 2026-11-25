import { describe, it, expect } from 'vitest';
import {
  COMPOSITION_CAPS,
  COMPOSITION_REASON_CODES,
  createInitialEnvelope,
  InMemoryJournalStore,
  rebuildEnvelopeFromJournal,
  validateCompositionConfig,
} from '../index';

describe('cap_composed_runtime_65 edge and boundary cases', () => {
  it('accepts inclusive drainDeadlineMs and teardownReserveMs bounds', () => {
    expect(
      validateCompositionConfig({
        enabled: true,
        drainDeadlineMs: COMPOSITION_CAPS.MIN_DRAIN_DEADLINE_MS,
        teardownReserveMs: COMPOSITION_CAPS.MIN_TEARDOWN_RESERVE_MS,
      }),
    ).toEqual({ valid: true });

    expect(
      validateCompositionConfig({
        enabled: true,
        drainDeadlineMs: COMPOSITION_CAPS.MAX_DRAIN_DEADLINE_MS,
        teardownReserveMs: COMPOSITION_CAPS.MAX_TEARDOWN_RESERVE_MS,
      }),
    ).toEqual({ valid: true });
  });

  it('rejects all incompatible subsystem co-mounts when durable or sessionMode is enabled', () => {
    const incompatibleFlags = [
      'modelRouter',
      'workspaceTrials',
      'pixelBrowserControl',
      'sandboxEgress',
      'toolPrograms',
      'toolDiscovery',
    ] as const;

    for (const flag of incompatibleFlags) {
      expect(
        validateCompositionConfig({
          enabled: true,
          sessionMode: true,
          [flag]: true,
        }),
      ).toMatchObject({
        valid: false,
        reason: COMPOSITION_REASON_CODES.INCOMPATIBLE_SUBSYSTEM_COMOUNT,
      });
    }
  });

  it('isolates InMemoryJournalStore views via structuredClone and tracks per-run entries', () => {
    const store = new InMemoryJournalStore();
    const env = createInitialEnvelope('run-a', 'principal-1');
    store.persistView(env);

    // Mutating the original object must not affect the persisted view
    env.turn_index = 99;
    env.teardown_unconfirmed = true;

    const readBack = store.readView('run-a');
    expect(readBack).not.toBeNull();
    expect(readBack!.turn_index).toBe(0);
    expect(readBack!.teardown_unconfirmed).toBe(false);
    expect(store.readView('run-missing')).toBeNull();

    // Rebuilding from empty journal matches initial envelope
    const rebuilt = rebuildEnvelopeFromJournal('run-a', 'principal-1', store.readAll('run-a'));
    expect(rebuilt).toEqual(readBack);
  });
});
