// ---------------------------------------------------------------------------
// Atlas Knowledge Layer — Public API
//
// Single entry point for all knowledge layer modules.
// ---------------------------------------------------------------------------

export * from "./types";
export {
  getEmbeddingsProvider,
  resetEmbeddingsProvider,
  generateEmbeddings,
  rankBySimilarity,
  cosine,
  keywordScore,
} from "./embeddings";
export {
  retrieveKnowledge,
  classifyIntent,
  buildKnowledgeContext,
  buildKnowledgeContextString,
  getIntentClassification,
} from "./retrieval";
export {
  ATLAS_INDUSTRY_KNOWLEDGE_SEED,
  ATLAS_KNOWLEDGE_PROVENANCE,
  INDUSTRY_TERMS,
  EVIDENCE_REQUIREMENTS,
  CLAIM_LIFECYCLE,
  RISK_PATTERNS,
  REVENUE_CONCEPTS,
  INDUSTRY_ROLES,
} from "./seed";
export {
  CORPUS_MANIFEST,
  CORPUS_PROVENANCE,
  FEDERAL_REGULATIONS,
  WORKFLOW_STAGES,
  DOCUMENTATION_EVIDENCE,
  JURISDICTION_PROFILES,
  STANDARDS_METADATA,
  CORPUS_RISKS,
  CORPUS_REVENUE,
  GRAPH_RELATIONSHIPS,
} from "./corpus";
export type {
  CorpusKnowledgeRecord,
  CorpusProvenanceRecord,
  CorpusGraphEdge,
} from "./corpus";
export {
  validateCorpus,
  normalizeCorpusToKnowledgeItems,
  normalizeCorpusProvenance,
  getValidatedGraphEdges,
  getIngestionReport,
} from "./corpus/importer";
export type { CorpusValidationResult } from "./corpus/importer";

// Christian Construction Insurance Education Manual — source registration,
// controlled vocabulary, and the guardrails that keep a trade training
// reference from being treated as a current legal/coverage authority.
export {
  TRAINING_MANUAL_SOURCE,
  TRAINING_MANUAL_SOURCE_ID,
  TRAINING_MANUAL_TAGS,
  TRAINING_MANUAL_DOMAINS,
  TRAINING_MANUAL_MAX_PRIORITY_RANK,
  OBSERVATION_LAYERS,
  CONDITION_CLASSIFICATIONS,
  CLAIM_ANALYSIS_SEQUENCE,
  EVIDENCE_STATUSES,
  FACT_PRESENTING_STATUSES,
  REGULATED_BOUNDARY_TOPICS,
  REGULATED_ROLES,
  RETRIEVAL_PRIORITY,
  PROHIBITED_PRACTICES,
  ATTRIBUTION_FORMS,
  OPERATIONAL_PRINCIPLE,
  OPTIMIZATION_OBJECTIVE,
  COVERAGE_DETERMINATION_REFUSAL,
  CONTENT_INGESTED,
  MISSING_INPUT,
  isTrainingManualSource,
  isTrainingManualClassification,
} from "./training-manual";
export type {
  TrainingManualTag,
  TrainingManualDomain,
  TrainingManualDomainId,
  TrainingManualIngestionState,
  ObservationLayerId,
  ConditionClassificationId,
  EvidenceStatusId,
} from "./training-manual";
export {
  validateTrainingManualItem,
  isProhibitedPracticeText,
  applyAuthorityFloor,
  isTrainingManualResult,
  requiresCurrentAuthorityVerification,
  isCoverageDeterminationRequest,
  renderForReasoning,
  formatProvenance,
  containsAnyPattern,
  TRAINING_MANUAL_RELEVANCE_CEILING,
  TRAINING_MANUAL_VOCABULARY,
  AUTHORITY_FLOOR_CONSISTENT,
  HISTORICAL_PREFIX,
  COVERAGE_DETERMINATION_HANDOFF,
} from "./training-manual-guardrails";
export type { GuardrailResult, GuardrailViolation, GuardrailSeverity } from "./training-manual-guardrails";

// PDF ingestion infrastructure for the training manual: page-aware extraction,
// scanned-page detection, an OCR provider seam, section detection, document
// deduplication, and the safety pipeline that routes every candidate through
// the existing guardrails. No manual content is present — the PDF is required.
export * from "./ingest";
