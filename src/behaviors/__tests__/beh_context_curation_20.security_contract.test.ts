import { describe, it, expect } from 'vitest';
import {
  assembleContext,
  prepareReasoningContext,
  canUseAsInstruction,
  BEHAVIOR_ID,
  type CurationInput,
  type PinnedItem,
  type EvidenceItem,
} from '../beh_context_curation_20';

function pin(kind: PinnedItem['kind'], id: string, tokens = 5): PinnedItem {
  return { kind, id, text: `${kind}:${id}`, tokens };
}

function ev(over: Partial<EvidenceItem> & { id: string }): EvidenceItem {
  return {
    text: `text-${over.id}`,
    tokens: 10,
    relevance: 0.9,
    freshness: 0.5,
    reliability: 0.9,
    trust: 'trusted',
    provenance: [`src:${over.id}`],
    ...over,
  };
}

describe('beh_context_curation_20', () => {
  it('curates via context manager for nontrivial tasks instead of raw history', () => {
    const input: CurationInput = {
      taskId: 't1',
      nontrivial: true,
      budgetTokens: 100,
      pins: [pin('goal', 'g1'), pin('requirement', 'r1')],
      evidence: [ev({ id: 'e1' })],
    };
    const res = prepareReasoningContext(input);
    expect(res.curated).toBe(true);
    expect(res.context).not.toBeNull();
  });

  it('passes raw history for trivial tasks (no curation forced)', () => {
    const res = prepareReasoningContext({
      taskId: 't0',
      nontrivial: false,
      budgetTokens: 100,
      pins: [],
      evidence: [],
    });
    expect(res.curated).toBe(false);
    expect(res.context).toBeNull();
  });

  it('pins goal/requirement/policy in every assembled bundle', () => {
    const ctx = assembleContext({
      taskId: 't1',
      nontrivial: true,
      budgetTokens: 100,
      pins: [pin('goal', 'g1'), pin('requirement', 'r1'), pin('policy', 'p1')],
      evidence: [],
    });
    const ids = ctx.pinned.map((p) => p.id).sort();
    expect(ids).toEqual(['g1', 'p1', 'r1']);
    // Every pin also emits a trace event.
    const pinTraces = ctx.trace.filter((t) => t.type === 'pin');
    expect(pinTraces).toHaveLength(3);
  });

  it('flags budget eviction and prefers citing claim_ids over dropping provenance', () => {
    const ctx = assembleContext({
      taskId: 't1',
      nontrivial: true,
      budgetTokens: 12, // room for pins (5) + a small citing item only
      pins: [pin('goal', 'g1', 5)],
      evidence: [
        // High score, cited -> compact, keeps provenance.
        ev({ id: 'keep', claim_id: 'c1', relevance: 0.95, tokens: 10 }),
        // Also relevant but no room after -> evicted, flagged.
        ev({ id: 'drop', relevance: 0.9, tokens: 10 }),
      ],
    });
    expect(ctx.evidenceEvictedForBudget).toBe(true);
    expect(ctx.evictedRelevantIds).toContain('drop');
    const kept = ctx.evidence.find((e) => e.id === 'keep');
    expect(kept?.cite).toBe('c1');
    // Provenance preserved on the kept cited item.
    expect(kept?.provenance.length).toBeGreaterThan(0);
    expect(ctx.resolution).toBe('narrow_scope');
  });

  it('over_budget_after_pins with requirements -> structured failure, never silent drop', () => {
    const ctx = assembleContext({
      taskId: 't1',
      nontrivial: true,
      budgetTokens: 4,
      pins: [pin('requirement', 'r1', 5), pin('goal', 'g1', 5)],
      evidence: [ev({ id: 'e1' })],
    });
    expect(ctx.resolution).toBe('structured_failure');
    expect(ctx.structuredFailure).toBeDefined();
    expect(ctx.structuredFailure?.code).toBe('over_budget_after_pins');
    expect(ctx.structuredFailure?.behavior).toBe(BEHAVIOR_ID);
    // Requirement is surfaced as unmet, not silently dropped.
    expect(ctx.structuredFailure?.unmetPinIds).toContain('r1');
    // Pins still present in the bundle (not dropped).
    expect(ctx.pinned.map((p) => p.id)).toContain('r1');
    const gate = ctx.trace.find((t) => t.type === 'over_budget_after_pins');
    expect(gate).toBeDefined();
  });

  it('over_budget_after_pins without hard requirements -> clarify, not failure', () => {
    const ctx = assembleContext({
      taskId: 't1',
      nontrivial: true,
      budgetTokens: 3,
      pins: [pin('goal', 'g1', 5)],
      evidence: [],
    });
    expect(ctx.resolution).toBe('clarify');
    expect(ctx.structuredFailure).toBeUndefined();
  });

  it('tainted observations enter only as data, never as instructions, and require validation', () => {
    const ctx = assembleContext({
      taskId: 't1',
      nontrivial: true,
      budgetTokens: 100,
      pins: [pin('goal', 'g1')],
      evidence: [ev({ id: 'untrusted', trust: 'tainted' })],
    });
    const tainted = ctx.evidence.find((e) => e.id === 'untrusted')!;
    expect(tainted.trust).toBe('tainted');
    expect(tainted.usableAsInstruction).toBe(false);
    expect(tainted.requiresIndependentValidation).toBe(true);
    expect(canUseAsInstruction(tainted)).toBe(false);
    // Taint decision is traced.
    const taintTrace = ctx.trace.find(
      (t) => t.type === 'taint' && t.id === 'untrusted'
    );
    expect(taintTrace).toBeDefined();
  });

  it('trusted evidence is usable as instruction', () => {
    const ctx = assembleContext({
      taskId: 't1',
      nontrivial: true,
      budgetTokens: 100,
      pins: [pin('goal', 'g1')],
      evidence: [ev({ id: 'ok' })],
    });
    const item = ctx.evidence.find((e) => e.id === 'ok')!;
    expect(canUseAsInstruction(item)).toBe(true);
  });

  it('records include/evict decisions as trace events for audit', () => {
    const ctx = assembleContext({
      taskId: 't1',
      nontrivial: true,
      budgetTokens: 30,
      pins: [pin('goal', 'g1', 5)],
      evidence: [
        ev({ id: 'a', relevance: 0.9, tokens: 10 }),
        ev({ id: 'b', relevance: 0.9, tokens: 10 }),
        ev({ id: 'c', relevance: 0.9, tokens: 10 }),
      ],
    });
    const includes = ctx.trace.filter((t) => t.type === 'include');
    const evicts = ctx.trace.filter((t) => t.type === 'evict');
    expect(includes.length).toBeGreaterThan(0);
    expect(evicts.length).toBeGreaterThan(0);
    // Every included item appears in evidence.
    for (const t of includes) {
      if (t.type === 'include') {
        expect(ctx.evidence.some((e) => e.id === t.id)).toBe(true);
      }
    }
  });

  it('suppresses duplicate cited evidence while preserving one copy', () => {
    const ctx = assembleContext({
      taskId: 't1',
      nontrivial: true,
      budgetTokens: 100,
      pins: [pin('goal', 'g1', 5)],
      evidence: [
        ev({ id: 'd1', claim_id: 'same', relevance: 0.95 }),
        ev({ id: 'd2', claim_id: 'same', relevance: 0.9 }),
      ],
    });
    const cited = ctx.evidence.filter((e) => e.cite === 'same');
    expect(cited).toHaveLength(1);
    const dupEvict = ctx.trace.find(
      (t) => t.type === 'evict' && t.reason === 'duplicate'
    );
    expect(dupEvict).toBeDefined();
  });
});
