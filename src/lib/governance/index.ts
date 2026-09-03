// ---------------------------------------------------------------------------
// Atlas Governance Engine — Barrel Export
//
// Single entry point for the governance layer. Import from "@/lib/governance"
// to access the governance gate, authority hierarchy, jurisdiction resolution,
// role boundaries, and the corpus-backed knowledge source.
//
//   AtlasWorkforce
//        ↓
//   Context Assembly
//        ↓
//   Knowledge / RAG
//        ↓
//   Reasoning Engine
//        ↓
//   GOVERNANCE GATE  ← every material action passes through here
//        ↓
//   Authorization
//        ↓
//      Action
//        ↓
//   Verification
//        ↓
//   Evidence / Audit
// ---------------------------------------------------------------------------

export * from "./types";

export {
  compareAuthority,
  sortByAuthority,
  filterEffectiveAt,
  filterActive,
  resolveApplicableKnowledge,
  isRuleActive,
  selectRuleVersion,
  buildTemporalContext,
  isWithinStatuteOfLimitations,
} from "./authority";

export {
  resolveJurisdiction,
  extractStateFromJurisdiction,
  extractStateFromProperty,
  type ResolvedJurisdiction,
} from "./jurisdiction";

export {
  evaluateRoleBoundary,
  getProhibitedActions,
  getReviewRequiredActions,
  checkKnowledgeGapImpact,
  type ActionType,
} from "./role-boundary";

export {
  evaluateCompliance,
  createInMemoryKnowledgeSource,
  type KnowledgeSource,
} from "./compliance";

export {
  executeGovernanceGate,
  gateCommunication,
  gateSupplement,
  gateFinancial,
  buildExplanation,
} from "./governance-gate";

export {
  createCorpusKnowledgeSource,
  corpusToKnowledgeObjects,
  seedToKnowledgeObjects,
  buildDefaultGovernanceKnowledgeSource,
} from "./knowledge-source";

export {
  GOVERNANCE_ENGINE_VERSION,
  KNOWLEDGE_CORPUS_VERSION,
  buildDedupKey,
  buildGovernanceRecord,
  persistGovernanceDecision,
  getGovernanceDecision,
  listGovernanceDecisions,
  getLatestGovernanceDecision,
  listActionableGovernance,
  listGovernanceEvents,
  decideGovernanceDecision,
  type GovernanceRecordInput,
  type PersistOutcome,
  type GovernanceDecisionRow,
  type GovernanceEventRow,
} from "./persistence";