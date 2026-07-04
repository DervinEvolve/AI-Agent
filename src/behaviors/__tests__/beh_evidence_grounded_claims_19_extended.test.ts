import { describe, it, expect, beforeEach } from 'vitest';
import { ClaimLedger } from '../beh_evidence_grounded_claims_19';

describe('ClaimLedger - extended tests', () => {
  let ledger: ClaimLedger;

  beforeEach(() => {
    ledger = new ClaimLedger();
    ledger.clearTrace();
  });

  it('should propagate taint from a source claim', () => {
    const taintedSource = ledger.addClaim('tainted source', ['ext1'], 0.8, undefined, undefined, true);
    const derived = ledger.addClaim('derived from tainted', [taintedSource.id], 0.7);
    expect(derived.tainted).toBe(true);
  });

  it('should not propagate taint from external string sources', () => {
    const derived = ledger.addClaim('clean derived', ['external_ref'], 0.9);
    expect(derived.tainted).toBe(false);
  });

  it('should clamp confidence to [0,1]', () => {
    const high = ledger.addClaim('high conf', ['s1'], 1.5);
    expect(high.confidence).toBe(1);
    const low = ledger.addClaim('low conf', ['s2'], -0.2);
    expect(low.confidence).toBe(0);
  });

  it('should store freshUntil when provided', () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const claim = ledger.addClaim('fresh claim', ['src'], 0.9, future);
    expect(claim.freshUntil).toBe(future);
  });

  it('should return undefined for non-existent claim via getClaim', () => {
    expect(ledger.getClaim('nonexistent')).toBeUndefined();
  });

  it('verifyContradictions should return empty array for a claim with no contradictions', () => {
    const claim = ledger.addClaim('unique statement', ['src'], 0.9);
    const result = ledger.verifyContradictions(claim.id);
    expect(result.contradictions).toEqual([]);
  });

  it('verifyContradictions should return contradictions after adding conflicting claims', () => {
    const c1 = ledger.addClaim('same text', ['src1'], 0.8);
    const c2 = ledger.addClaim('same text', ['src2'], 0.9);
    const result = ledger.verifyContradictions(c1.id);
    expect(result.contradictions).toContain(c2.id);
    expect(result.contradictions.length).toBe(1);
  });

  it('should record add_claim trace event', () => {
    ledger.clearTrace();
    const claim = ledger.addClaim('trace event test', ['src'], 0.5);
    const trace = ledger.getTrace();
    const addEvent = trace.find(e => e.type === 'add_claim');
    expect(addEvent).toBeTruthy();
    expect(addEvent?.claimId).toBe(claim.id);
  });

  it('should record verify_contradictions trace event', () => {
    const claim = ledger.addClaim('trace verify', ['src'], 0.5);
    ledger.verifyContradictions(claim.id);
    const trace = ledger.getTrace();
    const verifyEvent = trace.find(e => e.type === 'verify_contradictions');
    expect(verifyEvent).toBeTruthy();
    expect(verifyEvent?.claimId).toBe(claim.id);
  });

  it('clearTrace should empty the trace array', () => {
    ledger.addClaim('trace', ['s'], 0.5);
    expect(ledger.getTrace().length).toBeGreaterThan(0);
    ledger.clearTrace();
    expect(ledger.getTrace()).toEqual([]);
  });
});
