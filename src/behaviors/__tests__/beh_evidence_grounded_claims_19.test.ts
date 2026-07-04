import {
  SimpleClaimLedger,
  synthesizeClaim,
  verifyClaimsForDecision,
  markClaimTainted,
  detectContradictions,
  evaluateCriterion,
  TraceStore,
  Claim,
} from '../beh_evidence_grounded_claims_19';

describe('Evidence-grounded claim synthesis and verification', () => {
  let ledger: SimpleClaimLedger;

  beforeEach(() => {
    ledger = new SimpleClaimLedger();
    TraceStore.clear();
  });

  test('controller synthesis of multi-source information creates at least one claim with source refs', () => {
    const claim = synthesizeClaim(
      ledger,
      'The API returns status 200 for authenticated requests',
      [
        { ref: 'integration-test-run-42/output.log', reliability: 0.9 },
        { ref: 'doc/api-spec.md', reliability: 0.8 },
      ],
      0.85,
      { subjectTags: ['API', 'authentication'] }
    );

    expect(claim).toBeDefined();
    expect(claim.content).toBe('The API returns status 200 for authenticated requests');
    expect(claim.sources).toHaveLength(2);
    expect(claim.sources[0].ref).toContain('output.log');
    expect(claim.confidence).toBe(0.85);
    expect(claim.subjectTags).toContain('API');
    expect(claim.state).toBe('pending');

    const stored = ledger.get(claim.id);
    expect(stored).toEqual(claim);

    const traceEvents = TraceStore.getEvents();
    expect(traceEvents).toHaveLength(1);
    expect(traceEvents[0].type).toBe('claim_registered');
    expect(traceEvents[0].data.claimId).toBe(claim.id);
  });

  test('before a consequential decision, controller retrieves relevant claims and checks contradictions and confidence', () => {
    const claim1 = synthesizeClaim(
      ledger,
      'Service X has 99.9% uptime',
      [{ ref: 'monitoring-report', reliability: 0.95 }],
      0.95,
      { subjectTags: ['uptime'] }
    );

    // Contradictory claim that explicitly refutes claim1
    const contradictory = synthesizeClaim(
      ledger,
      'Service X is down frequently',
      [{ ref: 'incident-log', reliability: 0.7 }],
      0.7,
      { subjectTags: ['uptime'], refutes: [claim1.id] }
    );

    // Low-confidence claim
    const lowClaim = synthesizeClaim(
      ledger,
      'Service X has experienced outages recently',
      [{ ref: 'user-report', reliability: 0.4 }],
      0.5,
      { subjectTags: ['uptime'] }
    );

    const verification = verifyClaimsForDecision(ledger, { subject: 'uptime' });

    expect(verification.contradictions).toBeDefined();
    expect(verification.contradictions).toHaveLength(1);
    const pair = verification.contradictions[0];
    expect(pair).toEqual(expect.arrayContaining([claim1, contradictory]));

    expect(verification.lowConfidence).toEqual(expect.arrayContaining([lowClaim]));
    expect(verification.safeToProceed).toBe(false);
    expect(verification.clarificationNeeded).toBe(true);

    // Verify trace event for the decision check
    const decisionEvents = TraceStore.getEvents().filter(e => e.type === 'claim_verification');
    expect(decisionEvents.length).toBeGreaterThanOrEqual(1);
    expect(decisionEvents[0].data.subject).toBe('uptime');
  });

  test('detectContradictions identifies pairs of claims that refute each other', () => {
    const claimA: Claim = {
      id: 'cA',
      content: 'X is true',
      confidence: 0.9,
      sources: [],
      timestamp: Date.now(),
      tainted: false,
      state: 'pending',
      subjectTags: ['topic'],
    };

    const claimB: Claim = {
      id: 'cB',
      content: 'X is false',
      confidence: 0.8,
      sources: [],
      timestamp: Date.now(),
      tainted: false,
      state: 'pending',
      refutes: ['cA'],
      subjectTags: ['topic'],
    };

    const claimC: Claim = {
      id: 'cC',
      content: 'unrelated',
      confidence: 0.7,
      sources: [],
      timestamp: Date.now(),
      tainted: false,
      state: 'pending',
    };

    const contradictions = detectContradictions([claimA, claimB, claimC]);
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]).toEqual(expect.arrayContaining([claimA, claimB]));
  });

  test('claims derived from tainted observations are marked tainted and are not used as sole evidence for a success criterion', () => {
    const claim = synthesizeClaim(
      ledger,
      'API is functional',
      [{ ref: 'hearsay', reliability: 0.2 }],
      0.6,
      { subjectTags: ['api-health'] }
    );

    markClaimTainted(ledger, claim.id, 'unreliable source');
    const stored = ledger.get(claim.id);
    expect(stored).toBeDefined();
    expect(stored?.tainted).toBe(true);
    expect(stored?.state).toBe('suspect');

    // The evaluation of the criterion should not rely solely on a tainted claim
    const result = evaluateCriterion(ledger, {
      description: 'API is functional',
      subject: 'api-health',
    });
    expect(result.satisfied).toBe(false);
    expect(result.evidenceClaimIds).not.toContain(claim.id);

    // Verify trace event for taint marking
    const taintEvents = TraceStore.getEvents().filter(e => e.type === 'claim_tainted');
    expect(taintEvents.length).toBe(1);
    expect(taintEvents[0].data.claimId).toBe(claim.id);
  });

  test('trace_eval can cite claim_ids as evidence refs for criterion satisfaction', () => {
    const claim1 = synthesizeClaim(
      ledger,
      'Payment gateway responds in <200ms',
      [{ ref: 'perf-report', reliability: 0.95 }],
      0.95,
      { subjectTags: ['performance', 'payment'] }
    );

    const claim2 = synthesizeClaim(
      ledger,
      'Payment endpoint error rate below 0.1%',
      [{ ref: 'error-logs', reliability: 0.99 }],
      0.99,
      { subjectTags: ['performance', 'payment'] }
    );

    const result = evaluateCriterion(ledger, {
      description: 'Payment service meets SLA',
      subject: 'payment',
    });

    // Both claims should be used as evidence
    expect(result.satisfied).toBe(true);
    expect(result.evidenceClaimIds).toEqual(
      expect.arrayContaining([claim1.id, claim2.id])
    );

    // A trace event should record the evaluation with evidence refs
    const evalEvents = TraceStore.getEvents().filter(e => e.type === 'criterion_evaluation');
    expect(evalEvents).toHaveLength(1);
    expect(evalEvents[0].data.criterion).toBe('Payment service meets SLA');
    expect(evalEvents[0].data.evidenceClaimIds).toEqual(
      expect.arrayContaining([claim1.id, claim2.id])
    );
  });

  test('claim ledger operations are recorded in trace events for full auditability', () => {
    const claim = synthesizeClaim(
      ledger,
      'Audit test',
      [{ ref: 'source', reliability: 1 }],
      1,
      { subjectTags: ['audit'] }
    );

    const beforeTrace = TraceStore.getEvents();
    expect(beforeTrace.some(e => e.type === 'claim_registered')).toBe(true);

    verifyClaimsForDecision(ledger, { subject: 'audit' });
    const afterVerify = TraceStore.getEvents();
    expect(afterVerify.some(e => e.type === 'claim_verification')).toBe(true);

    markClaimTainted(ledger, claim.id, 'test');
    expect(TraceStore.getEvents().some(e => e.type === 'claim_tainted')).toBe(true);

    evaluateCriterion(ledger, { description: 'Audit criterion', subject: 'audit' });
    expect(TraceStore.getEvents().some(e => e.type === 'criterion_evaluation')).toBe(true);
  });
});
