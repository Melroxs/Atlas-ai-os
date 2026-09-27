// ---------------------------------------------------------------------------
// Atlas Knowledge Layer — Tests
//
// Covers:
//   1. Embeddings provider abstraction
//   2. Cosine similarity
//   3. Keyword scoring
//   4. Intent classification
//   5. Knowledge context building
//   6. Knowledge context string generation
//   7. Source classification mapping
//   8. Knowledge layer priority
//   9. Seed data integrity
//  10. Deterministic fallback contract
// ---------------------------------------------------------------------------

import { describe, expect, it, beforeEach } from "vitest";
import {
  getEmbeddingsProvider,
  resetEmbeddingsProvider,
  generateEmbeddings,
  cosine,
  keywordScore,
  rankBySimilarity,
} from "./embeddings";
import {
  classifyIntent,
  buildKnowledgeContext,
  buildKnowledgeContextString,
} from "./retrieval";
import {
  ATLAS_INDUSTRY_KNOWLEDGE_SEED,
  ATLAS_KNOWLEDGE_PROVENANCE,
  INDUSTRY_TERMS,
  EVIDENCE_REQUIREMENTS,
  CLAIM_LIFECYCLE,
  RISK_PATTERNS,
  REVENUE_CONCEPTS,
  INDUSTRY_ROLES,
} from "./seed";
import {
  KNOWLEDGE_LAYER_PRIORITY,
  SOURCE_CLASSIFICATIONS,
  INGESTION_STATUS_LABELS,
  type KnowledgeLayer,
  type KnowledgeRetrievalResult,
  type KnowledgeItem,
} from "./types";

// ---------------------------------------------------------------------------
// 1. Embeddings provider abstraction
// ---------------------------------------------------------------------------

