import { describe, it, expect } from 'vitest';
import { evaluateSimulationBoundary, SimulationState } from '../constraints';

describe('con_world_model_simulation_non_authority_31', () => {
  it('a simulation trajectory showing 100% success cannot authorize a live browser or API dispatch without a fresh verified HITL approval_token', () => {
    const state: SimulationState = {
      is_simulation: true,
      simulation_success_score: 1.0,
      approval_token: 'SIMULATED_TOKEN_123',
    };

    const result = evaluateSimulationBoundary(state, {
      tainted: false,
      data: 'Simulated 100% successful run',
    });

    // Even with 100% success, approval token validation must remain false for simulated trajectories
    expect(result.approval_token_validated).toBe(false);
    expect(result.status).toBe('allowed');
  });

  it('the simulator returns policy_blocked and halts the simulation if a simulated code block attempts to access live networks or external APIs', () => {
    const stateWithNetwork: SimulationState = {
      is_simulation: true,
      has_network_access: true,
    };

    const resultNetwork = evaluateSimulationBoundary(stateWithNetwork, {
      tainted: false,
      data: 'Simulated network fetch',
    });
    expect(resultNetwork.status).toBe('policy_blocked');
    expect(resultNetwork.reason).toContain('live network or external API access');

    const stateWithAPI: SimulationState = {
      is_simulation: true,
      has_external_api_access: true,
    };

    const resultAPI = evaluateSimulationBoundary(stateWithAPI, {
      tainted: false,
      data: 'Simulated external API dispatch',
    });
    expect(resultAPI.status).toBe('policy_blocked');
    expect(resultAPI.reason).toContain('live network or external API access');
  });

  it('simulated state transitions cannot clear taint flags or convert tainted variables into trusted tool arguments', () => {
    // Input tainted state must permanently taint output state
    const state: SimulationState = {
      is_simulation: true,
      tainted: true,
    };

    const result = evaluateSimulationBoundary(state, {
      tainted: false,
      data: 'Attempting to clean taint via simulation step',
    });

    expect(result.tainted).toBe(true);

    // Tainted input to untainted state must also result in tainted output
    const cleanState: SimulationState = {
      is_simulation: true,
      tainted: false,
    };

    const result2 = evaluateSimulationBoundary(cleanState, {
      tainted: true,
      data: 'Tainted input payload',
    });

    expect(result2.tainted).toBe(true);
  });

  it('simulation records and history redact apparent secrets before storage and never contain live credentials or vault session handles', () => {
    const state: SimulationState = {
      is_simulation: true,
      history: [],
    };

    const secretToken = 'super-secret-vault-token-xyz123';
    const result = evaluateSimulationBoundary(state, {
      tainted: false,
      data: `Connecting to vault with token: ${secretToken}`,
      secretsToRedact: [secretToken],
    });

    expect(result.history[0]).not.toContain(secretToken);
    expect(result.history[0]).toContain('[REDACTED_SIM_SECRET]');
  });
});
