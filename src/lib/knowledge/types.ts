// ---------------------------------------------------------------------------
// Atlas Knowledge Layer — Core Types
//
// Defines the three-layer knowledge architecture:
//   Layer 1: Atlas Industry Knowledge (shared, global)
//   Layer 2: Customer Knowledge (tenant-isolated, company-specific)
//   Layer 3: Live Company Evidence (captured through Atlas operations)
//
// Every knowledge item carries provenance, source classification, and a
// knowledge layer tag so the reasoning engine can distinguish facts from
// inference and company evidence from industry reference.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Knowledge Layers
// ---------------------------------------------------------------------------

/**
 * The three distinct knowledge layers in Atlas.
 * Knowledge priority: live_evidence > customer > atlas_industry > model
 */
export type KnowledgeLayer = "atlas_industry" | "customer" | "live_evidence";

/** Priority weight for each layer (higher = more authoritative in retrieval). */
export const KNOWLEDGE_LAYER_PRIORITY: Record<KnowledgeLayer, number> = {
  live_evidence: 1.0,
  customer: 0.85,
  atlas_industry: 0.7,
};

/** Human-readable label for each layer. */
export const KNOWLEDGE_LAYER_LABELS: Record<KnowledgeLayer, string> = {
  atlas_industry: "Atlas Industry Knowledge",
  customer: "Company Knowledge",
  live_evidence: "Live Company Evidence",
};

// ---------------------------------------------------------------------------
// Source Classification
// ---------------------------------------------------------------------------

/**
 * Source classification model. Every knowledge item is tagged with its source
 * type so the reasoning layer can evaluate authority and relevance.
 */
export type SourceClassification =
  | "INDUSTRY_STANDARD"
  | "REGULATORY"
  | "CARRIER_OR_INSURANCE"
  | "MANUFACTURER"
  | "PROFESSIONAL_GUIDANCE"
  | "TRAINING_MANUAL"
  | "ATLAS_CURATED"
  | "CUSTOMER_PROVIDED"
  | "CUSTOMER_GENERATED"
  | "MODEL_INFERENCE";

/** Source classification metadata. */
export interface SourceClassificationMeta {
  classification: SourceClassification;
  label: string;
  description: string;
  defaultConfidence: number;
}

export const SOURCE_CLASSIFICATIONS: Record<SourceClassification, SourceClassificationMeta> = {
  INDUSTRY_STANDARD: {
    classification: "INDUSTRY_STANDARD",
    label: "Industry Standard",
    description: "Industry standards and recognized professional guidance (IICRC, NFPA, ICC, ASHRAE).",
    defaultConfidence: 0.85,
  },
  REGULATORY: {
    classification: "REGULATORY",
    label: "Regulatory",
    description: "Government/regulatory material (OSHA, EPA, state licensing bodies).",
    defaultConfidence: 0.9,
  },
  CARRIER_OR_INSURANCE: {
    classification: "CARRIER_OR_INSURANCE",
    label: "Carrier / Insurance",
    description: "Insurance-related reference material where legally and appropriately usable.",
    defaultConfidence: 0.75,
  },
  MANUFACTURER: {
    classification: "MANUFACTURER",
    label: "Manufacturer",
    description: "Manufacturer installation/specification documentation.",
    defaultConfidence: 0.8,
  },
  PROFESSIONAL_GUIDANCE: {
    classification: "PROFESSIONAL_GUIDANCE",
    label: "Professional Guidance",
    description: "Professional organizations and recognized industry guidance (RIA, CLM).",
    defaultConfidence: 0.7,
  },
  // A trade-published training/education manual. Deliberately the LOWEST
  // authority tier of any non-inference source: it is a training reference,
  // never a current legal, regulatory, coverage or carrier requirement.
  // It must not override policy documents, building codes, manufacturer
  // documentation or verified claim evidence.
  TRAINING_MANUAL: {
    classification: "TRAINING_MANUAL",
    label: "Training Manual",
    description:
      "Trade-published training and education manual. Conceptual training value only; not a current legal, regulatory, coverage, pricing or carrier-requirement authority.",
    defaultConfidence: 0.55,
  },
  ATLAS_CURATED: {
    classification: "ATLAS_CURATED",
    label: "Atlas Curated",
    description: "Knowledge intentionally curated and approved by Atlas.",
    defaultConfidence: 0.75,
  },
  CUSTOMER_PROVIDED: {
    classification: "CUSTOMER_PROVIDED",
    label: "Company Documentation",
    description: "Company-specific documentation (SOPs, policies, procedures).",
    defaultConfidence: 0.7,
  },
  CUSTOMER_GENERATED: {
    classification: "CUSTOMER_GENERATED",
    label: "Generated Evidence",
    description: "Evidence generated through company operations (claims, photos, communications).",
    defaultConfidence: 0.8,
  },
  MODEL_INFERENCE: {
    classification: "MODEL_INFERENCE",
    label: "AI Inference",
    description: "Information inferred by the AI rather than directly sourced.",
    defaultConfidence: 0.4,
  },
};

