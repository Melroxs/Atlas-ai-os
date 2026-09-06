export const WAVE_1_CODES = [
  "FL",
  "TX",
  "CA",
  "NY",
  "CO",
  "MD",
  "GA",
  "LA",
  "AZ",
  "WA",
] as const;

export type Wave1Code = (typeof WAVE_1_CODES)[number];

export const RESEARCH_TOPICS = [
  "notice_of_loss",
  "acknowledgment",
  "investigation",
  "inspection",
  "coverage_determination",
  "claim_decision",
  "payment",
  "denial",
  "partial_denial",
  "proof_of_loss",
  "claim_documentation",
  "communication_requirements",
  "claim_records",
  "unfair_claims_practices",
  "bad_faith",
  "complaint_procedures",
  "supplemental_claims",
  "additional_damage",
  "reopened_claims",
  "supplemental_deadlines",
  "documentation_requirements",
  "carrier_response_requirements",
  "proof_requirements",
  "estimate_change_order_requirements",
  "dispute_procedures",
  "appraisal",
  "mediation",
  "pre_suit_requirements",
  "litigation_requirements",
  "dispute_deadlines",
  "filing_deadlines",
  "statute_of_limitations",
  "contractor_licensing",
  "restoration_contracting",
  "contract_requirements",
  "cancellation_rights",
  "solicitation",
  "advertising",
  "disclosures",
  "deductible_restrictions",
  "rebates",
  "inducements",
  "assignment_of_benefits",
  "direction_to_pay",
  "contractor_representation",
  "prohibited_practices",
  "public_adjuster_licensing",
  "public_adjuster_fees",
  "public_adjuster_fee_limits",
  "public_adjuster_contracts",
  "public_adjuster_disclosures",
  "public_adjuster_cancellation",
  "public_adjuster_solicitation",
  "catastrophe_rules",
  "recordkeeping",
  "hurricane",
  "wind",
  "hail",
  "storm",
  "flood",
  "fire",
  "smoke",
  "water",
  "mold",
  "roof",
] as const;

export type ResearchTopic = (typeof RESEARCH_TOPICS)[number];
export type SourceKind =
  | "state_insurance_department"
  | "state_legislature"
  | "administrative_code"
  | "official_bulletin"
  | "official_guidance"
  | "official_order"
  | "official_court"
  | "federal"
  | "secondary";
export type AuthorityTier =
  | "current_enacted_statute"
  | "current_administrative_regulation"
  | "official_regulator_material"
  | "controlling_court_authority"
  | "recognized_official_guidance"
  | "model_law_or_standard"
  | "secondary_reference";
export type SourceRelationship =
  | "CONTROLLING_AUTHORITY"
  | "DISCOVERY_SOURCE"
  | "CORROBORATING_SOURCE";
export type VerificationState =
  | "VERIFIED"
  | "UNVERIFIED"
  | "PARTIALLY_VERIFIED"
  | "INSUFFICIENT_EVIDENCE"
  | "NEEDS_HUMAN_REVIEW"
  | "CONTRADICTED"
  | "SUPERSEDED"
  | "STALE";
export type SupplementFinding =
  | "EXPLICIT"
  | "INDIRECT"
  | "NO_SPECIFIC_RULE_IDENTIFIED"
  | "INCOMPLETE";
export type ReviewReason =
  | "AMBIGUOUS_CITATION"
  | "CONFLICTING_AUTHORITIES"
  | "UNCLEAR_EFFECTIVE_DATE"
  | "INACCESSIBLE_PRIMARY_SOURCE"
  | "EXTRACTION_UNCERTAINTY"
  | "POSSIBLE_SUPERSESSION"
  | "UNUSUAL_JURISDICTION_RULE";
export type ConflictType =
  | "DEADLINE"
  | "VERSION"
  | "AUTHORITY_TIER"
  | "SCOPE"
  | "OTHER";

export interface JurisdictionRecord {
  code: string;
  name: string;
  country: "US";
  regulator?: string;
  insuranceDepartmentUrl?: string;
  legislatureUrl?: string;
  administrativeCodeUrl?: string;
  wave?: 1;
  waveGroup?: "1A" | "1B";
}

export interface SourceCandidate {
  id?: string;
  jurisdictionCode: string;
  url: string;
  title?: string;
  publisher?: string;
  kind: SourceKind;
  authorityTier: AuthorityTier;
  relationship: SourceRelationship;
  discoverySourceId?: string;
  citation?: string;
  topics: ResearchTopic[];
  discoveredAt?: string;
  lastFetchedAt?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
}

export interface AcquiredSource extends SourceCandidate {
  id: string;
  canonicalUrl: string;
  contentType: string;
  contentHash: string;
  byteLength: number;
  status: "FETCHED" | "BLOCKED" | "FAILED" | "UNCHANGED";
  httpStatus?: number;
  rawContent?: string;
  fetchError?: RegulatoryError;
  version: number;
}

