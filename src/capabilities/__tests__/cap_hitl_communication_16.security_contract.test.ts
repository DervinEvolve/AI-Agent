import { describe, it, expect } from 'vitest';
import { hitl_channel } from '../cap_hitl_communication_16';

describe('cap_hitl_communication_16 security_contract', () => {
  it('request_approval for state-changing action returns requires_input and blocks until explicit confirmation', async () => {
    const res = await hitl_channel({ action: 'request_approval', message: 'confirm browser action', requires_approval: true }, { interactive: true, channel: 'controller' });
    expect(res.status).toBe('requires_input');
    expect(res.response?.tainted).toBe(true);
  });

  it('confirmation is delivered only via trusted controller channel', async () => {
    const res = await hitl_channel({ action: 'request_approval', message: 'test' }, { interactive: true, channel: 'controller' });
    expect(res.provenance.channel_id).toBe('controller');
  });

  it('non-interactive contexts always return policy_blocked', async () => {
    const res = await hitl_channel({ action: 'request_approval', message: 'test' }, { interactive: false, channel: 'none' });
    expect(res.status).toBe('policy_blocked');
  });

  it('all human responses are marked tainted=true', async () => {
    const res = await hitl_channel({ action: 'request_clarification', message: 'clarify' }, { interactive: true, channel: 'controller' });
    expect(res.response?.tainted).toBe(true);
  });
});
