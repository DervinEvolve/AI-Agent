import type { Constraint } from './constraints';

export const con_virtual_desktop_safety_28: Constraint = {
  id: "con_virtual_desktop_safety_28",
  name: "Virtual desktop isolation, taint, and irreversible-action rules",
  status: "active",
  description: "The virtual desktop capability must run exclusively inside disposable isolated containers/VMs with no host access or credentials. All GUI observations are tainted evidence. No irreversible, authenticated, state-changing, costly, or unknown-consequence GUI actions (file writes that persist, credential entry, system config changes, purchases, etc.) without explicit user confirmation through the hitl channel immediately before dispatch. Container must be destroyed after use; any attempt to weaken isolation or escape is a hard failure.",
  added_epoch: 28
};
