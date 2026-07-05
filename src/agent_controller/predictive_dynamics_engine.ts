import { StateSnapshot } from "./simulation_state_tracker";

export interface SimulatedAction {
  action_type: string;
  arguments: Record<string, any>;
}

export interface StepPrediction {
  step: number;
  action: SimulatedAction;
  predicted_state: Record<string, any>;
  uncertainty_score: number;
  reward_signal: number;
  safety_violations: string[];
  blocked: boolean;
}

export class PredictiveDynamicsEngine {
  /**
   * Models the environment's response to an action sequence inside the sandbox.
   * Rejects execution if it contains forbidden external indicators (network calls, external API triggers, etc.)
   */
  public predictStep(
    stepIndex: number,
    action: SimulatedAction,
    currentState: StateSnapshot
  ): StepPrediction {
    const safety_violations: string[] = [];
    let blocked = false;
    let reward_signal = 1.0;
    let uncertainty_score = 0.1;

    const actionStr = JSON.stringify(action).toLowerCase();

    // Enforce strict local-only execution: deny external API / network egress attempts
    const forbiddenKeywords = [
      "http://",
      "https://",
      "fetch(",
      "axios",
      "curl",
      "request",
      "socket",
      "ping",
      "dns.lookup",
      "live_adapter",
      "google.com",
      "web_search",
    ];

    for (const keyword of forbiddenKeywords) {
      if (actionStr.includes(keyword)) {
        safety_violations.push(`Security violation: Action contains/attempts external network egress via '${keyword}'.`);
        blocked = true;
        reward_signal = -10.0;
        uncertainty_score = 1.0;
      }
    }

    // Active policy rules assessment
    if (currentState.active_policy_rules) {
      for (const rule of currentState.active_policy_rules) {
        if (rule.toLowerCase().includes("no_delete") && action.action_type.toLowerCase().includes("delete")) {
          safety_violations.push(`Policy violation: Action violates policy rule '${rule}'`);
          reward_signal = Math.min(reward_signal, -5.0);
        }
      }
    }

    // Active constraints assessment
    if (currentState.constraints_snapshot) {
      for (const constraint of currentState.constraints_snapshot) {
        if (constraint.toLowerCase().includes("read_only") && action.action_type.toLowerCase().includes("write")) {
          safety_violations.push(`Constraint violation: Action violates constraint '${constraint}'`);
          reward_signal = Math.min(reward_signal, -3.0);
        }
      }
    }

    // Compute next state variables based on deterministic rules
    const nextVariables = JSON.parse(JSON.stringify(currentState.state_variables));
    if (!blocked) {
      if (action.action_type === "write_file") {
        nextVariables["last_written_file"] = action.arguments.filepath || "unknown";
        nextVariables["file_count"] = (nextVariables["file_count"] || 0) + 1;
      } else if (action.action_type === "query_db") {
        nextVariables["last_query"] = action.arguments.query || "";
        nextVariables["db_hits"] = (nextVariables["db_hits"] || 0) + 1;
      } else if (action.action_type === "execute_code") {
        nextVariables["stdout"] = "Execution successful (simulated)";
        nextVariables["exit_code"] = 0;
      }
    }

    return {
      step: stepIndex,
      action,
      predicted_state: nextVariables,
      uncertainty_score,
      reward_signal,
      safety_violations,
      blocked,
    };
  }
}
