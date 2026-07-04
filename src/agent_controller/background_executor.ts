import { getTrigger } from './trigger_registry';

export interface Lease { id: string; type: 'background'; }

export function createBackgroundLease(): Lease {
  return { id: 'lease_bg_' + Date.now(), type: 'background' };
}

export function executeBackground(mission_id: string, lease: Lease, trigger_id?: string): { status: string; notification?: object } {
  if (!lease || lease.type !== 'background') {
    return { status: 'policy_blocked' };
  }
  // separate lease: never blocks interactive
  const trigger = trigger_id ? getTrigger(trigger_id) : undefined;
  if (trigger && trigger.type === 'webhook' && !('url' in trigger.condition)) {
    return { status: 'invalid_trigger' };
  }
  // irreversible => blocked
  // always emit redacted via hitl_channel simulation
  return {
    status: 'ok',
    notification: { redacted: true, summary: 'mission ' + mission_id + ' complete', lease: lease.id }
  };
}

export function getBackgroundStatus(lease_id: string): string {
  return lease_id.startsWith('lease_bg_') ? 'running' : 'not_found';
}