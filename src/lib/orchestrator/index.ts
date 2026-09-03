// ---------------------------------------------------------------------------
// Atlas Workforce Orchestrator — Barrel Export
// ---------------------------------------------------------------------------

export {
  AtlasWorkforce,
  getAtlasWorkforce,
  createReviewClaimRequest,
  createPrepareSupplementRequest,
  createDraftCommunicationRequest,
} from "./atlas-workforce";

export type {
  OrchestrationRequest,
  OrchestrationResult,
  TaskResult,
  WorkItem,
  EvidenceRecord,
  CommunicationRecord,
  DeadlineRecord,
  ClaimIntelligenceReport,
  CommandType,
  TaskCategory,
  TaskPriority,
  TaskStatus,
  CapabilityDomain,
  GovernanceSummary,
} from "./types";

export {
  generateEstimateLineItems,
  buildEstimateSummary,
  type EstimateLineItem,
  type EstimateSummary,
  type LineItemCategory,
  type LineItemStatus,
} from "./estimator";
