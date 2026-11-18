import { describe, it, expect } from "vitest";
import {
  KnowledgeBase,
  rankDocuments,
  recall,
  tokenize,
  type KnowledgeDocument,
} from "../cap_knowledge_base_recall";

/**
 * First-match bias stress test: the corpus is ordered so that doc[0] has a
 * weak lexical overlap with the query (one low-idf common term) while the
 * high-idf answer terms live in a LATER document. A first-match/early-exit
 * implementation would return doc[0]; correct BM25-style full-corpus scoring
 * must return the later document at rank 1.
 */
const CORPUS: KnowledgeDocument[] = [
  {
    id: "doc-000",
    // Weak overlap: contains "cache" (also in query) but not the answer terms.
    content:
      "General notes on system performance and the cache layer, including " +
      "miscellaneous operational remarks about throughput and logging.",
  },
  {
    id: "doc-001",
    content:
      "Onboarding guide for new engineers: workspace setup, editor config, " +
      "and code review etiquette.",
  },
  {
    id: "doc-002",
    content:
      "Meeting minutes from the quarterly planning sync; action items and " +
      "roadmap discussion.",
  },
  {
    id: "doc-003",
    // The correct answer: contains the distinctive high-idf query terms.
    content:
      "The eviction policy for the distributed cache uses least-frequently-used " +
      "replacement with an adaptive decay factor, documented in the eviction " +
      "policy specification.",
  },
  {
    id: "doc-004",
    content: "Vendor contracts and procurement timelines for office supplies.",
  },
];

const QUERY = "what is the cache eviction policy";

describe("cap_knowledge_base_recall", () => {
  it("tokenizes and drops stopwords", () => {
    const tokens = tokenize("The Cache and eviction policy");
    expect(tokens).toContain("cache");
    expect(tokens).toContain("eviction");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("and");
  });

  it("returns the later, more relevant document at rank 1 (recall@1 / MRR-style)", () => {
    const result = recall(QUERY, CORPUS);

    expect(result.top).not.toBeNull();
    // Position assertion: the correct answer must be rank 1, not merely present.
    expect(result.top!.rank).toBe(1);
    expect(result.top!.id).toBe("doc-003");
    expect(result.top!.content).toContain("least-frequently-used");
    expect(result.top!.content).toContain("eviction");
  });

  it("does not return the weakly-overlapping first document", () => {
    const ranked = rankDocuments(QUERY, CORPUS);
    expect(ranked[0].id).toBe("doc-003");
    expect(ranked[0].score).toBeGreaterThan(ranked.find((d) => d.id === "doc-000")!.score);
  });

  it("ranks the full corpus deterministically with a stable id tiebreak", () => {
    const r1 = rankDocuments(QUERY, CORPUS);
    const r2 = rankDocuments(QUERY, [...CORPUS].slice());
    expect(r1.map((d) => d.id)).toEqual(r2.map((d) => d.id));
    expect(r1.every((d, i) => d.rank === i + 1)).toBe(true);
  });

  it("remains correct when corpus order is reversed (no positional bias)", () => {
    const reversed = [...CORPUS].reverse();
    const result = recall(QUERY, reversed);
    expect(result.top!.id).toBe("doc-003");
    expect(result.top!.rank).toBe(1);
  });

  it("marks the top result as confident when it clearly beats the runner-up", () => {
    const result = recall(QUERY, CORPUS);
    expect(result.confident).toBe(true);
  });

  it("reports low confidence / no top for a query with no real overlap", () => {
    const result = recall("quantum entanglement experiments", CORPUS);
    expect(result.top).toBeNull();
    expect(result.confident).toBe(false);
  });

  it("handles empty corpus and empty query gracefully", () => {
    expect(recall(QUERY, []).ranked).toEqual([]);
    expect(recall(QUERY, []).top).toBeNull();
    expect(recall("", CORPUS).ranked).toEqual([]);
  });

  it("KnowledgeBase.recall finds the later answer document across many distractors", () => {
    const kb = new KnowledgeBase();
    // Insert the weak-overlap doc first, then many distractors, then the answer.
    kb.add(CORPUS[0]);
    for (let i = 0; i < 40; i++) {
      kb.add({
        id: `distractor-${i}`,
        content: `Filler passage ${i} about caches, latency numbers, and dashboards.`,
      });
    }
    kb.add(CORPUS[3]);

    const result = kb.recall(QUERY);
    expect(result.top!.id).toBe("doc-003");
    expect(result.top!.rank).toBe(1);
    expect(result.confident).toBe(true);
  });

  it("KnowledgeBase add/get/all round-trips documents", () => {
    const kb = new KnowledgeBase(CORPUS);
    expect(kb.size).toBe(CORPUS.length);
    expect(kb.get("doc-003")!.id).toBe("doc-003");
    expect(kb.all().length).toBe(CORPUS.length);
  });
});