// ---------------------------------------------------------------------------
// Document Ingestion Status
// ---------------------------------------------------------------------------

export type IngestionStatus =
  | "uploaded"
  | "processing"
  | "parsed"
  | "indexed"
  | "needs_review"
  | "approved"
  | "published"
  | "archived"
  | "failed";

export const INGESTION_STATUS_LABELS: Record<IngestionStatus, string> = {
  uploaded: "Uploaded",
  processing: "Processing",
  parsed: "Parsed",
  indexed: "Indexed",
  needs_review: "Needs Review",
  approved: "Approved",
  published: "Published",
  archived: "Archived",
  failed: "Failed",
};

// ---------------------------------------------------------------------------
// Knowledge Items
// ---------------------------------------------------------------------------

/**
 * Temporal scope of a knowledge statement.
 *
 * `historical_context` marks information that was true when its source was
 * written but must never be presented as current without independent
 * verification against a current authoritative source. Trade manuals
 * frequently embed industry statistics from their publication year; those
 * are training context, not current market conditions.
 */
export type TemporalScope = "current" | "historical_context";

/**
 * Page- or section-level pointer back into a source document.
 *
 * Document-level provenance (`KnowledgeProvenance`) answers "which source";
 * this answers "where in it". Every statement ingested from a paged document
 * should carry one so answers can cite the relevant page or heading.
 */
export interface KnowledgeLocator {
  /** 1-indexed page number within the source document. */
  page?: number;
  /** Section, chapter or heading name. */
  section?: string;
  /** Short quoted or paraphrased anchor text used to locate the statement. */
  excerpt?: string;
}

/** A single piece of knowledge in the Atlas knowledge layer. */
export interface KnowledgeItem {
  id: string;
  /** The knowledge layer this belongs to. */
  layer: KnowledgeLayer;
  /** Source classification for authority evaluation. */
  sourceClassification: SourceClassification;
  /** Human-readable title. */
  title: string;
  /** The knowledge statement (what the source says). */
  statement: string;
  /** Atlas's operational interpretation (what it means for the company). */
  interpretation?: string;
  /** Type of knowledge (requirement, standard, guidance, terminology, etc.). */
  knowledgeType: string;
  /** Industry this applies to (insurance restoration, construction, etc.). */
  industry?: string;
  /** Jurisdiction where this applies (United States, United States > Florida). */
  jurisdiction?: string;
  /** Publication version of the source. */
  version?: string;
  /** Confidence score 0-1 for this knowledge item. */
  confidence: number;
  /** Status (active, superseded, draft, archived). */
  status: string;
  /** Timestamp when this was published. */
  publishedAt?: number;
  /** Timestamp when this was last updated. */
  updatedAt?: number;
  /** Reference to the authoritative source (for atlas_industry layer). */
  sourceId?: string;
  /** Reference to the tenant (for customer layer). */
  tenantId?: string;
  /** Reference to the source document (if ingested from a document). */
  documentId?: string;
  /** Whether this is an inference vs direct source knowledge. */
  isInference: boolean;
  /** Tags for categorization. */
  tags?: string[];
  /**
   * Whether this statement is current or historical training context.
   * Defaults to "current" when omitted.
   */
  temporalScope?: TemporalScope;
  /** Page/section pointer back into the source document. */
  locator?: KnowledgeLocator;
  /**
   * Whether this item is a confirmed finding backed by evidence, or a
   * proposal/potential item that still warrants investigation.
   * See CONFIRMED_VS_PROPOSED in ./training-manual for the controlled
   * vocabulary.
   */
  evidenceStatus?: string;
}

