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
      1000,
      0.3
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
    expect(updatedSession1.traceEvents.find(e => e.includes("exceeds limit"))).toBeDefined();

    // Proposal violating risk profile
    const session2 = negotiatedCollaborationBehavior.initiateNegotiation(
      "peer-web-scraper",
      "task-scrape-heavy-2",
      ["scraping"],
      500,
      0.4
    );

    const highRiskProposal: PeerProposal = {
      peerId: "peer-web-scraper",
      taskId: "task-scrape-heavy-2",
      requiredCapabilities: ["scraping"],
      demandedBudget: 300,
      riskScore: 0.8, // > 0.4
      utilityOffer: 0.8
    };

    const updatedSession2 = negotiatedCollaborationBehavior.evaluateProposal(session2.sessionId, highRiskProposal);
    expect(updatedSession2.status).toBe("rejected_risk");
  });

  it("agent detects and breaks out of repetitive counter-offer cycles, terminating the session gracefully", () => {
    const session = negotiatedCollaborationBehavior.initiateNegotiation(
      "peer-negotiator",
      "task-negotiate",
      ["negotiation"],
      1000,
      0.5,
      5
    );

    // First proposal: low utility, starts counter-offer
    const p1: PeerProposal = {
      peerId: "peer-negotiator",
      taskId: "task-negotiate",
      requiredCapabilities: ["negotiation"],
      demandedBudget: 500,
      riskScore: 0.3,
      utilityOffer: 0.4
    };
    let s = negotiatedCollaborationBehavior.evaluateProposal(session.sessionId, p1);
    expect(s.status).toBe("active");
    expect(s.lastLocalCounterOffer).toBe(0.4);

    // Second proposal: no concession (utility is same or lower)
    const p2: PeerProposal = {
      peerId: "peer-negotiator",
      taskId: "task-negotiate",
      requiredCapabilities: ["negotiation"],
      demandedBudget: 500,
      riskScore: 0.3,
      utilityOffer: 0.4
    };
    s = negotiatedCollaborationBehavior.evaluateProposal(session.sessionId, p2);
    expect(s.status).toBe("terminated_loop");
    expect(s.traceEvents.find(e => e.includes("failed to offer concession"))).toBeDefined();
  });

  it("negotiated tasks are registered as distinct records in the task_lifecycle_manager with appropriate priority and dependency edges", () => {
    const session = negotiatedCollaborationBehavior.initiateNegotiation(
      "peer-helper",
      "task-to-register",
      ["execution"],
      1000,
      0.8
    );

    const proposal: PeerProposal = {
      peerId: "peer-helper",
      taskId: "task-to-register",
      requiredCapabilities: ["execution"],
      demandedBudget: 400,
      riskScore: 0.2,
      utilityOffer: 0.9 // High utility to trigger acceptance
    };

    const updatedSession = negotiatedCollaborationBehavior.evaluateProposal(session.sessionId, proposal);
    expect(updatedSession.status).toBe("accepted");

    const registeredTask = taskLifecycleManager.getTask("task-to-register");
    expect(registeredTask).toBeDefined();
    expect(registeredTask?.id).toBe("task-to-register");
    expect(registeredTask?.priority).toBe("high");
  });

  it("agent fails closed and logs a trace event if a peer fails to deliver on a signed agreement", () => {
    const session = negotiatedCollaborationBehavior.initiateNegotiation(
      "peer-flaky",
      "task-flaky-delivery",
      ["execution"],
      1000,
      0.8
    );

    const updated = negotiatedCollaborationBehavior.handleDeliveryFailure(session.sessionId);
    expect(updated.status).toBe("failed_delivery");
    expect(updated.traceEvents.find(e => e.includes("Fail closed"))).toBeDefined();
  });
});
