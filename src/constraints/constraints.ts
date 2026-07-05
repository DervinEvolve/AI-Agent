import { redactSecrets } from '../capabilities/secret_redactor';

export interface Constraint {
  id: string;
  name: string;
  status: string;
  added_epoch: number;
  description: string;
  implementation: {
    tests: string[];
  };
}

export interface SimulationState {
  approval_token?: string;
  is_simulation: boolean;
  has_network_access?: boolean;
  has_external_api_access?: boolean;
  tainted?: boolean;
  simulation_success_score?: number; // e.g. 0 to 1.0 (100% success)
  secrets?: string[];
  history?: string[];
}

export interface SimulationResult {
  status: 'allowed' | 'policy_blocked';
  reason?: string;
  tainted: boolean;
  history: string[];
  approval_token_validated: boolean;
}

/**
 * Evaluates a simulation step or full trajectory under con_world_model_simulation_non_authority_31.
 * Enforces four main isolation boundaries:
 * 1. Prevents simulated outcomes/trajectories from bypassing HITL authorization gates (requires fresh real approval_token validation).
 * 2. Halts and returns 'policy_blocked' if simulated code blocks attempt live network or external API access.
 * 3. Guarantees that tainted inputs permanently taint all simulator outputs.
 * 4. Ensures raw secrets/credentials are redacted via secret_redactor before snapshots/history are stored.
 */
export function evaluateSimulationBoundary(
  state: SimulationState,
  inputs: { tainted: boolean; data: string; secretsToRedact?: string[] }
): SimulationResult {
  const resultTainted = state.tainted || inputs.tainted;

  // Boundary 2: Halt and return policy_blocked if attempting live network/external API access
  if (state.has_network_access || state.has_external_api_access) {
    return {
      status: 'policy_blocked',
      reason: 'Simulation attempted live network or external API access.',
      tainted: resultTainted,
      history: [],
      approval_token_validated: false,
    };
  }

  // Boundary 1: Simulated successful runs or high confidence scores cannot satisfy HITL authorization.
  // It must always be marked as not validated if it is a simulated trajectory.
  const approval_token_validated = false;

  // Boundary 4: Pass all outputs through the secret_redactor and redact secrets before history storage
  const rawHistoryEntry = `Data: ${inputs.data}`;
  let redactedEntry = redactSecrets(rawHistoryEntry);

  if (inputs.secretsToRedact && inputs.secretsToRedact.length > 0) {
    for (const secret of inputs.secretsToRedact) {
      if (secret) {
        redactedEntry = redactedEntry.split(secret).join('[REDACTED_SIM_SECRET]');
      }
    }
  }

  const currentHistory = state.history ? [...state.history] : [];
  currentHistory.push(redactedEntry);

  return {
    status: 'allowed',
    tainted: resultTainted,
    history: currentHistory,
    approval_token_validated,
  };
}

export const constraints: Constraint[] = [
  {
    id: "con_world_model_simulation_non_authority_31",
    name: "Internal world-model simulation non-authority and isolation boundaries",
    status: "active",
    added_epoch: 31,
    description: "The internal world-model simulator must never be used to authorize side effects, execute live tools, clear taint, satisfy HITL confirmation, directly set live tool arguments, or substitute simulated outcomes for validated external evidence. Every simulation run must occur strictly within the isolated sandbox or internal LLM reasoning space, with all network access and live adapter calls completely disabled. Under no circumstances can a simulated successful run or high confidence score satisfy a task success criterion, complete a milestone in task_lifecycle_manager_26, or bypass a policy gate. Tainted inputs to the simulator must permanently taint all outputs of that simulation. The simulator must never store raw secrets, credentials, or live auth state in its snapshots or history, and must pass all outputs through the secret_redactor.",
    implementation: {
      tests: [
        "a simulation trajectory showing 100% success cannot authorize a live browser or API dispatch without a fresh verified HITL approval_token",
        "the simulator returns policy_blocked and halts the simulation if a simulated code block attempts to access live networks or external APIs",
        "simulated state transitions cannot clear taint flags or convert tainted variables into trusted tool arguments",
        "simulation records and history redact apparent secrets before storage and never contain live credentials or vault session handles"
      ]
    }
  }
];
