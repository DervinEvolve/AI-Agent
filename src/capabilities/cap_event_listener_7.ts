export const cap_event_listener_7 = {
  id: 'cap_event_listener_7',
  description: 'The agent can register event listeners for file changes within the sandbox and timer/cron triggers. Events are collected asynchronously by a background event loop... Webhook support is now enabled under the proactive_background_execution_22 contract and inherits all non-interactive policy_blocked defaults.',
  // deferral logic removed; webhooks routed to proactive layer
  policy_blocked: true,
} as const;

export type CapEventListener7 = typeof cap_event_listener_7;
