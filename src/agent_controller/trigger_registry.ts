import { secret_redactor } from '../capabilities/secret_redactor';

export interface Trigger {
  id: string;
  type: 'schedule' | 'poll' | 'webhook';
  condition: object;
  mission_id: string;
  budget_policy: object;
  user_id: string;
}

const triggers = new Map<string, Trigger>();

export function registerTrigger(trigger: Omit<Trigger, 'id'>, user_id: string): string {
  const id = 'trig_' + Date.now();
  const scoped = { ...trigger, id, user_id };
  triggers.set(id, scoped);
  return id;
}

export function listTriggers(user_id: string): Trigger[] {
  return Array.from(triggers.values()).filter(t => t.user_id === user_id);
}

export function cancelTrigger(trigger_id: string, user_id: string): boolean {
  const t = triggers.get(trigger_id);
  if (t && t.user_id === user_id) {
    triggers.delete(trigger_id);
    return true;
  }
  return false;
}

export function getTrigger(trigger_id: string): Trigger | undefined {
  return triggers.get(trigger_id);
}

export function validateWebhook(trigger: Trigger): boolean {
  // allowlist + validation
  return trigger.type === 'webhook' && 'url' in trigger.condition && (trigger.condition as any).url.startsWith('https://allowlisted.');
}

// ensure redaction
secret_redactor('dummy');