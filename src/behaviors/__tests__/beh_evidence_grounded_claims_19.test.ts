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
    // Register some claims
    synthesizeClaim(ledger, 'Service X has 99.9% uptime', [{ ref: 'monitoring-report', reliability: 0.95 }], 0.95, {
      subjectTags: ['uptime'],
    });
    const lowClaim = synthesizeClaim(
      ledger,
      'Service X has experienced outages recently',
      [{ ref: 'user-report', reliability: 0.4 }],
      0.5,
      { subjectTags: ['uptime'] }
    );
    // Create a contradiction: a new claim refutes the low claim
    synthesizeClaim(
      ledger,
      'Service X had no outages; user reports are false',
      [{ ref: 'detailed-incident-log', reliability: 0.9 }],
      0.9,
      { subjectTags: ['uptime'], refutes: [lowClaim.id] }
    );

    // Verify for a decision about reliability
    const result = verifyClaimsForDecision(ledger, {
      subjectTags: ['uptime'],
      minConfidence: 0.7,
    });

    expect(result.safe).toBe(false);
    expect(result.lowConfidenceClaims).toHaveLength(1);
    expect(result.lowConfidenceClaims[0].id).toBe(lowClaim.id);
    expect(result.contradictedClaims.length).toBeGreaterThan(0);
    const contradictedIds = result.contradictedClaims.map(c => c.id);
    expect(contradictedIds).toContain(lowClaim.id);
    expect(result.issues.some(issue => issue.includes('low confidence'))).toBe(true);
    expect(result.issues.some(issue => issue.includes('refutes'))).toBe(true);
  });

  test('a low-confidence or contradicted claim is flagged in the final answer or triggers a clarification request', () => {
    const claim = synthesizeClaim(
      ledger,
      'Memory usage is stable',
      [{ ref: 'quick-glance', reliability: 0.3 }],
      0.4,
      { subjectTags: ['memory'] }
    );

    const result = verifyClaimsForDecision(ledger, {
      subjectTags: ['memory'],
      minConfidence: 0.6,
    });

    expect(result.safe).toBe(false);
    expect(result.lowConfidenceClaims).toContain(claim);
    expect(result.issues.some(issue => issue.includes('low confidence'))).toBe(true);
  });

  test('claims derived from tainted observations are marked tainted and are not used as sole evidence for a success criterion', () => {
    // Register a claim from a tainted source
    const taintedClaim = synthesizeClaim(
      ledger,
      'User session is active',
      [{ ref: 'untrusted-proxy', reliability: 0.1 }],
      0.9,
      { tainted: true, subjectTags: ['session'] }
    );
    expect(taintedClaim.tainted).toBe(true);

    // Also register a clean claim
    synthesizeClaim(
      ledger,
      'User session verified by auth service',
      [{ ref: 'auth-service', reliability: 0.99 }],
      0.98,
      { subjectTags: ['session'] }
    );

    // Evaluate criterion that should only use clean claims
    const evaluation = evaluateCriterion(ledger, {
      subjectTag: 'session',
      minConfidence: 0.7,
      requiredClaims: 1,
    });

    // It should be satisfied because there is at least one non-tainted claim
    expect(evaluation.satisfied).toBe(true);
    expect(evaluation.supportingClaimIds).not.toContain(taintedClaim.id);
    expect(evaluation.confidence).toBeGreaterThan(0.9);

    // Now simulate scenario where only tainted claim exists
    ledger.clear();
    TraceStore.clear();
    synthesizeClaim(
      ledger,
      'Only tainted evidence',
      [{ ref: 'suspicious' }],
      0.8,
      { tainted: true, subjectTags: ['security'] }
    );
    const eval2 = evaluateCriterion(ledger, {
      subjectTag: 'security',
      minConfidence: 0.7,
    });
    expect(eval2.satisfied).toBe(false);
    expect(eval2.supportingClaimIds).toHaveLength(0);
  });

  test('trace_eval can cite claim_ids as evidence refs for criterion satisfaction', () => {
    const claim1 = synthesizeClaim(ledger, 'Deployment passed all tests', [{ ref: 'ci-pipeline' }], 1.0, {
      subjectTags: ['deployment'],
    });
    const claim2 = synthesizeClaim(ledger, 'No security alerts', [{ ref: 'security-scan' }], 0.95, {
      subjectTags: ['deployment', 'security'],
    });

    const evaluation = evaluateCriterion(ledger, {
      subjectTag: 'deployment',
      minConfidence: 0.9,
      requiredClaims: 2,
    });

    expect(evaluation.satisfied).toBe(true);
    expect(evaluation.supportingClaimIds).toContain(claim1.id);
    expect(evaluation.supportingClaimIds).toContain(claim2.id);
    expect(evaluation.traceData.claimIds).toEqual(
      expect.arrayContaining([claim1.id, claim2.id])
    );

    const traceEvents = TraceStore.getEvents();
    const criterionEvents = traceEvents.filter(e => e.type === 'criterion_evaluated');
    expect(criterionEvents).toHaveLength(1);
    expect(criterionEvents[0].data.claimIds).toEqual(evaluation.supportingClaimIds);
  });

  test('claim ledger operations are recorded in trace events for full auditability', () => {
    // Clear any initial events
    TraceStore.clear();

    const claim = synthesizeClaim(
      ledger,
      'Test',
      [{ ref: 'source' }],
      0.9,
      { subjectTags: ['audit'] }
    );

    markClaimTainted(ledger, claim.id);

    // Detect contradictions (none here, but function still runs)
    detectContradictions(ledger);

    const events = TraceStore.getEvents();
    expect(events).toHaveLength(2); // register + taint
    expect(events[0].type).toBe('claim_registered');
    expect(events[1].type).toBe('claim_tainted');
    expect(events[0].data.claimId).toBe(claim.id);
    expect(events[1].data.claimId).toBe(claim.id);

    // Now create contradiction scenario
    const claim2 = synthesizeClaim(
      ledger,
      'Refuting claim',
      [{ ref: 'second-source' }],
      0.8,
      { subjectTags: ['audit'], refutes: [claim.id] }
    );

    // Run contradiction detection
    detectContradictions(ledger);

    const laterEvents = TraceStore.getEvents();
    const contradictionEvent = laterEvents.find(e => e.type === 'contradiction_detected');
    expect(contradictionEvent).toBeDefined();
    expect(contradictionEvent!.data.claimA).toBe(claim2.id);
    expect(contradictionEvent!.data.claimB).toBe(claim.id);
  });
});
