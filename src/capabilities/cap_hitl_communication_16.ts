export type HitlAction = 'request_clarification' | 'propose_action' | 'request_approval' | 'send_status';

export interface HitlInputs {
  action: HitlAction;
  message: string;
  target_action?: { type: string; target: string; grant_id?: string; consequences?: string };
  timeout_seconds?: number;
  requires_approval?: boolean;
}

export interface HitlOutputs {
  error?: object;
  status: 'ok' | 'requires_input' | 'policy_blocked' | 'timeout' | 'denied';
  response?: { decision: string; tainted: boolean };
  provenance: { task_id: string; timestamp: string; channel_id: string };
}

export async function hitl_channel(inputs: HitlInputs, context: { interactive: boolean; channel: string }): Promise<HitlOutputs> {
  const timeout = Math.min(inputs.timeout_seconds || 300, 3600);
  const provenance = { task_id: 'current', timestamp: new Date().toISOString(), channel_id: context.channel };

  if (!context.interactive) {
    return { status: 'policy_blocked', provenance };
  }

  if (inputs.action === 'request_approval' && inputs.requires_approval) {
    // Out-of-band trusted channel only; simulate pending
    return { status: 'requires_input', response: { decision: 'pending', tainted: true }, provenance };
  }

  return { status: 'ok', provenance };
}