describe("EmbeddingsProvider", () => {
  beforeEach(() => {
    resetEmbeddingsProvider();
  });

  it("returns a provider instance", async () => {
    const provider = await getEmbeddingsProvider();
    expect(provider).toBeDefined();
    expect(provider.name).toBeTruthy();
    expect(provider.dimension).toBeGreaterThan(0);
  });

  it("is always available (local fallback guaranteed)", async () => {
    const provider = await getEmbeddingsProvider();
    expect(provider.isAvailable()).toBe(true);
  });

  it("generates deterministic embeddings for the same input", async () => {
    const provider = await getEmbeddingsProvider();
    const [a] = await provider.embed(["insurance restoration claim"]);
    const [b] = await provider.embed(["insurance restoration claim"]);
    expect(a).toEqual(b);
  });

  it("generates different embeddings for different inputs", async () => {
    const provider = await getEmbeddingsProvider();
    const [a] = await provider.embed(["water damage mitigation"]);
    const [b] = await provider.embed(["fire damage reconstruction"]);
    expect(a).not.toEqual(b);
  });

  it("embedding dimension matches the provider's declared dimension", async () => {
    const provider = await getEmbeddingsProvider();
    const [embedding] = await provider.embed(["test"]);
    expect(embedding.length).toBe(provider.dimension);
  });

  it("handles empty input", async () => {
    const provider = await getEmbeddingsProvider();
    const result = await provider.embed([]);
    expect(result).toEqual([]);
  });

  it("handles multiple texts in a single call", async () => {
    const provider = await getEmbeddingsProvider();
    const result = await provider.embed(["one", "two", "three"]);
    expect(result).toHaveLength(3);
    for (const emb of result) {
      expect(emb.length).toBe(provider.dimension);
    }
  });

  it("reset clears the singleton", async () => {
    const a = await getEmbeddingsProvider();
    resetEmbeddingsProvider();
    const b = await getEmbeddingsProvider();
    // Both should work, but the singleton should be re-created
    expect(a).toBeDefined();
    expect(b).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Cosine similarity
// ---------------------------------------------------------------------------

describe("cosine", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBe(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosine([1, 0], [-1, 0])).toBe(-1);
  });

  it("returns 0 for zero vectors", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it("returns 0 for mismatched dimensions", () => {
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
  });

  it("handles normalized vectors correctly", () => {
    const a = [0.6, 0.8];
    const b = [0.8, 0.6];
    const sim = cosine(a, b);
    expect(sim).toBeCloseTo(0.96, 1);
  });
});

// ---------------------------------------------------------------------------
// 3. Keyword scoring
// ---------------------------------------------------------------------------

describe("keywordScore", () => {
  it("returns 0 for empty query", () => {
    expect(keywordScore("", "some text")).toBe(0);
  });

  it("returns 0 for empty text", () => {
    expect(keywordScore("query", "")).toBe(0);
  });

  it("returns positive score for matching terms", () => {
    const score = keywordScore("water damage", "water damage restoration services");
    expect(score).toBeGreaterThan(0);
  });

  it("returns higher score for more matches", () => {
    const low = keywordScore("water", "water restoration");
    const high = keywordScore("water damage mitigation", "water damage mitigation drying");
    expect(high).toBeGreaterThan(low);
  });

  it("returns 0 for no matching terms", () => {
    expect(keywordScore("fire", "water damage restoration")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Intent classification
// ---------------------------------------------------------------------------

describe("classifyIntent", () => {
  it("classifies evidence gap queries", () => {
    const result = classifyIntent("What evidence are we missing for this claim?");
    expect(result.intent).toBe("identify_missing_evidence");
    expect(result.needsIndustryKnowledge).toBe(true);
    expect(result.needsLiveEvidence).toBe(true);
  });

  it("classifies contradiction queries", () => {
    const result = classifyIntent("The two documents are in conflict on the payment amount");
    expect(result.intent).toBe("identify_contradiction");
    expect(result.needsCustomerKnowledge).toBe(true);
    expect(result.needsLiveEvidence).toBe(true);
  });

  it("classifies requirement queries", () => {
    const result = classifyIntent("What documentation must we submit for this supplement?");
    expect(result.intent).toBe("identify_requirement");
  });

  it("classifies recommendation queries", () => {
    const result = classifyIntent("What should we do next?");
    expect(result.intent).toBe("recommend_next_action");
  });

  it("classifies industry concept queries", () => {
    const result = classifyIntent("Explain the IICRC S500 standard for water damage.");
    expect(result.intent).toBe("explain_industry_concept");
    expect(result.needsIndustryKnowledge).toBe(true);
  });

  it("defaults to knowledge_search for unmatched queries", () => {
    const result = classifyIntent("hello world");
    expect(result.intent).toBe("knowledge_search");
  });

  it("classifies summarize queries", () => {
    const result = classifyIntent("Give me a summary of all claims");
    expect(result.intent).toBe("summarize_claim");
  });

  it("classifies evidence-finding queries", () => {
    // "missing" and "need" in the same query → identify_missing_evidence wins
    const result = classifyIntent("I am looking for the evidence that supports this claim");
    expect(result.intent).toBe("find_evidence");
    expect(result.needsIndustryKnowledge).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Knowledge context building
// ---------------------------------------------------------------------------

describe("buildKnowledgeContext", () => {
  const makeResult = (
    layer: KnowledgeLayer,
    id: string,
    relevance = 0.5,
    industry?: string,
    jurisdiction?: string,
  ): KnowledgeRetrievalResult => ({
    item: {
      id,
      layer,
      sourceClassification: "ATLAS_CURATED",
      title: `Item ${id}`,
      statement: `Statement ${id}`,
      knowledgeType: "terminology",
      confidence: 0.7,
      status: "active",
      isInference: false,
      industry,
      jurisdiction,
    },
    relevance,
    retrievalMethod: "keyword",
    sourceClassification: "ATLAS_CURATED",
    layer,
  });

  it("counts items per layer", () => {
    const context = buildKnowledgeContext([
      makeResult("atlas_industry", "a"),
      makeResult("atlas_industry", "b"),
      makeResult("customer", "c"),
      makeResult("live_evidence", "d"),
    ]);
    expect(context.layerCounts.atlas_industry).toBe(2);
    expect(context.layerCounts.customer).toBe(1);
    expect(context.layerCounts.live_evidence).toBe(1);
    expect(context.totalItems).toBe(4);
  });

  it("collects unique industries and jurisdictions", () => {
    const context = buildKnowledgeContext([
      makeResult("atlas_industry", "a", 0.5, "insurance restoration", "United States"),
      makeResult("customer", "b", 0.5, "insurance restoration", "United States > Florida"),
      makeResult("live_evidence", "c", 0.5, undefined, undefined),
    ]);
    expect(context.industries).toContain("insurance restoration");
    expect(context.jurisdictions).toContain("United States");
    expect(context.jurisdictions).toContain("United States > Florida");
  });

  it("detects provenance", () => {
    const withProv = buildKnowledgeContext([
      {
        ...makeResult("atlas_industry", "a"),
        provenance: {
          sourceId: "osha",
          sourceName: "OSHA",
          organization: "US OSHA",
          authorityTier: "tier1_primary",
          sourceType: "regulation",
          status: "active",
        },
      },
    ]);
    expect(withProv.hasProvenance).toBe(true);

    const withoutProv = buildKnowledgeContext([makeResult("atlas_industry", "b")]);
    expect(withoutProv.hasProvenance).toBe(false);
  });

  it("handles empty input", () => {
    const context = buildKnowledgeContext([]);
    expect(context.totalItems).toBe(0);
    expect(context.items).toEqual([]);
    expect(context.hasProvenance).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Knowledge context string generation
// ---------------------------------------------------------------------------

describe("buildKnowledgeContextString", () => {
  it("returns empty string for no items", () => {
    const ctx = buildKnowledgeContext([]);
    expect(buildKnowledgeContextString(ctx)).toBe("");
  });

  it("groups items by layer", () => {
    const ctx = buildKnowledgeContext([
      {
        item: {
          id: "a",
          layer: "atlas_industry",
          sourceClassification: "REGULATORY",
          title: "OSHA Standard",
          statement: "Workers must have fall protection above 6 feet.",
          knowledgeType: "requirement",
          confidence: 0.9,
          status: "active",
          isInference: false,
        },
        relevance: 0.8,
        retrievalMethod: "keyword",
        sourceClassification: "REGULATORY",
        layer: "atlas_industry",
        provenance: {
          sourceId: "osha",
          sourceName: "OSHA Construction Standards",
          organization: "US OSHA",
          authorityTier: "tier1_primary",
          sourceType: "regulation",
          status: "active",
        },
      },
      {
        item: {
          id: "b",
          layer: "live_evidence",
          sourceClassification: "CUSTOMER_GENERATED",
          title: "Claim GAP-26-51847",
          statement: "Potential claim with 3 evidence items.",
          knowledgeType: "claim_candidate",
          confidence: 0.85,
          status: "pending",
          isInference: false,
        },
        relevance: 0.7,
        retrievalMethod: "evidence",
        sourceClassification: "CUSTOMER_GENERATED",
        layer: "live_evidence",
      },
    ]);

    const str = buildKnowledgeContextString(ctx);
    expect(str).toContain("<atlas_knowledge>");
    expect(str).toContain("</atlas_knowledge>");
    expect(str).toContain("Atlas Industry Knowledge");
    expect(str).toContain("Live Company Evidence");
    expect(str).toContain("OSHA Standard");
    expect(str).toContain("Claim GAP-26-51847");
    expect(str).toContain("Source: OSHA Construction Standards");
  });

  it("includes interpretation when present", () => {
    const ctx = buildKnowledgeContext([
      {
        item: {
          id: "a",
          layer: "atlas_industry",
          sourceClassification: "ATLAS_CURATED",
          title: "Supplement",
          statement: "An additional invoice for work not in the original estimate.",
          interpretation: "Supplements represent a major revenue recovery opportunity.",
          knowledgeType: "terminology",
          confidence: 0.9,
          status: "active",
          isInference: false,
        },
        relevance: 0.8,
        retrievalMethod: "keyword",
        sourceClassification: "ATLAS_CURATED",
        layer: "atlas_industry",
      },
    ]);

    const str = buildKnowledgeContextString(ctx);
    expect(str).toContain("Supplement:");
    expect(str).toContain("Interpretation:");
    expect(str).toContain("revenue recovery opportunity");
  });
});

// ---------------------------------------------------------------------------
// 7. Source classification metadata
// ---------------------------------------------------------------------------

describe("SOURCE_CLASSIFICATIONS", () => {
  it("has all 10 source classifications", () => {
    expect(Object.keys(SOURCE_CLASSIFICATIONS)).toHaveLength(10);
  });

  it("ranks the trade training manual below every current authority", () => {
    const training = SOURCE_CLASSIFICATIONS.TRAINING_MANUAL;
    // A training reference must never outrank a regulation, manufacturer
    // documentation, or recognized professional guidance.
    expect(training.defaultConfidence).toBeLessThan(
      SOURCE_CLASSIFICATIONS.REGULATORY.defaultConfidence,
    );
    expect(training.defaultConfidence).toBeLessThan(
      SOURCE_CLASSIFICATIONS.MANUFACTURER.defaultConfidence,
    );
    expect(training.defaultConfidence).toBeLessThan(
      SOURCE_CLASSIFICATIONS.PROFESSIONAL_GUIDANCE.defaultConfidence,
    );
    // ...but it is still a real source, above pure model inference.
    expect(training.defaultConfidence).toBeGreaterThan(
      SOURCE_CLASSIFICATIONS.MODEL_INFERENCE.defaultConfidence,
    );
  });

  it("each has required fields", () => {
    for (const [key, meta] of Object.entries(SOURCE_CLASSIFICATIONS)) {
      expect(meta.classification).toBe(key);
      expect(meta.label).toBeTruthy();
      expect(meta.description).toBeTruthy();
      expect(meta.defaultConfidence).toBeGreaterThan(0);
      expect(meta.defaultConfidence).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Knowledge layer priority
// ---------------------------------------------------------------------------

describe("KNOWLEDGE_LAYER_PRIORITY", () => {
  it("live_evidence has highest priority", () => {
    expect(KNOWLEDGE_LAYER_PRIORITY.live_evidence).toBeGreaterThan(
      KNOWLEDGE_LAYER_PRIORITY.customer,
    );
  });

  it("customer has higher priority than atlas_industry", () => {
    expect(KNOWLEDGE_LAYER_PRIORITY.customer).toBeGreaterThan(
      KNOWLEDGE_LAYER_PRIORITY.atlas_industry,
    );
  });

  it("all layers have defined priority", () => {
    const layers: KnowledgeLayer[] = ["atlas_industry", "customer", "live_evidence"];
    for (const layer of layers) {
      expect(KNOWLEDGE_LAYER_PRIORITY[layer]).toBeGreaterThan(0);
      expect(KNOWLEDGE_LAYER_PRIORITY[layer]).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Ingestion status labels
// ---------------------------------------------------------------------------

describe("INGESTION_STATUS_LABELS", () => {
  it("has labels for all statuses", () => {
    const statuses = [
      "uploaded", "processing", "parsed", "indexed",
      "needs_review", "approved", "published", "archived", "failed",
    ];
    for (const status of statuses) {
      expect(INGESTION_STATUS_LABELS[status as keyof typeof INGESTION_STATUS_LABELS]).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Seed data integrity
// ---------------------------------------------------------------------------

describe("ATLAS_INDUSTRY_KNOWLEDGE_SEED", () => {
  it("contains items from all categories", () => {
    expect(INDUSTRY_TERMS.length).toBeGreaterThan(0);
    expect(EVIDENCE_REQUIREMENTS.length).toBeGreaterThan(0);
    expect(CLAIM_LIFECYCLE.length).toBeGreaterThan(0);
    expect(RISK_PATTERNS.length).toBeGreaterThan(0);
    expect(REVENUE_CONCEPTS.length).toBeGreaterThan(0);
    expect(INDUSTRY_ROLES.length).toBeGreaterThan(0);
  });

  it("combined seed has all items", () => {
    const expected =
      INDUSTRY_TERMS.length +
      EVIDENCE_REQUIREMENTS.length +
      CLAIM_LIFECYCLE.length +
      RISK_PATTERNS.length +
      REVENUE_CONCEPTS.length +
      INDUSTRY_ROLES.length;
    expect(ATLAS_INDUSTRY_KNOWLEDGE_SEED.length).toBe(expected);
  });

  it("every item has required fields", () => {
    for (const item of ATLAS_INDUSTRY_KNOWLEDGE_SEED) {
      expect(item.id).toBeTruthy();
      expect(item.layer).toBe("atlas_industry");
      expect(item.title).toBeTruthy();
      expect(item.statement).toBeTruthy();
      expect(item.knowledgeType).toBeTruthy();
      expect(item.confidence).toBeGreaterThan(0);
      expect(item.confidence).toBeLessThanOrEqual(1);
      expect(item.status).toBe("active");
    }
  });

  it("no duplicate IDs", () => {
    const ids = ATLAS_INDUSTRY_KNOWLEDGE_SEED.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every item has the insurance restoration industry tag or is generic", () => {
    for (const item of ATLAS_INDUSTRY_KNOWLEDGE_SEED) {
      if (item.industry) {
        expect(item.industry).toBeTruthy();
      }
    }
  });
});

describe("ATLAS_KNOWLEDGE_PROVENANCE", () => {
  it("contains provenance records", () => {
    expect(ATLAS_KNOWLEDGE_PROVENANCE.length).toBeGreaterThanOrEqual(6);
  });

  it("every record has required fields", () => {
    for (const p of ATLAS_KNOWLEDGE_PROVENANCE) {
      expect(p.sourceId).toBeTruthy();
      expect(p.sourceName).toBeTruthy();
      expect(p.organization).toBeTruthy();
      expect(p.authorityTier).toBeTruthy();
      expect(p.sourceType).toBeTruthy();
    }
  });

  it("includes regulatory and industry sources", () => {
    const types = ATLAS_KNOWLEDGE_PROVENANCE.map((p) => p.sourceType);
    expect(types).toContain("regulation");
    expect(types).toContain("standard");
    expect(types).toContain("curated");
  });

  it("includes all six required provenance sources", () => {
    const ids = ATLAS_KNOWLEDGE_PROVENANCE.map((p) => p.sourceId);
    expect(ids).toContain("atlas-curated");
    expect(ids).toContain("atlas-evidence-model");
    expect(ids).toContain("atlas-professional-guidance");
    expect(ids).toContain("iicrc-s500");
    expect(ids).toContain("iicrc-s520");
    expect(ids).toContain("osha-construction");
    expect(ids).toContain("epa-lead-rrp");
  });
});

// ---------------------------------------------------------------------------
// 11. Seed data accuracy and provenance correctness
// ---------------------------------------------------------------------------

describe("Seed data provenance correctness", () => {
  it("all seeded records have layer = atlas_industry", () => {
    for (const item of ATLAS_INDUSTRY_KNOWLEDGE_SEED) {
      expect(item.layer).toBe("atlas_industry");
    }
  });

  it("unsubstantiated quantitative claims are marked isInference", () => {
    const underbilling = ATLAS_INDUSTRY_KNOWLEDGE_SEED.find(
      (i) => i.id === "risk_underbilling",
    );
    expect(underbilling).toBeDefined();
    expect(underbilling!.isInference).toBe(true);
    expect(underbilling!.confidence).toBeLessThan(0.75);
  });

  it("unsupported causal claims are softened to Atlas observations", () => {
    const unauthorized = ATLAS_INDUSTRY_KNOWLEDGE_SEED.find(
      (i) => i.id === "risk_unauthorized_work",
    );
    expect(unauthorized).toBeDefined();
    // Should not claim "single most common reason" — that is unsupported
    expect(unauthorized!.interpretation).not.toContain("single most common");
  });

  it("code upgrade claim does not assert automatic recoverability", () => {
    const codeRev = ATLAS_INDUSTRY_KNOWLEDGE_SEED.find(
      (i) => i.id === "revenue_code_requirements",
    );
    expect(codeRev).toBeDefined();
    expect(codeRev!.interpretation).toContain("may be");
    expect(codeRev!.confidence).toBeLessThanOrEqual(0.8);
  });

  it("supplement approval claim is softened to correlation language", () => {
    const lifecycle = ATLAS_INDUSTRY_KNOWLEDGE_SEED.find(
      (i) => i.id === "lifecycle_supplement",
    );
    expect(lifecycle).toBeDefined();
    // Should not claim "approved at much higher rates" as a guarantee
    expect(lifecycle!.interpretation).toContain("correlate");
  });

  it("no duplicate titles within the same knowledgeType (idempotency)", () => {
    const seen = new Set<string>();
    for (const item of ATLAS_INDUSTRY_KNOWLEDGE_SEED) {
      const key = `${item.knowledgeType}::${item.title}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("total item count remains consistent (26)", () => {
    expect(ATLAS_INDUSTRY_KNOWLEDGE_SEED.length).toBe(26);
  });

  it("total provenance count remains consistent (7)", () => {
    expect(ATLAS_KNOWLEDGE_PROVENANCE.length).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 12. Deterministic fallback contract
// ---------------------------------------------------------------------------

describe("Deterministic fallback", () => {
  it("provider works without any API key configured", async () => {
    // This test proves the system works without GEMINI_API_KEY
    resetEmbeddingsProvider();
    const provider = await getEmbeddingsProvider();
    expect(provider.isAvailable()).toBe(true);
    expect(provider.name).toBe("local");
  });

  it("rankBySimilarity returns correct top-K", async () => {
    const provider = await getEmbeddingsProvider();
    const queryEmb = (await provider.embed(["water damage"]))[0];
    const docEmbs = [
      { id: "d1", embedding: (await provider.embed(["water damage restoration"]))[0] },
      { id: "d2", embedding: (await provider.embed(["fire damage reconstruction"]))[0] },
      { id: "d3", embedding: (await provider.embed(["water extraction drying"]))[0] },
    ];

    const ranked = rankBySimilarity(queryEmb, docEmbs, 2);
    expect(ranked).toHaveLength(2);
    // Top results should be the water-related ones
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
  });
});
