import { describe, it, expect } from "vitest";
import { WorldModelSimulator } from "../cap_internal_world_model_simulation_31";
import { StateSnapshot } from "../../agent_controller/simulation_state_tracker";

describe("WorldModelSimulator integration and edge cases", () => {
  const dummyScope = {
    user_id: "usr_123",
    project_id: "prj_456",
    namespace: "ns_test",
  };

  const dummyState: StateSnapshot = {
    environment_type: "code_environment",
    state_variables: {
      file_count: 2,
      api_key: "sk-live-555-super-secret-token",
    },
    constraints_snapshot: ["read_only_mode"],
    active_policy_rules: ["no_delete_operations"],
  };

  it("initialize_simulation sets up a durable simulation context with a unique ID and initial state snapshot in state pending", async () => {
    const simulator = new WorldModelSimulator();
    const res = await simulator.execute({
      scope: dummyScope,
      action: "initialize_simulation",
      initial_state_snapshot: dummyState,
    });

    expect(res.status).toBe("ok");
    expect(res.provenance.simulation_id).toBeDefined();
    expect(res.provenance.simulation_id?.startsWith("sim_")).toBe(true);
    expect(res.tainted).toBe(false);
  });

  it("simulate_step models the environment's response to an action sequence and returns predicted next states", async () => {
    const simulator = new WorldModelSimulator();
    const initRes = await simulator.execute({
      scope: dummyScope,
      action: "initialize_simulation",
      initial_state_snapshot: dummyState,
    });

    const simId = initRes.provenance.simulation_id;
    const stepRes = await simulator.execute({
      scope: dummyScope,
      action: "simulate_step",
      simulation_id: simId,
      proposed_actions: [
        {
          action_type: "write_file",
          arguments: { filepath: "/tmp/test.ts" },
        },
      ],
    });

    expect(stepRes.status).toBe("simulation_completed");
    expect(stepRes.simulation_report?.trajectories[0].sequence).toHaveLength(1);
  });

  it("propagates taint monotonically if any input is tainted", async () => {
    const simulator = new WorldModelSimulator();
    const taintedState: StateSnapshot = {
      ...dummyState,
      state_variables: {
        file_count: 2,
        tainted_input: "__tainted__input_value",
      },
    };

    const initRes = await simulator.execute({
      scope: dummyScope,
      action: "initialize_simulation",
      initial_state_snapshot: taintedState,
    });

    expect(initRes.tainted).toBe(true);
  });
});