/** Provenance for a knowledge item — answers "Where did this come from?" */
export interface KnowledgeProvenance {
  /** Source identifier. */
  sourceId: string;
  /** Source name (e.g., "IICRC S500 — Standard for Water Damage Restoration"). */
  sourceName: string;
  /** Issuing organization. */
  organization: string;
  /** Authority tier for ranking. */
  authorityTier: string;
  /** Canonical URL for the source. */
  canonicalUrl?: string;
  /** Source type (regulation, standard, industry_body, etc.). */
  sourceType: string;
  /** Publication date (epoch ms). */
  publicationDate?: number;
  /** When this was retrieved/indexed by Atlas (epoch ms). */
  retrievalDate?: number;
  /** Effective date (epoch ms). */
  effectiveDate?: number;
  /** Version string. */
  version?: string;
  /** Current status. */
  status: string;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/** A retrieval result from the knowledge layer. */
export interface KnowledgeRetrievalResult {
  /** The knowledge item. */
  item: KnowledgeItem;
  /** Relevance score 0-1. */
  relevance: number;
  /** Which retrieval method found this (semantic, keyword, metadata, graph). */
  retrievalMethod: "semantic" | "keyword" | "metadata" | "graph" | "evidence";
  /** Source classification for UI display. */
  sourceClassification: SourceClassification;
  /** Knowledge layer. */
  layer: KnowledgeLayer;
  /** Provenance (if available). */
  provenance?: KnowledgeProvenance;
  /** Snippet of matched content. */
  snippet?: string;
  /**
   * Temporal scope carried through from the item. Results whose scope is
   * `historical_context` must be surfaced to the model with an explicit
   * historical marker — never restated as a current fact.
   */
  temporalScope?: TemporalScope;
  /** Page/section pointer, when the source document is paged. */
  locator?: KnowledgeLocator;
  /** Confirmed finding vs. proposed/potential item. */
  evidenceStatus?: string;
}

/** Context built from retrieved knowledge for the AI reasoning layer. */
export interface KnowledgeContext {
  /** Retrieved knowledge items, ordered by relevance. */
  items: KnowledgeRetrievalResult[];
  /** Knowledge layer counts. */
  layerCounts: Record<KnowledgeLayer, number>;
  /** Total items retrieved. */
  totalItems: number;
  /** Whether any items had provenance. */
  hasProvenance: boolean;
  /** Industries represented. */
  industries: string[];
  /** Jurisdictions represented. */
  jurisdictions: string[];
}

/** Retrieval options / filters. */
export interface KnowledgeRetrievalOptions {
  /** Restrict to specific knowledge layers. */
  layers?: KnowledgeLayer[];
  /** Restrict to specific source classifications. */
  sourceClassifications?: SourceClassification[];
  /** Restrict to specific industry. */
  industry?: string;
  /** Restrict to specific jurisdiction. */
  jurisdiction?: string;
  /** Restrict to specific tenant (for customer layer). */
  tenantId?: string;
  /** Only include published/approved items. */
  publishedOnly?: boolean;
  /** Maximum number of results. */
  limit?: number;
  /** Minimum confidence threshold. */
  minConfidence?: number;
}

// ---------------------------------------------------------------------------
// Intent Classification
// ---------------------------------------------------------------------------

/** Query intents that determine which retrieval strategy to use. */
export type KnowledgeIntent =
  | "explain"
  | "find_evidence"
  | "identify_missing_evidence"
  | "compare_documents"
  | "identify_contradiction"
  | "explain_industry_concept"
  | "identify_requirement"
  | "recommend_next_action"
  | "summarize_claim"
  | "explain_supplement_support"
  | "identify_supporting_documentation"
  | "knowledge_search";

/** Classification of a user query into a knowledge intent. */
export interface KnowledgeIntentClassification {
  intent: KnowledgeIntent;
  confidence: number;
  /** Whether this intent benefits from industry knowledge. */
  needsIndustryKnowledge: boolean;
  /** Whether this intent benefits from customer knowledge. */
  needsCustomerKnowledge: boolean;
  /** Whether this intent benefits from live evidence. */
  needsLiveEvidence: boolean;
}

// ---------------------------------------------------------------------------
// Embeddings Provider
// ---------------------------------------------------------------------------

/** Interface for an embeddings provider. Implementations may be local
 * (deterministic fallback) or external (Gemini, OpenAI, etc.). */
export interface EmbeddingsProvider {
  /** Provider name. */
  name: string;
  /** Dimension of embedding vectors. */
  dimension: number;
  /** Generate embedding(s) for text input(s). */
  embed(texts: string[]): Promise<number[][]>;
  /** Whether this provider is configured and available. */
  isAvailable(): boolean;
}

/** Knowledge source configuration for the ingestion pipeline. */
export interface KnowledgeSourceConfig {
  /** Unique source identifier. */
  sourceId: string;
  /** Human-readable name. */
  name: string;
  /** Issuing organization. */
  organization: string;
  /** Source classification. */
  classification: SourceClassification;
  /** Industry focus. */
  industry?: string;
  /** Jurisdiction. */
  jurisdiction?: string;
  /** Canonical URL. */
  canonicalUrl?: string;
  /** How to retrieve updates. */
  retrievalMethod: string;
  /** Whether this source is enabled for retrieval. */
  enabled: boolean;
  /** Authority tier. */
  authorityTier: string;
}
