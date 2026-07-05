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
      throw new Error(`Session ${sessionId} not found`);
    }

    if (session.status !== "active") {
      return session;
    }

    session.round += 1;
    session.lastPeerProposal = proposal;

    // 1. Enforce strict round cap
    if (session.round > session.maxRounds) {
      session.status = "terminated_loop";
      session.traceEvents.push(`Terminated negotiation: exceeded maximum round cap of ${session.maxRounds}`);
      return session;
    }

    // 2. Reject proposals exceeding local risk limits
    if (proposal.riskScore > session.localRiskLimit) {
      session.status = "rejected_risk";
      session.traceEvents.push(`Rejected proposal: risk score ${proposal.riskScore} exceeds limit ${session.localRiskLimit}`);
      return session;
    }

    // 3. Reject proposals exceeding local budget limits
    if (proposal.demandedBudget > session.localBudgetLimit) {
      session.status = "rejected_budget";
      session.traceEvents.push(`Rejected proposal: demanded budget ${proposal.demandedBudget} exceeds limit ${session.localBudgetLimit}`);
      return session;
    }

    // 4. Check for repetitive counter-offer / escalatory cycles using a monotonic concession strategy.
    // If the peer is repeatedly demanding more budget or offering less utility compared to previous rounds,
    // or if we detect no progressive convergence, we terminate.
    if (session.round > 1 && session.lastPeerProposal) {
      const prevProposal = session.lastPeerProposal;
      // In a monotonic concession strategy, peer should either decrease demanded budget or increase utility.
      // If they escalate (demand more budget or offer less utility), we break the cycle gracefully.
      if (proposal.demandedBudget > prevProposal.demandedBudget || proposal.utilityOffer < prevProposal.utilityOffer) {
        session.status = "terminated_loop";
        session.traceEvents.push(`Terminated negotiation: detected escalatory behavior or lack of progressive concession.`);
        return session;
      }
    }

    // If proposal is within acceptable boundaries and meets our basic criteria, we accept
    if (proposal.utilityOffer >= 0.5) {
      session.status = "accepted";
      session.traceEvents.push(`Proposal accepted on round ${session.round} with utility offer ${proposal.utilityOffer}`);
      
      // Register negotiated task as a distinct record in task_lifecycle_manager
      const taskRecord: Partial<TaskRecord> = {
        id: proposal.taskId,
        parentTaskId: undefined,
        status: "pending",
        priority: 1,
        metadata: {
          peerId: proposal.peerId,
          sessionId: session.sessionId,
          negotiatedBudget: proposal.demandedBudget,
          negotiatedRisk: proposal.riskScore,
          isNegotiated: true
        }
      };
      taskLifecycleManager.register(taskRecord as any);
    } else {
      // Propose a counter-offer conforming to monotonic concession (we offer a slightly higher budget up to limit, or ask for acceptable utility)
      const counterOfferUtility = Math.min(0.9, (session.lastLocalCounterOffer || 0.4) + 0.1);
      session.lastLocalCounterOffer = counterOfferUtility;
      session.traceEvents.push(`Counter-offered demanding utility of ${counterOfferUtility} on round ${session.round}`);
    }

    return session;
  }

  /**
   * Handles peer failure to deliver on signed agreements. Must fail closed, log a trace event, and update task lifecycle.
   */
  public handleDeliveryFailure(sessionId: string, errorDetails: string): NegotiationSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.status = "failed_delivery";
    const eventMessage = `Delivery failure on negotiated agreement for task ${session.taskId}: ${errorDetails}. Failing closed.`;
    session.traceEvents.push(eventMessage);

    // Update existing task record to failed status in task_lifecycle_manager
    try {
      const task = taskLifecycleManager.getTask(session.taskId);
      if (task) {
        taskLifecycleManager.updateTaskStatus(session.taskId, "failed");
      }
    } catch (e) {
      // Task record may not have been registered yet or is missing
    }

    return session;
  }

  public getSession(sessionId: string): NegotiationSession | undefined {
    return this.sessions.get(sessionId);
  }
}

export const negotiatedCollaborationBehavior = new NegotiatedCollaborationBehavior();
