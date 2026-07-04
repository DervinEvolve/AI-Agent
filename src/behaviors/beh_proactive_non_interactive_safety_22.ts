export const beh_proactive_non_interactive_safety_22 = {
  id: "beh_proactive_non_interactive_safety_22",
  name: "Proactive execution respects non-interactive policy defaults",
  status: "active",
  added_epoch: 22,
  description: "Any proactive/background execution must inherit the existing HITL non-interactive policy_blocked rule for irreversible actions. Background runs may only perform reversible, read-only, or pre-approved operations; results are always delivered as notifications rather than direct side-effects. User must be able to cancel or inspect all active triggers."
};
