import { SimulationStateTracker, StateSnapshot } from "../agent_controller/simulation_state_tracker";
import { PredictiveDynamicsEngine, SimulatedAction } from "../agent_controller/predictive_dynamics_engine";

export interface SimulationInput {
  scope: {
    user_id: string;
    project_id: string;
    namespace: string;
  };
  action: "initialize_simulation" | "simulate_step" | "evaluate_counterfactual" | "get_simulation_report";
  simulation_id?: string;
  initial_state_snapshot?: StateSnapshot;
  proposed_actions?: SimulatedAction[];
  counterfactual_hypothesis?: string;
}

export interface SimulationOutput {
  status: "ok" | "simulation_completed" | "diverged" | "policy_blocked" | "budget_exhausted" | "invalid_state";
  tainted: boolean;
  provenance: {
    simulation_id?: string;
    scope: {
      user_id: string;
      project_id: string;
      namespace: string;
    };
    created_at: string;
    steps_simulated: number;
    source_event_refs: any[];
  };
  simulation_report?: {
    trajectories: Array<{
      path_index: number;
      sequence: any[];
      aggregate_success_probability: number;
      primary_failure_mode: string;
    }>;
    recommendation: string;
  };
}

export class WorldModelSimulator {
  private stateTracker = new SimulationStateTracker();
  private dynamicsEngine = new PredictiveDynamicsEngine();

  // Detect if any string or structure contains taint
  private isTainted(input: any): boolean {
    if (!input) return false;
    const str = JSON.stringify(input);
    return str.includes("__tainted__") || str.includes("tainted:true") || str.includes("tainted_input");
  }

  public async execute(input: SimulationInput): Promise<SimulationOutput> {
    const tainted = this.isTainted(input);

    if (input.action === "initialize_simulation") {
      if (!input.initial_state_snapshot) {
        return {
          status: "invalid_state",
          tainted,
          provenance: {
            scope: input.scope,
            created_at: new Date().toISOString(),
            steps_simulated: 0,
            source_event_refs: [],
          },
        };
      }

      const context = this.stateTracker.createSimulation(
        input.scope,
        input.initial_state_snapshot,
        tainted
      );

      return {
        status: "ok",
        tainted: context.tainted,
        provenance: {
          simulation_id: context.simulation_id,
          scope: context.scope,
          created_at: context.created_at,
          steps_simulated: context.steps_simulated,
          source_event_refs: [],
        },
      };
    }

    if (input.action === "simulate_step") {
      if (!input.simulation_id) {
        return {
          status: "invalid_state",
          tainted,
          provenance: {
            scope: input.scope,
            created_at: new Date().toISOString(),
            steps_simulated: 0,
            source_event_refs: [],
          },
        };
      }

      const context = this.stateTracker.getSimulation(input.simulation_id);
      if (!context) {
        return {
          status: "invalid_state",
          tainted,
          provenance: {
            scope: input.scope,
            created_at: new Date().toISOString(),
            steps_simulated: 0,
            source_event_refs: [],
          },
        };
      }

      const actions = input.proposed_actions || [];
      const trajectorySequence: any[] = [];
      let isPolicyBlocked = false;
      let totalTainted = context.tainted || tainted;

      for (const act of actions) {
        const prediction = this.dynamicsEngine.predictStep(
          context.steps_simulated + 1,
          act,
          context.current_state
        );

        if (prediction.blocked) {
          isPolicyBlocked = true;
        }

        this.stateTracker.updateSimulationState(
          context.simulation_id,
          prediction.predicted_state,
          totalTainted
        );

        trajectorySequence.push(prediction);
      }

      const status = isPolicyBlocked ? "policy_blocked" : "simulation_completed";

      return {
        status,
        tainted: context.tainted,
        provenance: {
          simulation_id: context.simulation_id,
          scope: context.scope,
          created_at: context.created_at,
          steps_simulated: context.steps_simulated,
          source_event_refs: [],
        },
        simulation_report: {
          trajectories: [
            {
              path_index: 0,
              sequence: trajectorySequence,
              aggregate_success_probability: isPolicyBlocked ? 0.0 : 0.95,
              primary_failure_mode: isPolicyBlocked ? "PolicyBlocked" : "none",
            },
          ],
          recommendation: isPolicyBlocked
            ? "Do not execute. Proposed sequence triggers a security/policy violation inside the simulator."
            : "Proceed with caution. Simulation indicates execution is safe and bounded.",
        },
      };
    }

    if (input.action === "evaluate_counterfactual") {
      if (!input.simulation_id || !input.counterfactual_hypothesis) {
        return {
          status: "invalid_state",
          tainted,
          provenance: {
            scope: input.scope,
            created_at: new Date().toISOString(),
            steps_simulated: 0,
            source_event_refs: [],
          },
        };
      }

      const context = this.stateTracker.getSimulation(input.simulation_id);
      if (!context) {
        return {
          status: "invalid_state",
          tainted,
          provenance: {
            scope: input.scope,
            created_at: new Date().toISOString(),
            steps_simulated: 0,
            source_event_refs: [],
          },
        };
      }

      const actions = input.proposed_actions || [];
      const hypothesis = input.counterfactual_hypothesis;

      // Evaluate counterfactual branch without changing the core simulation state
      const evaluator = new (require("../agent_controller/counterfactual_evaluator").CounterfactualEvaluator)();
      const branchResult = evaluator.evaluateHypothesis(context.current_state, actions, hypothesis);

      const reportTainted = context.tainted || tainted;

      return {
        status: "simulation_completed",
        tainted: reportTainted,
        provenance: {
          simulation_id: context.simulation_id,
          scope: context.scope,
          created_at: context.created_at,
          steps_simulated: context.steps_simulated,
          source_event_refs: [],
        },
        simulation_report: {
          trajectories: [
            {
              path_index: 1,
              sequence: branchResult.sequence,
              aggregate_success_probability: branchResult.aggregate_success_probability,
              primary_failure_mode: branchResult.primary_failure_mode,
            },
          ],
          recommendation: `Counterfactual branch evaluated under hypothesis: '${hypothesis}'.`,
        },
      };
    }

    if (input.action === "get_simulation_report") {
      if (!input.simulation_id) {
        return {
          status: "invalid_state",
          tainted,
          provenance: {
            scope: input.scope,
            created_at: new Date().toISOString(),
            steps_simulated: 0,
            source_event_refs: [],
          },
        };
      }

      const context = this.stateTracker.getSimulation(input.simulation_id);
      if (!context) {
        return {
          status: "invalid_state",
          tainted,
          provenance: {
            scope: input.scope,
            created_at: new Date().toISOString(),
            steps_simulated: 0,
            source_event_refs: [],
          },
        };
      }

      return {
        status: "simulation_completed",
        tainted: context.tainted,
        provenance: {
          simulation_id: context.simulation_id,
          scope: context.scope,
          created_at: context.created_at,
          steps_simulated: context.steps_simulated,
          source_event_refs: [],
        },
        simulation_report: {
          trajectories: [],
          recommendation: "Summary report of inactive simulation context.",
        },
      };
    }

    return {
      status: "invalid_state",
      tainted,
      provenance: {
        scope: input.scope,
        created_at: new Date().toISOString(),
        steps_simulated: 0,
        source_event_refs: [],
      },
    };
  }
}
