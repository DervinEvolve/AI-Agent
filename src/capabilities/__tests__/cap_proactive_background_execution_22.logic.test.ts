import { describe, it, expect } from 'vitest';
import { registerTrigger, cancelTrigger, listTriggers, getTrigger } from '../../agent_controller/trigger_registry';
import { createBackgroundLease, executeBackground, getBackgroundStatus } from '../../agent_controller/background_executor';

describe('cap_proactive_background_execution_22 logic', () => {
  it('cancelTrigger removes only user-owned triggers and getTrigger reflects deletion', () => {
    const id = registerTrigger({ type: 'poll', condition: {}, mission_id: 'm2', budget_policy: {} }, 'u2');
    expect(cancelTrigger(id, 'u2')).toBe(true);
    expect(listTriggers('u2').length).toBe(0);
    expect(getTrigger(id)).toBeUndefined();
  });

  it('getBackgroundStatus distinguishes valid leases from invalid', () => {
    const lease = createBackgroundLease();
    expect(getBackgroundStatus(lease.id)).toBe('running');
    expect(getBackgroundStatus('invalid_lease')).toBe('not_found');
  });

  it('executeBackground returns invalid_trigger for webhook missing url', () => {
    const id = registerTrigger({ type: 'webhook', condition: {}, mission_id: 'm3', budget_policy: {} }, 'u3');
    const lease = createBackgroundLease();
    const res = executeBackground('m3', lease, id);
    expect(res.status).toBe('invalid_trigger');
  });
});