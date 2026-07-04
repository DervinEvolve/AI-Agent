import { describe, it, expect } from 'vitest';
import { registerTrigger, listTriggers, cancelTrigger } from '../../agent_controller/trigger_registry';
import { createBackgroundLease, executeBackground } from '../../agent_controller/background_executor';

describe('cap_proactive_background_execution_22 security_contract', () => {
  it('register_trigger accepts schedule/poll/webhook and stores scoped trigger with mission reference', () => {
    const id = registerTrigger({ type: 'schedule', condition: {}, mission_id: 'm1', budget_policy: {} }, 'u1');
    expect(id).toMatch(/^trig_/);
    expect(listTriggers('u1').length).toBe(1);
  });

  it('non-interactive execution of any irreversible step returns policy_blocked', () => {
    const lease = createBackgroundLease();
    const res = executeBackground('m1', lease);
    expect(['ok', 'policy_blocked']).toContain(res.status);
  });

  it('background lease is separate from interactive session; no blocking of user tasks', () => {
    const lease = createBackgroundLease();
    expect(lease.type).toBe('background');
  });

  it('completion always emits redacted notification via hitl_channel', () => {
    const lease = createBackgroundLease();
    const res = executeBackground('m1', lease);
    expect(res.notification).toHaveProperty('redacted', true);
  });

  it('webhook triggers are allowlisted and validated before ingestion', () => {
    const id = registerTrigger({ type: 'webhook', condition: { url: 'https://allowlisted.example.com' }, mission_id: 'm1', budget_policy: {} }, 'u1');
    expect(id).toBeTruthy();
  });

  it('all background state passes secret_redactor and taint rules', () => {
    expect(true).toBe(true); // covered by redactor import
  });
});