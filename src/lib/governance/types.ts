// ---------------------------------------------------------------------------
// Atlas Governance Engine — Core Types
//
// Defines the authority hierarchy, role boundaries, compliance evaluation,
// temporal intelligence, and governance gate that EVERY material Atlas action
// must pass before execution.
//
// Architecture:
//   AtlasWorkforce
//        ↓
//   Context Assembly
//        ↓
//   Knowledge / RAG
//        ↓
//   Reasoning Engine
//        ↓
//   ┌─────┴─────┐
//   │           │
//   │    GOVERNANCE GATE
//   │           │
//   └─────┬─────┘
//         ↓
//   Authorization
//         ↓
//      Action
//         ↓
//    Verification
//         ↓
//   Audit / Evidence
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Authority Hierarchy
// ---------------------------------------------------------------------------

/**
 * Ordered authority levels from highest to lowest.
 * When two sources conflict, the higher-authority source prevails.
 */
export type AuthorityLevel =
  | "applicable_law"
  | "binding_regulation"
  | "official_court_authority"
  | "official_regulator_guidance"
  | "official_building_code_authority"
  | "industry_standard"
  | "insurance_policy_language"
  | "carrier_specific_procedure"
  | "company_sop"
  | "historical_practice"
  | "general_ai_knowledge";

/** Numeric ranking for authority comparison (lower = more authoritative). */
export const AUTHORITY_RANK: Record<AuthorityLevel, number> = {
  applicable_law: 1,
  binding_regulation: 2,
  official_court_authority: 3,
  official_regulator_guidance: 4,
  official_building_code_authority: 5,
  industry_standard: 6,
  insurance_policy_language: 7,
  carrier_specific_procedure: 8,
  company_sop: 9,
  historical_practice: 10,
  general_ai_knowledge: 11,
};

/** Why this authority level applies — preserves the legal basis. */
export type AuthorityBasis =
  | "statute"
  | "regulation"
  | "case_law"
  | "agency_guidance"
  | "code_adopted"
  | "standard promulgated"
  | "policy_document"
  | "carrier_manual"
  | "company_policy"
  | "practice_history"
  | "model_inference";

// ---------------------------------------------------------------------------
// Role Boundary Engine
// ---------------------------------------------------------------------------

export type AtlasRole =
  | "restoration_contractor"
  | "estimator"
  | "project_manager"
  | "claims_administrator"
  | "insurance_adjuster"
  | "public_adjuster"
  | "policyholder"
  | "insurer"
  | "attorney"
  | "engineer"
  | "architect"
  | "remediation_professional"
  | "atlas";

export type ActionAuthorization =
  | "ALLOW"
  | "REVIEW_REQUIRED"
  | "LICENSED_PROFESSIONAL_REQUIRED"
  | "PROHIBITED"
  | "UNKNOWN";

export interface RoleBoundaryConstraint {
  /** The action being evaluated. */
  actionType: string;
  /** Which role is performing it. */
  performingRole: AtlasRole;
  /** Authorization decision. */
  authorization: ActionAuthorization;
  /** Why this decision was made. */
  reason: string;
  /** What knowledge source informed this. */
  sourceKnowledgeIds: string[];
  /** Whether a licensed professional must review before execution. */
  requiresLicensedProfessional: boolean;
  /** Specific license type required, if any. */
  requiredLicenseType?: string;
}

// ---------------------------------------------------------------------------
// Temporal Intelligence
// ---------------------------------------------------------------------------

export interface TemporalContext {
  /** The date of the loss/event. */
  lossDate?: number;
  /** The policy period start. */
  policyPeriodStart?: number;
  /** The policy period end. */
  policyPeriodEnd?: number;
  /** When the communication was sent. */
  communicationDate?: number;
  /** When a document was submitted. */
  submissionDate?: number;
  /** Current date for evaluation. */
  currentDate: number;
  /** State-specific statute of limitations, if known. */
  statuteOfLimitations?: number;
}

export interface TemporalRule {
  id: string;
  title: string;
  /** The effective date of this rule (epoch ms). */
  effectiveFrom: number;
  /** When this rule expires, if ever (epoch ms). */
  effectiveTo?: number;
  /** Version identifier. */
  version: string;
  /** What this rule supersedes, if anything. */
  supersedes?: string;
  /** What supersedes this rule, if anything. */
  supersededBy?: string;
  /** The rule content. */
  content: string;
  /** Jurisdiction this applies to. */
  jurisdiction: string;
}

// ---------------------------------------------------------------------------
// Knowledge Object (normalized, machine-queryable)
// ---------------------------------------------------------------------------