export interface Citation {
  citation?: string;
  statuteNumber?: string;
  regulationNumber?: string;
  ruleNumber?: string;
  agency?: string;
  title?: string;
  referencedAuthority?: string;
  sourceId?: string;
  location?: string;
  text?: string;
}

export interface RegulatoryProposition {
  id?: string;
  jurisdictionCode: string;
  topic: ResearchTopic;
  actor?: string;
  claimType?: string;
  activity?: string;
  statement: string;
  normalizedValue?: Record<string, unknown>;
  citation: Citation;
  sourceId: string;
  discoverySourceId?: string;
  authorityTier: AuthorityTier;
  verificationState: VerificationState;
  supplementFinding?: SupplementFinding;
  effectiveFrom?: string;
  effectiveTo?: string;
  enactedAt?: string;
  amendedAt?: string;
  repealedAt?: string;
  supersededBy?: string;
  previousVersionId?: string;
  verifiedAt?: string;
  evidenceText?: string;
  evidenceLocation?: string;
  confidence?: number;
  requiresHumanReview?: boolean;
}

export interface VerificationResult {
  state: VerificationState;
  reasons: string[];
  checkedAt: string;
  authoritativeSourceId?: string;
  contradictionIds?: string[];
}

export interface Contradiction {
  id?: string;
  jurisdictionCode: string;
  sourceAId: string;
  sourceBId: string;
  propositionAId?: string;
  propositionBId?: string;
  authorityTierA: AuthorityTier;
  authorityTierB: AuthorityTier;
  conflictType: ConflictType;
  description: string;
  resolutionStatus: "OPEN" | "RESOLVED_PRIMARY_PREVAILS" | "NEEDS_HUMAN_REVIEW";
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface HumanReviewItem {
  id?: string;
  jurisdictionCode: string;
  reason: ReviewReason;
  sourceId?: string;
  propositionId?: string;
  contradictionId?: string;
  summary: string;
  status: "OPEN" | "APPROVED" | "REJECTED";
  reviewerId?: string;
  reviewerNotes?: string;
  createdAt?: string;
  resolvedAt?: string;
}

export interface CoverageReport {
  jurisdictionCode: string;
  sourcesDiscovered: number;
  primarySources: number;
  secondarySources: number;
  sourcesFetched: number;
  propositionsExtracted: number;
  propositionsVerified: number;
  propositionsRequiringReview: number;
  contradictions: number;
  staleSources: number;
  topicsCovered: ResearchTopic[];
  topicsIncomplete: ResearchTopic[];
  sourceFreshness?: string;
  coverageScore: number;
  lastAcquisition?: string;
  lastVerification?: string;
}

export interface ClaimContext {
  jurisdictionCode: string;
  claimDate: string;
  actor: string;
  claimType: string;
  activity: string;
  topics?: ResearchTopic[];
}

export interface RetrievedProposition extends RegulatoryProposition {
  retrievalScore: number;
  retrievalReasons: string[];
}

export interface RegulatoryError {
  code:
    | "INVALID_URL"
    | "SSRF_BLOCKED"
    | "DOMAIN_NOT_ALLOWED"
    | "TIMEOUT"
    | "REDIRECT_NOT_ALLOWED"
    | "CONTENT_TYPE_NOT_ALLOWED"
    | "DOCUMENT_TOO_LARGE"
    | "HTTP_ERROR"
    | "DUPLICATE_DOCUMENT"
    | "NETWORK_ERROR"
    | "PARSE_ERROR"
    | "PERSISTENCE_ERROR";
  message: string;
  retryable: boolean;
  url?: string;
  status?: number;
  details?: Record<string, unknown>;
}

export interface FetchPolicy {
  allowedDomains: string[];
  allowedContentTypes: string[];
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  minIntervalMs: number;
}

export interface DiscoverySourceAdapter {
  discover(jurisdiction: JurisdictionRecord): Promise<SourceCandidate[]>;
}

export interface RegulatoryStore {
  upsertJurisdiction(jurisdiction: JurisdictionRecord): Promise<void>;
  upsertSource(source: AcquiredSource): Promise<AcquiredSource>;
  findSourceByHash(contentHash: string): Promise<AcquiredSource | undefined>;
  getSource(id: string): Promise<AcquiredSource | undefined>;
  upsertProposition(proposition: RegulatoryProposition): Promise<RegulatoryProposition>;
  listPropositions(filter?: Partial<Pick<RegulatoryProposition, "jurisdictionCode" | "topic" | "verificationState">>): Promise<RegulatoryProposition[]>;
  addContradiction(contradiction: Contradiction): Promise<Contradiction>;
  listContradictions(jurisdictionCode?: string): Promise<Contradiction[]>;
  addReviewItem(item: HumanReviewItem): Promise<HumanReviewItem>;
  listReviewItems(jurisdictionCode?: string): Promise<HumanReviewItem[]>;
  saveCoverage(report: CoverageReport): Promise<void>;
  getCoverage(jurisdictionCode?: string): Promise<CoverageReport[]>;
}
