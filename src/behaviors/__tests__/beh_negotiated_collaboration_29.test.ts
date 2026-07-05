import { describe, it, expect, beforeEach } from "vitest";
import { negotiatedCollaborationBehavior, PeerProposal } from "../beh_negotiated_collaboration_29";
import { taskLifecycleManager } from "../../capabilities/cap_task_lifecycle_manager_26";

describe("beh_negotiated_collaboration_29 - Negotiated Collaboration Behavior", () => {
  beforeEach(() => {
    // Clean up task lifecycle manager registry before each test
    (taskLifecycleManager as any).tasks = new Map();
  });

  it("agent initiates negotiation with a specialized peer when a task requires capabilities outside its primary domain", () => {
    const session = negotiatedCollaborationBehavior.initiateNegotiation(
      "peer-ml-specialist",
      "task-deep-learning-inference",
      ["cuda-execution", "large-language-model-finetuning"],
      1000, // budget limit
      0.3   // risk limit
    );

    expect(session).toBeDefined();
    expect(session.status).toBe("active");
    expect(session.peerId).toBe("peer-ml-specialist");
    expect(session.taskId).toBe("task-deep-learning-inference");
    expect(session.traceEvents[0]).toContain("Initiated negotiation");
  });

  it("agent rejects peer proposals that demand more budget than allocated or violate local risk profiles", () => {
    const session = negotiatedCollaborationBehavior.initiateNegotiation(
      "peer-web-scraper",
      "task-scrape-heavy",
      ["scraping"],
      500,
      0.4
    );

    // Proposal violating budget limit
    const highBudgetProposal: PeerProposal = {
      peerId: "peer-web-scraper",
      taskId: "task-scrape-heavy",
      requiredCapabilities: ["scraping"],
      demandedBudget: 600, // > 500
      riskScore: 0.2,
      utilityOffer: 0.8
    };

    const updatedSession1 = negotiatedCollaborationBehavior.evaluateProposal(session.sessionId, highBudgetProposal);
    expect(updatedSession1.status).toBe("rejected_budget");
    expect(updatedSession1.traceEvents[1]).toContain("exceeds limit");

    // Proposal violating risk profile
    const session2 = negotiatedCollaborationBehavior.initiateNegotiation(
      "peer-web-scraper-2",
      "task-scrape-heavy-2",
      ["scraping"],
      500,
      0.4
    );
    const highRiskProposal: PeerProposal = {
      peerId: "peer-web-scraper-2",
      taskId: "task-scrape-heavy-2",
      requiredCapabilities: ["scraping"],
      demandedBudget: 300,
      riskScore: 0.6, // > 0.4
      utilityOffer: 0.8
    };

    const updatedSession2 = negotiatedCollaborationBehavior.evaluateProposal(session2.sessionId, highRiskProposal);
    expect(updatedSession2.status).toBe("rejected_risk");
  });

  it("agent detects and breaks out of repetitive counter-offer cycles, terminating the session gracefully", () => {
    const session = negotiatedCollaborationBehavior.initiateNegotiation(
      "peer-negotiator",
      "task-complex-trade",
      ["trading"],
      1000,
      0.5,
      3 // max 3 rounds
    );

    const proposal1: PeerProposal = {
      peerId: "peer-negotiator",
      taskId: "task-complex-trade",
      requiredCapabilities: ["trading"],
      demandedBudget: 400,
      riskScore: 0.2,
      utilityOffer: 0.3 // too low, triggers counter-offer
    };

    // Round 1
    let currentSession = negotiatedCollaborationBehavior.evaluateProposal(session.sessionId, proposal1);
    expect(currentSession.status).toBe("active");
    expect(currentSession.round).toBe(1);

    // Round 2
    currentSession = negotiatedCollaborationBehavior.evaluateProposal(session.sessionId, proposal1);
    expect(currentSession.status).toBe("active");
    expect(currentSession.round).toBe(2);

    // Round 3
    currentSession = negotiatedCollaborationBehavior.evaluateProposal(session.sessionId, proposal1);
    expect(currentSession.status).toBe("active");
    expect(currentSession.round).toBe(3);

    // Round 4 (exceeds maxRounds = 3)
    currentSession = negotiatedCollaborationBehavior.evaluateProposal(session.sessionId, proposal1);
    expect(currentSession.status).toBe("terminated_loop");
    expect(currentSession.traceEvents[currentSession.traceEvents.length - 1]).toContain("exceeded maximum round cap");
  });

  it("negotiated tasks are registered as distinct records in the task_lifecycle_manager with appropriate priority and dependency edges", () => {
    const session = negotiatedCollaborationBehavior.initiateNegotiation(
      "peer-agent-3",
      "task-negotiated-ok",
      ["compute"],
      800,
      0.5
    );

    const validProposal: PeerProposal = {
      peerId: "peer-agent-3",
      taskId: "task-negotiated-ok",
      requiredCapabilities: ["compute"],
      demandedBudget: 400,
      riskScore: 0.2,
      utilityOffer: 0.7 // acceptable >= 0.5
    };

    const updatedSession = negotiatedCollaborationBehavior.evaluateProposal(session.sessionId, validProposal);
    expect(updatedSession.status).toBe("accepted");

    const registeredTask = taskLifecycleManager.getTask("task-negotiated-ok");
    expect(registeredTask).toBeDefined();
    expect(registeredTask?.metadata?.isNegotiated).toBe(true);
    expect(registeredTask?.metadata?.peerId).toBe("peer-agent-3");
  });

  it("agent fails closed and logs a trace event if a peer fails to deliver on a signed agreement", () => {
    const session = negotiatedCollaborationBehavior.initiateNegotiation(
      "peer-agent-4",
      "task-to-fail",
      ["compute"],
      800,
      0.5
    );

    // Simulate accepting the proposal first so that it is registered in the task manager
    const validProposal: PeerProposal = {
      peerId: "peer-agent-4",
      taskId: "task-to-fail",
      requiredCapabilities: ["compute"],
      demandedBudget: 400,
      riskScore: 0.2,
      utilityOffer: 0.8
    };
    negotiatedCollaborationBehavior.evaluateProposal(session.sessionId, validProposal);

    // Ensure the task is active/pending
    let task = taskLifecycleManager.getTask("task-to-fail");
    expect(task).toBeDefined();
    expect(task?.status).toBe("pending");

    // Handle physical delivery failure
    const finalSession = negotiatedCollaborationBehavior.handleDeliveryFailure(session.sessionId, "Network timeout on execution container");
    expect(finalSession.status).toBe("failed_delivery");
    expect(finalSession.traceEvents[finalSession.traceEvents.length - 1]).toContain("Failing closed");

    // Verify the task status has been failed closed in task_lifecycle_manager
    task = taskLifecycleManager.getTask("task-to-fail");
    expect(task?.status).toBe("failed");
  });
});