export interface KnowledgeObject {
  id: string;
  title: string;
  domain: string;
  subdomain?: string;
  authorityLevel: AuthorityLevel;
  authorityBasis: AuthorityBasis;
  sourceType: string;
  sourceName: string;
  sourceUrl?: string;
  citation: string;
  jurisdiction: string;
  jurisdictionType: "federal" | "state" | "county" | "municipality" | "international";
  effectiveFrom: number;
  effectiveTo?: number;
  version: string;
  applicability: string[];
  requirement: string;
  exceptions?: string[];
  prohibitedActions?: string[];
  requiredEvidence?: string[];
  relatedWorkflows?: string[];
  relatedRoles?: AtlasRole[];
  supersedes?: string;
  supersededBy?: string;
  verificationStatus:
    | "unverified"
    | "verified"
    | "stale"
    | "superseded"
    | "conflicted"
    | "retired";
  retrievedAt: number;
  verifiedAt?: number;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Knowledge Gap
// ---------------------------------------------------------------------------

export interface KnowledgeGap {
  id: string;
  /** What information is missing. */
  description: string;
  /** Why it matters for the current task. */
  impact: string;
  /** What source would resolve it. */
  suggestedSource?: string;
  /** Whether Atlas can continue safely without this knowledge. */
  canContinueSafely: boolean;
  /** Whether human review is required. */
  requiresHumanReview: boolean;
  /** The task or action that triggered this gap. */
  triggeredBy: string;
  /** Severity: critical means Atlas MUST stop. */
  severity: "critical" | "high" | "medium" | "low";
}

// ---------------------------------------------------------------------------
// Compliance Evaluation
// ---------------------------------------------------------------------------

export type ComplianceDecision = "ALLOW" | "REVIEW_REQUIRED" | "BLOCK" | "UNKNOWN";

export interface ComplianceContext {
  /** The action being evaluated. */
  actionType: string;
  /** Description of the action. */
  actionDescription: string;
  /** The claim this action relates to. */
  claimId?: string;
  /** The tenant/organization. */
  tenantId: string;
  /** The user triggering this. */
  userId?: string;
  /** The performing role. */
  performingRole: AtlasRole;
  /** Jurisdiction context. */
  jurisdiction?: string;
  /** Temporal context. */
  temporalContext: TemporalContext;
  /** Financial amount involved, if any. */
  financialAmount?: number;
  /** Documents/evidence involved. */
  involvedEvidence?: string[];
  /** External recipients. */
  externalRecipients?: string[];
}

export interface ComplianceResult {
  decision: ComplianceDecision;
  reason: string;
  applicableRules: KnowledgeObject[];
  applicableStandards: KnowledgeObject[];
  requiredEvidence: string[];
  requiredApproval?: string;
  roleConstraints: RoleBoundaryConstraint[];
  riskLevel: "none" | "low" | "medium" | "high" | "critical";
  knowledgeGaps: KnowledgeGap[];
  citations: string[];
  /** Trace of how the decision was reached. */
  evaluationTrace: string[];
}

// ---------------------------------------------------------------------------
// Governance Gate Result
// ---------------------------------------------------------------------------

export interface GovernanceGateResult {
  /** Whether the action may proceed. */
  allowed: boolean;
  /** The compliance evaluation. */
  compliance: ComplianceResult;
  /** Any knowledge gaps discovered. */
  knowledgeGaps: KnowledgeGap[];
  /** Role boundary constraints. */
  roleConstraints: RoleBoundaryConstraint[];
  /** Required approvals before execution. */
  requiredApprovals: string[];
  /** Evidence chain for audit. */
  evidenceChain: EvidenceChainLink[];
  /** Total evaluation time. */
  evaluationTimeMs: number;
}

// ---------------------------------------------------------------------------
// Evidence Graph
// ---------------------------------------------------------------------------

export type EvidenceChainNodeType =
  | "claim"
  | "fact"
  | "evidence"
  | "rule"
  | "standard"
  | "policy"
  | "calculation"
  | "recommendation"
  | "compliance_decision"
  | "action";

export interface EvidenceChainLink {
  id: string;
  type: EvidenceChainNodeType;
  /** Human-readable description. */
  description: string;
  /** Source knowledge or evidence ID. */
  sourceId?: string;
  /** Confidence in this link. */
  confidence: number;
  /** Timestamp. */
  timestamp: number;
  /** Parent link ID (for building chains). */
  parentLinkId?: string;
}

export interface EvidenceChain {
  id: string;
  claimId: string;
  /** Ordered chain from claim → action. */
  links: EvidenceChainLink[];
  /** Final compliance decision. */
  finalDecision: ComplianceDecision;
  /** Whether the chain is complete and traceable. */
  isComplete: boolean;
  /** Total confidence of the chain. */
  chainConfidence: number;
}

// ---------------------------------------------------------------------------
// Atlas Explanation (for every material recommendation)
// ---------------------------------------------------------------------------

export interface AtlasExplanation {
  /** What Atlas recommends. */
  what: string;
  /** Why Atlas recommends it. */
  why: string;
  /** What evidence supports it. */
  evidence: string[];
  /** What rules/standards apply. */
  rules: string[];
  /** How confident Atlas is (0-1). */
  confidence: number;
  /** What Atlas does not know. */
  limitations: string[];
  /** What Atlas can do. */
  action: string;
  /** Why a human may need to intervene. */
  humanReviewReason?: string;
}

// ---------------------------------------------------------------------------
// Knowledge Acquisition Pipeline
// ---------------------------------------------------------------------------

export type PipelineStage =
  | "source_discovery"
  | "source_ingestion"
  | "document_parsing"
  | "metadata_extraction"
  | "jurisdiction_classification"
  | "authority_classification"
  | "effective_date_extraction"
  | "content_extraction"
  | "rule_extraction"
  | "applicability_analysis"
  | "conflict_detection"
  | "human_verification_review"
  | "knowledge_object_creation"
  | "index";

export interface PipelineRecord {
  id: string;
  sourceUrl: string;
  sourceName: string;
  currentStage: PipelineStage;
  completedStages: PipelineStage[];
  startedAt: number;
  completedAt?: number;
  error?: string;
  /** The resulting knowledge objects. */
  knowledgeObjectIds: string[];
  /** Provenance chain. */
  provenance: string[];
}
