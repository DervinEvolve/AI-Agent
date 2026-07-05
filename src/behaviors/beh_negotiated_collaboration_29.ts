import { taskLifecycleManager, TaskRecord } from "../capabilities/cap_task_lifecycle_manager_26";

export interface PeerProposal {
  peerId: string;
  taskId: string;
  requiredCapabilities: string[];
  demandedBudget: number; // e.g., token/compute budget demanded
  riskScore: number; // 0.0 to 1.0 risk profile
  utilityOffer: number; // utility offered to us
}

export interface NegotiationSession {
  sessionId: string;
  peerId: string;
  taskId: string;
  round: number;
  maxRounds: number;
  localBudgetLimit: number;
  localRiskLimit: number;
  lastPeerProposal?: PeerProposal;
  lastLocalCounterOffer?: number; // local demanded utility or offered budget
  status: "active" | "accepted" | "rejected_budget" | "rejected_risk" | "terminated_loop" | "failed_delivery";
  traceEvents: string[];
}

export class NegotiatedCollaborationBehavior {
  private sessions: Map<string, NegotiationSession> = new Map();

  constructor() {}

  /**
   * Initiates a negotiation session with a specialized peer when a task requires capabilities outside its primary domain.
   */
  public initiateNegotiation(
    peerId: string,
    taskId: string,
    requiredCapabilities: string[],
    localBudgetLimit: number,
    localRiskLimit: number,
    maxRounds = 5
  ): NegotiationSession {
    const sessionId = `neg_session_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const session: NegotiationSession = {
      sessionId,
      peerId,
      taskId,
      round: 0,
      maxRounds,
      localBudgetLimit,
      localRiskLimit,
      status: "active",
      traceEvents: [`Initiated negotiation with peer ${peerId} for task ${taskId}`]
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Evaluates a peer proposal, applying defensive checks for budgets, risk profiles,
   * and enforcing a strict round cap & monotonic concession strategy to prevent infinite counter-offer loops.
   */
  public evaluateProposal(sessionId: string, proposal: PeerProposal): NegotiationSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session with ID ${sessionId} not found`);
    }

    if (session.status !== "active") {
      return session;
    }

    session.round += 1;
    session.lastPeerProposal = proposal;

    // 1. Budget violation check
    if (proposal.demandedBudget > session.localBudgetLimit) {
      session.status = "rejected_budget";
      session.traceEvents.push(`Proposal rejected: demanded budget ${proposal.demandedBudget} exceeds limit of ${session.localBudgetLimit}`);
      return session;
    }

    // 2. Risk violation check
    if (proposal.riskScore > session.localRiskLimit) {
      session.status = "rejected_risk";
      session.traceEvents.push(`Proposal rejected: risk score ${proposal.riskScore} exceeds limit of ${session.localRiskLimit}`);
      return session;
    }

    // 3. Round limit / Loop detection check
    if (session.round >= session.maxRounds) {
      session.status = "terminated_loop";
      session.traceEvents.push(`Negotiation terminated: exceeded round cap of ${session.maxRounds}`);
      return session;
    }

    // 4. Monotonic concession strategy & validation logic
    // If utility is high enough, we accept. Otherwise, we simulate a counter-offer
    if (proposal.utilityOffer >= 0.7) {
      session.status = "accepted";
      session.traceEvents.push(`Proposal accepted with utility offer ${proposal.utilityOffer}`);

      // Register the negotiated task in the lifecycle manager
      const taskRecord: Partial<TaskRecord> = {
        id: proposal.taskId,
        name: `Negotiated Task - ${proposal.taskId}`,
        status: "pending",
        priority: "high",
        metadata: {
          peerId: proposal.peerId,
          negotiatedBudget: proposal.demandedBudget,
          negotiatedRisk: proposal.riskScore
        }
      };
      taskLifecycleManager.registerTask(taskRecord as any);
      session.traceEvents.push(`Registered task ${proposal.taskId} in taskLifecycleManager`);
    } else {
      // Check for repetitive counter-offer loop (e.g. if peer offers same utility twice)
      if (session.lastLocalCounterOffer !== undefined && proposal.utilityOffer <= (session.lastLocalCounterOffer || 0)) {
        session.status = "terminated_loop";
        session.traceEvents.push("Terminated loop: peer failed to offer concession");
      } else {
        session.lastLocalCounterOffer = proposal.utilityOffer;
        session.traceEvents.push(`Counter-offered utility requirement based on offer ${proposal.utilityOffer}`);
      }
    }

    return session;
  }

  /**
   * Handle peer delivery failure: fail closed and log a trace event.
   */
  public handleDeliveryFailure(sessionId: string): NegotiationSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session with ID ${sessionId} not found`);
    }
    session.status = "failed_delivery";
    session.traceEvents.push("Fail closed: peer failed to deliver on signed agreement");
    return session;
  }
}

export const negotiatedCollaborationBehavior = new NegotiatedCollaborationBehavior();
