export interface Source {
  ref: string;
  reliability?: number; // 0-1
  timestamp?: number; // epoch ms
}

export interface Claim {
  id: string;
  content: string;
  confidence: number;
  sources: Source[];
  timestamp: number;
  tainted: boolean;
  state: 'pending' | 'verified' | 'refuted' | 'suspect';
  refutes?: string[];
  dependentClaims?: string[];
  subjectTags?: string[];
}

export class SimpleClaimLedger {
  private claims: Map<string, Claim> = new Map();

  register(claim: Claim): void {
    if (this.claims.has(claim.id)) {
      throw new Error(`Claim with id ${claim.id} already exists`);
    }
    this.claims.set(claim.id, claim);
  }

  get(id: string): Claim | undefined {
    return this.claims.get(id);
  }

  query(options?: { subject?: string; state?: string }): Claim[] {
    const results: Claim[] = [];
    for (const claim of this.claims.values()) {
      if (options?.subject && claim.subjectTags && !claim.subjectTags.includes(options.subject)) {
        continue;
      }
      if (options?.state && claim.state !== options.state) {
        continue;
      }
      results.push(claim);
    }
    return results;
  }

  getAll(): Claim[] {
    return Array.from(this.claims.values());
  }

  updateClaim(id: string, updates: Partial<Pick<Claim, 'state' | 'confidence' | 'tainted'>>): Claim | undefined {
    const claim = this.claims.get(id);
    if (!claim) return undefined;
    Object.assign(claim, updates);
    return claim;
  }

  clear() {
    this.claims.clear();
  }
}

export interface TraceEvent {
  type: string;
  timestamp: number;
  data: any;
}

export class TraceStore {
  static events: TraceEvent[] = [];

  static record(event: TraceEvent) {
    TraceStore.events.push(event);
  }

  static clear() {
    TraceStore.events = [];
  }

  static getEvents(): TraceEvent[] {
    return [...TraceStore.events];
  }
}

let claimCounter = 0;
function makeId(): string {
  return `claim_${Date.now()}_${++claimCounter}`;
}

export function synthesizeClaim(
  ledger: SimpleClaimLedger,
  conclusion: string,
  sources: Source[],
  confidence: number,
  options?: {
    tainted?: boolean;
    subjectTags?: string[];
    refutes?: string[];
  }
): Claim {
  const id = makeId();
  const claim: Claim = {
    id,
    content: conclusion,
    confidence,
    sources,
    timestamp: Date.now(),
    tainted: options?.tainted ?? false,
    state: 'pending',
    subjectTags: options?.subjectTags ?? [],
    refutes: options?.refutes ?? [],
    dependentClaims: [],
  };
  ledger.register(claim);
  TraceStore.record({
    type: 'claim_registered',
    timestamp: Date.now(),
    data: { claimId: id, confidence, subjectTags: claim.subjectTags },
  });
  return claim;
}

export interface VerificationResult {
  safe: boolean;
  issues: string[];
  lowConfidenceClaims: Claim[];
  contradictedClaims: Claim[];
  taintedClaims: Claim[];
}

export function verifyClaimsForDecision(
  ledger: SimpleClaimLedger,
  options: {
    subjectTags?: string[];
    minConfidence?: number;
    maxAgeMs?: number;
    decisionContext?: string;
  }
): VerificationResult {
  const claims = ledger.query({ subject: options.subjectTags?.[0] });
  const result: VerificationResult = {
    safe: true,
    issues: [],
    lowConfidenceClaims: [],
    contradictedClaims: [],
    taintedClaims: [],
  };

  const now = Date.now();

  for (const claim of claims) {
    if (options.minConfidence !== undefined && claim.confidence < options.minConfidence) {
      result.lowConfidenceClaims.push(claim);
      result.issues.push(`Claim ${claim.id} has low confidence ${claim.confidence}`);
      result.safe = false;
    }

    if (options.maxAgeMs !== undefined && (now - claim.timestamp) > options.maxAgeMs) {
      result.issues.push(`Claim ${claim.id} is stale (age ${now - claim.timestamp}ms)`);
      result.safe = false;
    }

    if (claim.tainted) {
      result.taintedClaims.push(claim);
      result.issues.push(`Claim ${claim.id} is tainted`);
      result.safe = false;
    }

    if (claim.refutes && claim.refutes.length > 0) {
      for (const refutedId of claim.refutes) {
        const refutedClaim = ledger.get(refutedId);
        if (refutedClaim && refutedClaim.state !== 'refuted') {
          ledger.updateClaim(refutedId, { state: 'suspect' });
          result.contradictedClaims.push(refutedClaim);
          result.issues.push(`Claim ${claim.id} refutes claim ${refutedId}`);
          result.safe = false;
          TraceStore.record({
            type: 'contradiction_detected',
            timestamp: Date.now(),
            data: { claimA: claim.id, claimB: refutedId },
          });
        }
      }
    }
  }

  const suspectClaims = ledger.query({ state: 'suspect' });
  for (const suspect of suspectClaims) {
    if (!result.contradictedClaims.includes(suspect)) {
      result.contradictedClaims.push(suspect);
      result.issues.push(`Claim ${suspect.id} is marked suspect`);
      result.safe = false;
    }
  }

  if (claims.length === 0 && result.issues.length === 0) {
    result.safe = true;
  }

  return result;
}

