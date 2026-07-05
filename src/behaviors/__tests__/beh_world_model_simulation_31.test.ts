import { describe, it, expect } from 'vitest';
import { WorldModelSimulator } from '../../capabilities/cap_world_model_simulator_31';
import { WorldModelSimulationBehavior } from '../beh_world_model_simulation_31';

describe('beh_world_model_simulation_31', () => {
  it('agent invokes the simulator to evaluate a proposed multi-step plan before live execution', () => {
    const simulator = new WorldModelSimulator();
    const plan = [
      { id: '1', action: 'read_file', parameters: { path: 'src/config.json' } },
      { id: '2', action: 'database_migration', parameters: { target: 'v2' } }
    ];

    const result = simulator.simulate(plan);
    expect(result).toBeDefined();
    expect(result.predictedState.simulatedStepsCount).toBe(2);
    expect(result.counterfactuals.length).toBeGreaterThan(0);
  });

  it('agent detects simulated failure modes or safety violations and automatically revises its plan or counterfactual parameters', () => {
    const behavior = new WorldModelSimulationBehavior();
    const riskyPlan = [
      { id: '1', action: 'execute_untested_code', parameters: { code: 'console.log("hello")' } }
    ];

    const outcome = behavior.evaluatePlan(riskyPlan);
    expect(outcome.decision).toBe('REVISE');
    expect(outcome.revisedPlan).toBeDefined();
    expect(outcome.revisedPlan![0].action).toBe('execute_tested_code_sandbox');
  });

  it('if a simulation predicts a critical failure, the agent halts and deliberates or requests clarification rather than blindly executing', () => {
    const behavior = new WorldModelSimulationBehavior();
    const criticalPlan = [
      { id: '1', action: 'delete_files', parameters: { path: '/', force: 'rm -rf' } }
    ];

    const outcome = behavior.evaluatePlan(criticalPlan);
    expect(outcome.decision).toBe('HITL_GATE');
    expect(outcome.reason).toContain('Critical safety violation');
  });

  it('simulated plans and recommendations are treated as advisory heuristics and are still subject to full validation', () => {
    const behavior = new WorldModelSimulationBehavior();
    const standardPlan = [
      { id: '1', action: 'read_status', parameters: {} }
    ];
    const outcome = behavior.evaluatePlan(standardPlan);
    expect(outcome.decision).toBeDefined();
    expect(outcome.simulationResult).toBeDefined();
  });
});
