import { StateSnapshot } from "./simulation_state_tracker";
import { SimulatedAction, StepPrediction, PredictiveDynamicsEngine } from "./predictive_dynamics_engine";

export class CounterfactualEvaluator {
  private dynamicsEngine = new PredictiveDynamicsEngine();

  public evaluateHypothesis(
    initialState: StateSnapshot,
    actions: SimulatedAction[],
    hypothesis: string
  ): {
    sequence: StepPrediction[];
    aggregate_success_probability: number;
    primary_failure_mode: string;
  } {
    const sequence: StepPrediction[] = [];
    let tempState = JSON.parse(JSON.stringify(initialState));
    let aggregate_success_probability = 1.0;
    let primary_failure_mode = "none";

    // Inject hypothesis into state variables
    if (hypothesis) {
      tempState.state_variables["counterfactual_hypothesis"] = hypothesis;
      if (hypothesis.includes("429") || hypothesis.includes("rate limit")) {
        tempState.state_variables["api_status"] = "rate_limited";
      } else if (hypothesis.includes("file system error") || hypothesis.includes("read-only")) {
        tempState.state_variables["fs_status"] = "error";
      }
    }

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];

      // Induce dynamics based on injected hypothesis
      if (tempState.state_variables["api_status"] === "rate_limited" && action.action_type === "query_db") {
        sequence.push({
          step: i + 1,
          action,
          predicted_state: { ...tempState.state_variables, error: "Rate limit exceeded (429)" },
          uncertainty_score: 0.9,
          reward_signal: -8.0,
          safety_violations: ["RateLimitExceeded"],
          blocked: false,
        });
        aggregate_success_probability *= 0.1;
        primary_failure_mode = "RateLimitExceeded";
        continue;
      }

      if (tempState.state_variables["fs_status"] === "error" && action.action_type === "write_file") {
        sequence.push({
          step: i + 1,
          action,
          predicted_state: { ...tempState.state_variables, error: "EACCES: permission denied" },
          uncertainty_score: 0.8,
          reward_signal: -5.0,
          safety_violations: ["FileSystemError"],
          blocked: false,
        });
        aggregate_success_probability *= 0.2;
        primary_failure_mode = "FileSystemError";
        continue;
      }

      const prediction = this.dynamicsEngine.predictStep(i + 1, action, tempState);
      sequence.push(prediction);
      tempState.state_variables = prediction.predicted_state;

      if (prediction.blocked || prediction.safety_violations.length > 0) {
        aggregate_success_probability *= 0.3;
        if (primary_failure_mode === "none") {
          primary_failure_mode = prediction.safety_violations[0] || "PolicyBlocked";
        }
      }
    }

    return {
      sequence,
      aggregate_success_probability,
      primary_failure_mode,
    };
  }
}
