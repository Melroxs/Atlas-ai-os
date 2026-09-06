// ---------------------------------------------------------------------------
// Atlas Regulatory Intelligence — Core Types
//
// A source-grounded, evidence-first layer for U.S. insurance restoration
// regulatory knowledge. Primary authority is captured, verified, normalized,
// versioned, and attached to every regulatory proposition. Secondary sources
// are used ONLY for discovery — they can never become controlling authority.
//
// Design principles:
//   - Tier 1-4 authority hierarchy (primary → interpretive → industry → secondary)
//   - Every proposition has provenance (source → citation → text)
//   - Temporal versioning: effective_from/effective_to windows, never overwrite
//   - Verification is a state machine; UNVERIFIED is the default, never "verified
//     because a model believes it"
//   - Contradictions are explicit records, never silently resolved
//   - Freshness is source-type and jurisdiction aware
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Jurisdictions
// ---------------------------------------------------------------------------

export type JurisdictionType = "state" | "district";

export interface Jurisdiction {
  /** Postal code: AL..WY plus DC. */
  jurisdictionId: string;
  jurisdictionType: JurisdictionType;
  /** State code (postal). */
  stateCode: string;
  /** Full name. */
  name: string;
  /** Active flag. */
  active: boolean;
  /** Official insurance department homepage (registry metadata — UNVERIFIED until fetched). */
  officialInsuranceDepartmentUrl?: string;
  /** Official legislature / statutes portal. */
  officialLegislatureUrl?: string;
  /** Official administrative code portal. */
  officialAdminCodeUrl?: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Authority tiers
// ---------------------------------------------------------------------------

/**
 * Tier 1 — Controlling / Primary Authority
 *   enacted statutes, administrative codes/regulations, official insurance
 *   department publications, official bulletins/orders, controlling judicial
 *   decisions, applicable federal statutes/regulations.
 *
 * Tier 2 — Official Interpretive / Regulatory Material
 *   regulator guidance, official FAQs, bulletins, consumer guidance,
 *   enforcement materials, official interpretations.
 *
 * Tier 3 — Authoritative Industry / Standards Sources
 *   NAIC model laws, IICRC standards, NFIP/FEMA materials, recognized
 *   industry standards. NEVER automatically state law.
 *
 * Tier 4 — Secondary Research Sources
 *   discovery/corroboration only. Never controlling.
 */
export type AuthorityTier = 1 | 2 | 3 | 4;

export const AUTHORITY_TIER_NAMES: Record<AuthorityTier, string> = {
  1: "Tier 1 — Primary / Controlling",
  2: "Tier 2 — Official Interpretive",
  3: "Tier 3 — Industry / Standards",
  4: "Tier 4 — Secondary Research",
};

export const AUTHORITY_TIER_LABELS: Record<AuthorityTier, string> = {
  1: "primary",
  2: "interpretive",
  3: "industry",
  4: "secondary",
};

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type SourceType =
  | "statute"
  | "regulation"
  | "administrative_code"
  | "regulator_bulletin"
  | "regulator_guidance"
  | "regulator_order"
  | "court_decision"
  | "federal_statute"
  | "federal_regulation"
  | "model_law"
  | "industry_standard"
  | "government_manual"
  | "secondary_reference"
  | "consumer_guidance";

export const SOURCE_TYPE_TIERS: Record<SourceType, AuthorityTier> = {
  statute: 1,
  regulation: 1,
  administrative_code: 1,
  regulator_bulletin: 1,
  regulator_order: 1,
  court_decision: 1,
  federal_statute: 1,
  federal_regulation: 1,
  regulator_guidance: 2,
  government_manual: 2,
  consumer_guidance: 2,
  model_law: 3,
  industry_standard: 3,
  secondary_reference: 4,
};

export type SourceStatus =
  | "REGISTERED" // registry entry exists, not yet fetched
  | "DISCOVERED" // found via discovery adapter
  | "FETCHED" // content retrieved
  | "PARSED" // content parsed to text
  | "EXTRACTED" // propositions extracted
  | "VERIFIED" // verified against the source itself
  | "FAILED" // fetch/parse failed
  | "SUPERSEDED" // replaced by a newer source
  | "STALE"; // last verified too long ago for its class

export interface RegulatorySource {
  sourceId: string;
  /** Null for federal sources. */
  jurisdictionId: string | null;
  sourceType: SourceType;
  /** Derived from source type; never manually set below a primary type's tier. */
  authorityTier: AuthorityTier;
  publisher: string;
  title: string;
  /** Canonical official URL. */
  canonicalUrl?: string;
  /** Publisher's own identifier (statute chapter, CFR part, bulletin no., etc.). */
  sourceIdentifier?: string;
  /** Human citation string, e.g. "Fla. Stat. § 626.9541". */
  citation?: string;
  documentDate?: number;
  effectiveDate?: number;
  expirationDate?: number;
  retrievedAt?: number;
  lastVerifiedAt?: number;
  contentHash?: string;
  /** Source status in the acquisition state machine. */
  status: SourceStatus;
  /** 0-1; default by tier. */
  reliabilityScore: number;
  /** Whether the URL currently resolves (last check). */
  accessibilityStatus: "unknown" | "reachable" | "unreachable";
  supersedesSourceId?: string;
  supersededBySourceId?: string;
  /** Discovery provenance: the secondary source that led us here. */
  discoverySourceId?: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Regulatory propositions
// ---------------------------------------------------------------------------

export type VerificationStatus =
  | "DISCOVERED"
  | "FETCHED"
  | "EXTRACTED"
  | "UNVERIFIED"
  | "VERIFIED"
  | "PARTIALLY_VERIFIED"
  | "CONTRADICTED"
  | "SUPERSEDED"
  | "STALE"
  | "FAILED"
  | "NEEDS_HUMAN_REVIEW"
  /** No authoritative source located for this rule area. Never equals "does not exist". */
  | "INSUFFICIENT_EVIDENCE";

/** Knowledge-state for a supplement-related rule area (never assume a law exists). */
export type SupplementRegulationState =
  | "explicitly_regulated"
  | "indirectly_regulated"
  | "no_identified_specific_provision"
  | "insufficient_evidence"
  | "research_incomplete";

export type ActorType =
  | "insurer"
  | "insured"
  | "contractor"
  | "restoration_contractor"
  | "public_adjuster"
  | "independent_adjuster"
  | "attorney"
  | "mortgagee"
  | "third_party"
  | "regulator";

export type DeadlineUnit = "hours" | "business_days" | "calendar_days" | "months" | "years" | "none";

export interface RegulatoryProposition {
  propositionId: string;
  jurisdictionId: string;
  /** Which version of the source this proposition was extracted from. */
  sourceId: string;
  topic: string;
  subtopic?: string;
  /** The rule text as the source states it (normalized whitespace, verbatim). */
  ruleText: string;
  /** Normalized machine-readable form, e.g. "insurer must respond within 14 days". */
  normalizedRule?: string;
  applicability?: string;
  actor: ActorType;
  claimPhase: string;
  peril?: string;
  insuranceType?: string;
  /** Triggering condition. */
  trigger?: string;
  requirement?: string;
  prohibition?: string;
  exception?: string;
  deadline?: number;
  deadlineUnit?: DeadlineUnit;
  condition?: string;
  effectiveFrom?: number;
  effectiveTo?: number;
  citation?: string;
  authorityTier: AuthorityTier;
  confidence: number;
  verificationStatus: VerificationStatus;
  lastVerifiedAt?: number;
  /** Supplement-intelligence state (critical Atlas distinction). */
  supplementState?: SupplementRegulationState;
  /** Deterministic dedupe key: jurisdiction|topic|actor|normalizedRule hash.
   *  Cross-source dedup — two sources stating the same rule share a key. */
  dedupKey: string;
  /** Version-chain identity: jurisdictionId|sourceId|topic. All versions of
   *  the same rule from the same source share this key. */
  lineageKey: string;
  /** Version chain: first version has version=1 and no previousVersionId. */
  version: number;
  previousVersionId?: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Contradictions
// ---------------------------------------------------------------------------

export type ContradictionKind =
  | "secondary_vs_primary"
  | "primary_vs_primary"
  | "old_vs_new_regulation"
  | "superseded_source"
  | "effective_date_overlap"
  | "state_vs_model_law"
  | "extraction_vs_source_text";

export type ContradictionSeverity = "HIGH" | "MEDIUM" | "LOW";

export interface RegulatoryContradiction {
  contradictionId: string;
  kind: ContradictionKind;
  jurisdictionId?: string;
  propositionAId?: string;
  propositionBId?: string;
  sourceAId: string;
  sourceBId: string;
  /** Human-readable description of the conflict. */
  detail: string;
  severity: ContradictionSeverity;
  /** Always unresolved until a human (or explicit documented decision) resolves it. */
  status: "OPEN" | "RESOLVED";
  resolution?: string;
  resolvedById?: string;
  resolvedAt?: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Acquisition jobs
// ---------------------------------------------------------------------------

export type AcquisitionStage =
  | "DISCOVERY"
  | "FETCH"
  | "PARSE"
  | "CLASSIFY"
  | "EXTRACT"
  | "NORMALIZE"
  | "RESOLVE_CITATION"
  | "VERIFY"
  | "VERSION"
  | "INDEX"
  | "EMBED"
  | "QUALITY_CHECK"
  | "PUBLISH";

export type AcquisitionJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "partial"
  | "cancelled";

export interface AcquisitionJob {
  jobId: string;
  jurisdictionId?: string;
  sourceId?: string;
  stage: AcquisitionStage;
  startedAt?: number;
  completedAt?: number;
  status: AcquisitionJobStatus;
  error?: string;
  retryCount: number;
  contentHash?: string;
  previousHash?: string;
  changeDetected: boolean;
  /** Who/what initiated the job. */
  initiatedBy: string;
  /** AI provider used (empty = deterministic only, no AI spend). */
  modelUsed?: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

export type FreshnessLevel = "CURRENT" | "RECENT" | "AGING" | "STALE" | "UNKNOWN";

export interface FreshnessScore {
  sourceId: string;
  level: FreshnessLevel;
  /** Days since last verification. */
  ageDays: number | null;
  /** Suggested re-verification interval (days) for this source class. */
  intervalDays: number;
  nextCheckAt: number | null;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export interface RegulatoryRetrievalOptions {
  jurisdictionId: string;
  /** Claim-relevant date (loss date / evaluation date). Defaults to now. */
  asOfDate?: number;
  /** Restrict to specific actors. */
  actors?: ActorType[];
  /** Restrict to specific topics. */
  topics?: string[];
  /** Restrict to specific claim phases. */
  claimPhases?: string[];
  /** Minimum authority tier to include (1 = primary only). */
  minAuthorityTier?: AuthorityTier;
  /** Minimum confidence (0-1). */
  minConfidence?: number;
  /** Only include propositions whose verification is at least this strong. */
  minVerification?: VerificationStatus;
  /** Exclude INSUFFICIENT_EVIDENCE/UNVERIFIED results. */
  verifiedOnly?: boolean;
  limit?: number;
}

export interface RegulatoryRetrievalResult {
  proposition: RegulatoryProposition;
  source: RegulatorySource;
  /** 0-1 relevance for ranking. */
  relevance: number;
  /** Why this rule was returned. */
  matchedBy: string[];
}

// ---------------------------------------------------------------------------
// Regulatory answer contract
// ---------------------------------------------------------------------------

export interface RegulatoryRuleAnswer {
  jurisdictionId: string;
  question?: string;
  rules: RegulatoryRetrievalResult[];
  exceptions: RegulatoryProposition[];
  contradictions: RegulatoryContradiction[];
  uncertainties: string[];
  sourceTrace: Array<{
    propositionId: string;
    sourceId: string;
    title: string;
    publisher: string;
    canonicalUrl?: string;
    citation?: string;
    effectiveFrom?: number;
    effectiveTo?: number;
    authorityTier: AuthorityTier;
    verificationStatus: VerificationStatus;
    confidence: number;
  }>;
  /** User-facing caveat for high-risk outputs. */
  caveat?: string;
}

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

export interface JurisdictionCoverage {
  jurisdictionId: string;
  /** 0-100 configured acquisition/verification coverage, NOT legal completeness. */
  regulatoryIntelligenceCoverageScore: number;
  dimensions: Record<string, number>;
  /** Human status derived from the score. */
  status: "READY" | "PARTIAL" | "NEEDS_REVIEW" | "RESEARCH_INCOMPLETE";
  sourceCount: number;
  verifiedPropositionCount: number;
  unverifiedPropositionCount: number;
  contradictionCount: number;
  supplementState?: SupplementRegulationState;
  /** Topics with zero verified propositions (honest gaps). */
  gaps: string[];
  lastAcquisitionAt?: number;
  freshness: FreshnessLevel;
}