// ---------------------------------------------------------------------------
// Atlas Knowledge Layer — Retrieval Module
//
// Retrieves knowledge from the three Atlas layers:
//   1. Atlas Industry Knowledge (global, shared)
//   2. Customer Knowledge (tenant-isolated)
//   3. Live Company Evidence (most contextually relevant)
//
// Supports multiple retrieval strategies:
//   - Semantic (embedding similarity)
//   - Keyword (BM25-style term matching)
//   - Metadata (filter by source type, industry, jurisdiction, etc.)
//   - Graph (entity/concept relationships)
//   - Evidence (company claim/document matching)
//
// Results are merged, deduplicated, and ranked by a weighted combination
// of retrieval score, knowledge layer priority, and confidence.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";
import { rpcCall } from "@/lib/actions/rpc";
import { applyAuthorityFloor } from "./training-manual-guardrails";
import {
  type KnowledgeItem,
  type KnowledgeLayer,
  type KnowledgeRetrievalResult,
  type KnowledgeRetrievalOptions,
  type KnowledgeContext,
  type KnowledgeIntent,
  type KnowledgeIntentClassification,
  type SourceClassification,
  KNOWLEDGE_LAYER_PRIORITY,
} from "./types";
import { generateEmbeddings, cosine, keywordScore } from "./embeddings";

// ---------------------------------------------------------------------------
// Intent Classification
// ---------------------------------------------------------------------------

const INTENT_PATTERNS: Array<{
  pattern: RegExp;
  classification: KnowledgeIntentClassification;
}> = [
  {
    pattern: /\b(what|how|explain|define|describe|meaning)\b.*\b(standard|regulation|requirement|code|rule)\b/i,
    classification: {
      intent: "explain_industry_concept",
      confidence: 0.8,
      needsIndustryKnowledge: true,
      needsCustomerKnowledge: false,
      needsLiveEvidence: false,
    },
  },
  {
    pattern: /\b(missing|lack|gap|incomplete|do we have|what.*need|not.*found|pricing support)\b/i,
    classification: {
      intent: "identify_missing_evidence",
      confidence: 0.85,
      needsIndustryKnowledge: true,
      needsCustomerKnowledge: true,
      needsLiveEvidence: true,
    },
  },
  {
    pattern: /\b(contradict|conflict|inconsisten|differ|discrepanc|not match)\b/i,
    classification: {
      intent: "identify_contradiction",
      confidence: 0.85,
      needsIndustryKnowledge: false,
      needsCustomerKnowledge: true,
      needsLiveEvidence: true,
    },
  },
  {
    pattern: /\b(require|must|shall|need|supplement|submit|documentation)\b/i,
    classification: {
      intent: "identify_requirement",
      confidence: 0.75,
      needsIndustryKnowledge: true,
      needsCustomerKnowledge: true,
      needsLiveEvidence: false,
    },
  },
  {
    pattern: /\b(recommend|should|next step|action|prioritize|next)\b/i,
    classification: {
      intent: "recommend_next_action",
      confidence: 0.8,
      needsIndustryKnowledge: true,
      needsCustomerKnowledge: true,
      needsLiveEvidence: true,
    },
  },
  {
    pattern: /\b(summarize|overview|summary|status|state)\b/i,
    classification: {
      intent: "summarize_claim",
      confidence: 0.7,
      needsIndustryKnowledge: false,
      needsCustomerKnowledge: true,
      needsLiveEvidence: true,
    },
  },
  {
    pattern: /\b(support|evidence|prove|justify|back up|documentation)\b/i,
    classification: {
      intent: "find_evidence",
      confidence: 0.8,
      needsIndustryKnowledge: true,
      needsCustomerKnowledge: true,
      needsLiveEvidence: true,
    },
  },
  {
    pattern: /\b(compare|difference|versus|vs|better|worse)\b/i,
    classification: {
      intent: "compare_documents",
      confidence: 0.75,
      needsIndustryKnowledge: false,
      needsCustomerKnowledge: true,
      needsLiveEvidence: true,
    },
  },
  {
    pattern: /\b(why|reason|cause|explain why)\b.*\b(deny|denied|reject|flag|risk|block)\b/i,
    classification: {
      intent: "explain_supplement_support",
      confidence: 0.8,
      needsIndustryKnowledge: true,
      needsCustomerKnowledge: true,
      needsLiveEvidence: true,
    },
  },
];