export function markClaimTainted(ledger: SimpleClaimLedger, claimId: string): boolean {
  const claim = ledger.updateClaim(claimId, { tainted: true });
  if (claim) {
    TraceStore.record({
      type: 'claim_tainted',
      timestamp: Date.now(),
      data: { claimId },
    });
    return true;
  }
  return false;
}

export function detectContradictions(ledger: SimpleClaimLedger): void {
  const claims = ledger.getAll();
  for (const claim of claims) {
    if (claim.refutes) {
      for (const targetId of claim.refutes) {
        const target = ledger.get(targetId);
        if (target) {
          if (target.state !== 'refuted') {
            ledger.updateClaim(targetId, { state: 'suspect' });
          }
          TraceStore.record({
            type: 'contradiction_detected',
            timestamp: Date.now(),
            data: { claimA: claim.id, claimB: targetId },
          });
        }
      }
    }
  }
  const refutedIds = new Set(claims.filter(c => c.state === 'refuted').map(c => c.id));
  for (const claim of claims) {
    if (claim.dependentClaims) {
      for (const depId of claim.dependentClaims) {
        if (refutedIds.has(claim.id)) {
          ledger.updateClaim(depId, { state: 'suspect', tainted: true });
          TraceStore.record({
            type: 'taint_propagation',
            timestamp: Date.now(),
            data: { becauseClaim: claim.id, dependent: depId },
          });
        }
      }
    }
  }
}

export interface CriterionEvaluation {
  satisfied: boolean;
  confidence: number;
  supportingClaimIds: string[];
  traceData: any;
}

export function evaluateCriterion(
  ledger: SimpleClaimLedger,
  criterion: { subjectTag: string; minConfidence?: number; requiredClaims?: number }
): CriterionEvaluation {
  const claims = ledger.query({ subject: criterion.subjectTag });
  const relevant = claims.filter(c => !c.tainted && c.state !== 'refuted' && c.state !== 'suspect');
  if (relevant.length === 0) {
    return {
      satisfied: false,
      confidence: 0,
      supportingClaimIds: [],
      traceData: {},
    };
  }
  const avgConf = relevant.reduce((sum, c) => sum + c.confidence, 0) / relevant.length;
  const minConf = criterion.minConfidence ?? 0.7;
  const satisfied = avgConf >= minConf && relevant.length >= (criterion.requiredClaims ?? 1);
  const ids = relevant.map(c => c.id);
  const traceData = { evaluatedCriterion: criterion.subjectTag, avgConfidence: avgConf, claimIds: ids, satisfied };
  TraceStore.record({
    type: 'criterion_evaluated',
    timestamp: Date.now(),
    data: traceData,
  });
  return {
    satisfied,
    confidence: avgConf,
    supportingClaimIds: ids,
    traceData,
  };
}

export const beh_evidence_grounded_claims_19 = {
  id: 'beh_evidence_grounded_claims_19',
  name: 'Evidence-grounded claim synthesis and verification',
  status: 'active',
  added_epoch: 19,
  description:
    'When the agent synthesizes information from multiple sources to form a conclusion, plan a step, or answer a user, it should register explicit claims in the claim ledger with source references, confidence, and freshness. Before relying on a claim for a consequential decision, it should verify that the claim is not contradicted by other evidence, is supported by recent and reliable sources, and is not tainted beyond validation. Claims should be cross-checked against the task’s success criteria and trace evidence, and any unresolved contradictions or low-confidence claims should be flagged to the user rather than silently used.',
};
