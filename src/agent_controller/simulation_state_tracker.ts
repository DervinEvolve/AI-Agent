import { secretRedactor } from "../capabilities/secret_redactor";

export interface StateSnapshot {
  environment_type: "code_environment" | "api_state" | "gui_desktop" | "file_system";
  state_variables: Record<string, any>;
  constraints_snapshot: string[];
  active_policy_rules: string[];
}

export interface SimulationContext {
  simulation_id: string;
  scope: {
    user_id: string;
    project_id: string;
    namespace: string;
  };
  created_at: string;
  state: "pending" | "running" | "completed" | "failed";
  initial_state: StateSnapshot;
  current_state: StateSnapshot;
  steps_simulated: number;
  tainted: boolean;
  trajectories: any[];
}

export class SimulationStateTracker {
  private contexts: Map<string, SimulationContext> = new Map();

  public createSimulation(
    scope: { user_id: string; project_id: string; namespace: string },
    initialState: StateSnapshot,
    isTainted: boolean
  ): SimulationContext {
    const simulation_id = `sim_${Math.random().toString(36).substring(2, 15)}`;
    
    // Apply secret redactor to state variables
    const redactedStateVariables = this.redactObject(initialState.state_variables);
    const cleanInitialState: StateSnapshot = {
      ...initialState,
      state_variables: redactedStateVariables,
    };

    const context: SimulationContext = {
      simulation_id,
      scope,
      created_at: new Date().toISOString(),
      state: "pending",
      initial_state: cleanInitialState,
      current_state: JSON.parse(JSON.stringify(cleanInitialState)),
      steps_simulated: 0,
      tainted: isTainted,
      trajectories: [],
    };

    this.contexts.set(simulation_id, context);
    return context;
  }

  public getSimulation(simulation_id: string): SimulationContext | undefined {
    return this.contexts.get(simulation_id);
  }

  public updateSimulationState(
    simulation_id: string,
    nextStateVariables: Record<string, any>,
    isTainted: boolean
  ): SimulationContext {
    const context = this.contexts.get(simulation_id);
    if (!context) {
      throw new Error(`Simulation with ID ${simulation_id} not found.`);
    }

    const redactedVariables = this.redactObject(nextStateVariables);
    context.current_state.state_variables = redactedVariables;
    context.steps_simulated += 1;
    if (isTainted) {
      context.tainted = true;
    }

    return context;
  }

  public redactObject(obj: any): any {
    if (typeof obj === "string") {
      return secretRedactor.redact(obj);
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this.redactObject(item));
    }
    if (obj !== null && typeof obj === "object") {
      const redacted: Record<string, any> = {};
      for (const key of Object.keys(obj)) {
        redacted[key] = this.redactObject(obj[key]);
      }
      return redacted;
    }
    return obj;
  }
}