/** Classify a user query into a knowledge intent. */
export function classifyIntent(query: string): KnowledgeIntentClassification {
  const q = query.toLowerCase();

  for (const { pattern, classification } of INTENT_PATTERNS) {
    if (pattern.test(q)) {
      return classification;
    }
  }

  // Default: knowledge search
  return {
    intent: "knowledge_search",
    confidence: 0.5,
    needsIndustryKnowledge: true,
    needsCustomerKnowledge: true,
    needsLiveEvidence: true,
  };
}

// ---------------------------------------------------------------------------
// Text tokenization for keyword matching
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "what", "did", "you", "find", "the", "of", "and", "how", "many", "do", "we",
  "have", "is", "are", "for", "to", "with", "on", "at", "from", "that", "it",
  "our", "your", "about", "me", "show", "why", "which", "needs", "most",
  "attention", "can", "i", "get", "tell", "this", "these", "those", "there",
  "their", "they", "was", "were", "be", "been", "all", "any", "each", "not",
  "but", "also", "its", "into", "than", "then", "when", "where", "will",
  "would", "should", "could", "please", "let", "know", "out", "over", "under",
  "more", "other", "some", "such", "only", "own", "same", "so", "too", "very",
  "just", "come", "does", "has", "had", "having",
]);

function tokens(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\-.\\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

// ---------------------------------------------------------------------------
// Knowledge Retrieval
// ---------------------------------------------------------------------------

/**
 * Build a KnowledgeContext from a set of retrieval results.
 */
export function buildKnowledgeContext(
  results: KnowledgeRetrievalResult[],
): KnowledgeContext {
  const layerCounts: Record<KnowledgeLayer, number> = {
    atlas_industry: 0,
    customer: 0,
    live_evidence: 0,
  };
  const industries = new Set<string>();
  const jurisdictions = new Set<string>();
  let hasProvenance = false;

  for (const r of results) {
    layerCounts[r.layer]++;
    if (r.provenance) hasProvenance = true;
    if (r.item.industry) industries.add(r.item.industry);
    if (r.item.jurisdiction) jurisdictions.add(r.item.jurisdiction);
  }

  return {
    items: results,
    layerCounts,
    totalItems: results.length,
    hasProvenance,
    industries: [...industries],
    jurisdictions: [...jurisdictions],
  };
}

/**
 * Retrieve Atlas Industry Knowledge for a query.
 *
 * This searches:
 *   1. Authoritative knowledge (existing authoritativeKnowledge table)
 *   2. Intelligence packs (existing packs via intelligence_list_pack_items)
 *   3. Document knowledge (existing documents + chunks)
 *
 * All filtered by the provided options.
 */
async function retrieveIndustryKnowledge(
  supabase: SupabaseClient,
  query: string,
  options: KnowledgeRetrievalOptions,
): Promise<KnowledgeRetrievalResult[]> {
  const results: KnowledgeRetrievalResult[] = [];
  const terms = tokens(query);
  const limit = options.limit ?? 10;

  // 1. Search authoritative knowledge via Everest RPC
  try {
    const authKnowledge = (await rpcCall(supabase, "everest_list_authoritative_knowledge")) as {
      knowledge?: Array<{
        knowledgeId: string;
        sourceId: string;
        title: string;
        statement: string;
        interpretation?: string;
        knowledgeType: string;
        jurisdiction?: string;
        industry?: string;
        version?: string;
        confidence?: number;
        status?: string;
        supersededBy?: string[];
      }>;
      sources?: Array<{
        sourceId: string;
        name: string;
        organization: string;
        authorityTier: string;
        sourceType: string;
        canonicalUrl?: string;
      }>;
    };

    if (authKnowledge?.knowledge) {
      const sourceMap = new Map(
        (authKnowledge.sources ?? []).map((s) => [s.sourceId, s]),
      );

      for (const k of authKnowledge.knowledge) {
        // Filter: only active items
        if (k.status && k.status !== "active") continue;
        if (k.supersededBy && k.supersededBy.length > 0) continue;

        // Filter by industry if specified
        if (options.industry && k.industry && k.industry !== options.industry) continue;

        // Filter by jurisdiction if specified
        if (options.jurisdiction && k.jurisdiction && !k.jurisdiction.includes(options.jurisdiction)) continue;

        // Keyword relevance score
        const searchText = `${k.title} ${k.statement} ${k.interpretation ?? ""} ${k.knowledgeType}`.toLowerCase();
        const score = terms.length > 0
          ? terms.filter((t) => searchText.includes(t)).length / terms.length
          : 0.5;

        if (score === 0 && terms.length > 0) continue;

        const source = sourceMap.get(k.sourceId);

        results.push({
          item: {
            id: k.knowledgeId,
            layer: "atlas_industry",
            sourceClassification: mapSourceTypeToClassification(source?.sourceType ?? "ATLAS_CURATED"),
            title: k.title,
            statement: k.statement,
            interpretation: k.interpretation,
            knowledgeType: k.knowledgeType,
            industry: k.industry,
            jurisdiction: k.jurisdiction,
            version: k.version,
            confidence: k.confidence ?? 0.7,
            status: "active",
            sourceId: k.sourceId,
            isInference: false,
          },
          relevance: Math.min(0.95, 0.4 + score * 0.5),
          retrievalMethod: "keyword",
          sourceClassification: mapSourceTypeToClassification(source?.sourceType ?? "ATLAS_CURATED"),
          layer: "atlas_industry",
          provenance: source
            ? {
                sourceId: source.sourceId,
                sourceName: source.name,
                organization: source.organization,
                authorityTier: source.authorityTier,
                canonicalUrl: source.canonicalUrl,
                sourceType: source.sourceType,
                status: "active",
              }
            : undefined,
        });
      }
    }
  } catch {
    // Authoritative knowledge RPC may not be deployed yet
  }

  // 2. Search intelligence packs
  try {
    const packs = (await rpcCall(supabase, "intelligence_list_pack_items")) as Array<{
      key?: string;
      title?: string;
      summary?: string;
      content?: unknown;
      itemType?: string;
      industry?: string;
      jurisdiction?: string;
      confidence?: number;
    }>;

    if (Array.isArray(packs)) {
      for (const p of packs) {
        if (options.industry && p.industry && p.industry !== options.industry) continue;
        if (options.jurisdiction && p.jurisdiction && !p.jurisdiction.includes(options.jurisdiction)) continue;

        const searchText = `${p.title ?? ""} ${p.summary ?? ""} ${p.itemType ?? ""}`.toLowerCase();
        const score = terms.length > 0
          ? terms.filter((t) => searchText.includes(t)).length / terms.length
          : 0.3;

        if (score === 0 && terms.length > 1) continue;

        results.push({
          item: {
            id: `pack:${p.key ?? "unknown"}`,
            layer: "atlas_industry",
            sourceClassification: "ATLAS_CURATED",
            title: p.title ?? "Untitled",
            statement: p.summary ?? "",
            knowledgeType: p.itemType ?? "terminology",
            industry: p.industry,
            jurisdiction: p.jurisdiction,
            confidence: p.confidence ?? 0.7,
            status: "active",
            isInference: false,
            tags: [p.itemType].filter(Boolean) as string[],
          },
          relevance: Math.min(0.85, 0.3 + score * 0.4),
          retrievalMethod: "keyword",
          sourceClassification: "ATLAS_CURATED",
          layer: "atlas_industry",
        });
      }
    }
  } catch {
    // Pack items may not be available
  }

  // 3. Search existing tenant documents (which may contain industry reference material)
  try {
    const docs = (await rpcCall(supabase, "documents_list_documents")) as Array<{
      _id: string;
      title?: string | null;
      summary?: string | null;
      classification?: string | null;
      status?: string | null;
    }>;

    const readyDocs = (docs ?? []).filter((d) => d.status === "ready");

    for (const d of readyDocs) {
      const searchText = `${d.title ?? ""} ${d.summary ?? ""} ${d.classification ?? ""}`.toLowerCase();
      const score = terms.length > 0
        ? terms.filter((t) => searchText.includes(t)).length / terms.length
        : 0.2;

      if (score === 0 && terms.length > 0) continue;

      results.push({
        item: {
          id: `doc:${d._id}`,
          layer: "atlas_industry",
          sourceClassification: classifyDocumentSource(d.classification),
          title: d.title ?? "Untitled document",
          statement: d.summary ?? "",
          knowledgeType: "document",
          confidence: 0.6,
          status: "active",
          documentId: d._id,
          isInference: false,
        },
        relevance: Math.min(0.8, 0.2 + score * 0.5),
        retrievalMethod: "keyword",
        sourceClassification: classifyDocumentSource(d.classification),
        layer: "atlas_industry",
      });
    }
  } catch {
    // Document search is best-effort
  }

  // Apply the training-manual authority floor BEFORE ranking. A trade manual
  // may be highly relevant while still being weak authority, so its relevance
  // is capped: it stays citable and available for training, but can never
  // outrank a current policy, regulatory, manufacturer or verified-evidence
  // source that also matched. Results are then sorted and trimmed.
  applyAuthorityFloor(results);

  // Sort by relevance and return top results
  results.sort((a, b) => b.relevance - a.relevance);
  return results.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a source type string to a SourceClassification. */
function mapSourceTypeToClassification(sourceType: string | undefined): SourceClassification {
  const t = (sourceType ?? "").toLowerCase();
  if (t.includes("regulation") || t.includes("official_licensing")) return "REGULATORY";
  if (t.includes("standard")) return "INDUSTRY_STANDARD";
  if (t.includes("industry_body")) return "PROFESSIONAL_GUIDANCE";
  if (t.includes("manufacturer")) return "MANUFACTURER";
  if (t.includes("insurance") || t.includes("carrier")) return "CARRIER_OR_INSURANCE";
  return "ATLAS_CURATED";
}

/** Classify a document based on its classification tag. */
function classifyDocumentSource(classification: string | null | undefined): SourceClassification {
  const c = (classification ?? "").toLowerCase();
  if (/(regulation|compliance|safety|osha|epa)/.test(c)) return "REGULATORY";
  if (/(standard|specification|code|guideline)/.test(c)) return "INDUSTRY_STANDARD";
  if (/(insurance|carrier|claim|adjuster)/.test(c)) return "CARRIER_OR_INSURANCE";
  if (/(manufacturer|installation|warranty|spec)/.test(c)) return "MANUFACTURER";
  if (/(sop|policy|procedure|company)/.test(c)) return "CUSTOMER_PROVIDED";
  if (/(estimate|invoice|photo|communication|report)/.test(c)) return "CUSTOMER_GENERATED";
  return "ATLAS_CURATED";
}

// ---------------------------------------------------------------------------
// Main Retrieval Entry Point
// ---------------------------------------------------------------------------

/**
 * Retrieve knowledge across all three Atlas layers for a given query.
 *
 * Combines:
 *   - Atlas industry knowledge (authoritative sources, packs, documents)
 *   - Knowledge layer filtering based on query intent
 *   - Relevance scoring with layer priority weighting
 *   - Deduplication and top-K selection
 *
 * Returns a KnowledgeContext ready for the reasoning engine.
 */
export async function retrieveKnowledge(
  supabase: SupabaseClient,
  query: string,
  options: KnowledgeRetrievalOptions = {},
): Promise<KnowledgeContext> {
  const intent = classifyIntent(query);
  const allResults: KnowledgeRetrievalResult[] = [];
  const limit = options.limit ?? 15;

  // Determine which layers to query based on intent and options
  const queryIndustry = intent.needsIndustryKnowledge;
  const queryCustomer = intent.needsCustomerKnowledge;
  const queryEvidence = intent.needsLiveEvidence;

  // Layer 1: Atlas Industry Knowledge
  if (queryIndustry && (!options.layers || options.layers.includes("atlas_industry"))) {
    const industryResults = await retrieveIndustryKnowledge(supabase, query, {
      ...options,
      layers: undefined, // already scoped
      limit: Math.ceil(limit * 0.5),
    });
    allResults.push(...industryResults);
  }

  // Layer 2: Customer Knowledge (tenant documents)
  if (queryCustomer && (!options.layers || options.layers.includes("customer"))) {
    try {
      const docs = (await rpcCall(supabase, "documents_list_documents")) as Array<{
        _id: string;
        title?: string | null;
        summary?: string | null;
        classification?: string | null;
        status?: string | null;
      }>;

      const readyDocs = (docs ?? []).filter((d) => d.status === "ready");
      const terms = tokens(query);

      for (const d of readyDocs.slice(0, 30)) {
        const searchText = `${d.title ?? ""} ${d.summary ?? ""}`.toLowerCase();
        const score = terms.length > 0
          ? terms.filter((t) => searchText.includes(t)).length / terms.length
          : 0.15;

        if (score === 0 && terms.length > 0) continue;

        allResults.push({
          item: {
            id: `customer:doc:${d._id}`,
            layer: "customer",
            sourceClassification: classifyDocumentSource(d.classification),
            title: d.title ?? "Untitled",
            statement: d.summary ?? "",
            knowledgeType: "document",
            confidence: 0.65,
            status: "active",
            documentId: d._id,
            isInference: false,
          },
          relevance: Math.min(0.85, 0.15 + score * 0.5),
          retrievalMethod: "keyword",
          sourceClassification: classifyDocumentSource(d.classification),
          layer: "customer",
        });
      }
    } catch {
      // Customer knowledge retrieval is best-effort
    }
  }

  // Layer 3: Live Company Evidence (claim candidates, insurance claims)
  if (queryEvidence && (!options.layers || options.layers.includes("live_evidence"))) {
    try {
      const candidates = (await rpcCall(supabase, "insurance_list_claim_candidates")) as Array<{
        _id: string;
        claimKey: string;
        claimNumber?: string | null;
        customer?: string | null;
        status?: string | null;
        confidence?: number | null;
      }>;

      for (const c of candidates ?? []) {
        allResults.push({
          item: {
            id: `evidence:candidate:${c._id}`,
            layer: "live_evidence",
            sourceClassification: "CUSTOMER_GENERATED",
            title: `Potential claim ${c.claimKey}`,
            statement: `Claim ${c.claimNumber ?? c.claimKey} — customer: ${c.customer ?? "unknown"}, status: ${c.status ?? "pending"}, confidence: ${Math.round((c.confidence ?? 0.5) * 100)}%`,
            knowledgeType: "claim_candidate",
            confidence: c.confidence ?? 0.5,
            status: c.status ?? "pending",
            isInference: false,
          },
          relevance: 0.7,
          retrievalMethod: "evidence",
          sourceClassification: "CUSTOMER_GENERATED",
          layer: "live_evidence",
        });
      }
    } catch {
      // Live evidence retrieval is best-effort
    }
  }

  // Apply layer priority weighting
  const weighted = allResults.map((r) => ({
    ...r,
    relevance: r.relevance * (KNOWLEDGE_LAYER_PRIORITY[r.layer] ?? 0.5),
  }));

  // Sort by weighted relevance
  weighted.sort((a, b) => b.relevance - a.relevance);

  // Deduplicate by item id
  const seen = new Set<string>();
  const deduped = weighted.filter((r) => {
    if (seen.has(r.item.id)) return false;
    seen.add(r.item.id);
    return true;
  });

  // Apply confidence filter
  const filtered = options.minConfidence
    ? deduped.filter((r) => r.item.confidence >= options.minConfidence!)
    : deduped;

  return buildKnowledgeContext(filtered.slice(0, limit));
}

/**
 * Build a context string for the AI reasoning layer from a KnowledgeContext.
 * This is what gets injected into the LLM prompt alongside evidence.
 */
export function buildKnowledgeContextString(context: KnowledgeContext): string {
  if (context.items.length === 0) return "";

  const lines: string[] = ["<atlas_knowledge>"];

  // Group by layer
  const byLayer: Record<KnowledgeLayer, KnowledgeRetrievalResult[]> = {
    atlas_industry: [],
    customer: [],
    live_evidence: [],
  };
  for (const item of context.items) {
    byLayer[item.layer].push(item);
  }

  for (const [layer, items] of Object.entries(byLayer) as [KnowledgeLayer, KnowledgeRetrievalResult[]][]) {
    if (items.length === 0) continue;

    lines.push(`\n--- ${layer === "atlas_industry" ? "Atlas Industry Knowledge" : layer === "customer" ? "Company Knowledge" : "Live Company Evidence"} ---`);

    for (const item of items.slice(0, 5)) {
      const sourceLabel = item.provenance
        ? ` [Source: ${item.provenance.sourceName} (${item.provenance.authorityTier})]`
        : ` [${item.sourceClassification}]`;
      lines.push(`- ${item.item.title}: ${item.item.statement}${sourceLabel}`);
      if (item.item.interpretation) {
        lines.push(`  Interpretation: ${item.item.interpretation}`);
      }
    }
  }

  lines.push("\n</atlas_knowledge>");
  return lines.join("\n");
}

/**
 * Get intent classification for a query (exported for use by the reasoning engine).
 */
export { classifyIntent as getIntentClassification };
