import { describe, it, expect } from "vitest";
import { WorldModelSimulator } from "../cap_internal_world_model_simulation_31";
import { StateSnapshot } from "../../agent_controller/simulation_state_tracker";

describe("WorldModelSimulator capability tests", () => {
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
    expect(stepRes.simulation_report?.trajectories[0].sequence[0].predicted_state.file_count).toBe(3);
    expect(stepRes.simulation_report?.trajectories[0].sequence[0].predicted_state.last_written_file).toBe("/tmp/test.ts");
  });

  it("simulator rejects any execution that attempts to call external APIs or perform web searches, returning policy_blocked", async () => {
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
          action_type: "execute_code",
          arguments: { code: "fetch('https://google.com')" },
        },
      ],
    });

    expect(stepRes.status).toBe("policy_blocked");
    expect(stepRes.simulation_report?.trajectories[0].sequence[0].blocked).toBe(true);
    expect(stepRes.simulation_report?.trajectories[0].sequence[0].safety_violations[0]).toContain("network egress");
  });

  it("any tainted input parameter or initial state variable propagates taint monotonically to the resulting simulation", async () => {
    const simulator = new WorldModelSimulator();
    const initRes = await simulator.execute({
      scope: dummyScope,
      action: "initialize_simulation",
      initial_state_snapshot: {
        ...dummyState,
        state_variables: {
          ...dummyState.state_variables,
          untrusted_input: "__tainted__input_data",
        },
      },
    });

    expect(initRes.tainted).toBe(true);

    const simId = initRes.provenance.simulation_id;
    const stepRes = await simulator.execute({
      scope: dummyScope,
      action: "simulate_step",
      simulation_id: simId,
      proposed_actions: [
        {
          action_type: "write_file",
          arguments: { filepath: "/tmp/clean.ts" },
        },
      ],
    });

    expect(stepRes.tainted).toBe(true);
  });

  it("evaluate_counterfactual simulates alternative environmental branches and evaluates plan robustness", async () => {
    const simulator = new WorldModelSimulator();
    const initRes = await simulator.execute({
      scope: dummyScope,
      action: "initialize_simulation",
      initial_state_snapshot: dummyState,
    });

    const simId = initRes.provenance.simulation_id;
    const counterfactualRes = await simulator.execute({
      scope: dummyScope,
      action: "evaluate_counterfactual",
      simulation_id: simId,
      counterfactual_hypothesis: "What if the API returns a 429 rate limit?",
      proposed_actions: [
        {
          action_type: "query_db",
          arguments: { query: "SELECT * FROM users;" },
        },
      ],
    });

    expect(counterfactualRes.status).toBe("simulation_completed");
    expect(counterfactualRes.simulation_report?.trajectories[0].primary_failure_mode).toBe("RateLimitExceeded");
    expect(counterfactualRes.simulation_report?.trajectories[0].aggregate_success_probability).toBeLessThan(0.5);
  });

  it("ensures raw secrets are redacted from simulation states", async () => {
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
          arguments: { filepath: "/tmp/secret.ts" },
        },
      ],
    });

    const sequence = stepRes.simulation_report?.trajectories[0].sequence || [];
    const nextState = sequence[0]?.predicted_state;
    expect(nextState.api_key).not.toContain("sk-live-555");
    expect(nextState.api_key).toContain("[REDACTED");
  });
});
