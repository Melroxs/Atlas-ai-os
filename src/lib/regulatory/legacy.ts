// ---------------------------------------------------------------------------
// Atlas Regulatory Intelligence — Legacy Acquisition Model
//
// This module preserves the original acquisition subsystem used by the
// operational CLI scripts (scripts/acquire-regulatory-wave1.ts,
// scripts/process-regulatory-jobs.ts) against the deployed
// `atlas_regulatory_*` tables. The canonical types in ./types and the new
// pipeline in ./pipeline replaced this model for new development; this file
// exists so the legacy worker, store, discovery, fetcher, and catalog keep
// compiling and keep working against that schema.
//
// Treat this file as frozen legacy: do not extend it for new features.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Legacy domain types
// ---------------------------------------------------------------------------

/** Legacy jurisdiction registry row (atlas_regulatory_jurisdictions). */
export interface JurisdictionRecord {
  code: string;
  name: string;
  country: string;
  regulator?: string;
  insuranceDepartmentUrl?: string;
  legislatureUrl?: string;
  administrativeCodeUrl?: string;
  wave?: number;
  waveGroup?: string;
}

/** Loose research-topic identifier used for discovery scoping. */
export type ResearchTopic = string;

export type SourceKind =
  | "state_legislature"
  | "administrative_code"
  | "state_insurance_department"
  | "secondary";

export type SourceRelationship = "CONTROLLING_AUTHORITY" | "DISCOVERY_SOURCE";

/** Authority tier labels used by the legacy catalog/discovery sources. */
export type SourceCandidateAuthorityTier = string;

export interface SourceCandidate {
  jurisdictionCode: string;
  url: string;
  title?: string;
  publisher?: string;
  kind: SourceKind;
  authorityTier: SourceCandidateAuthorityTier;
  relationship: SourceRelationship;
  topics: ResearchTopic[];
  id?: string;
  discoverySourceId?: string;
}

export type AcquiredSourceStatus = "FETCHED" | "UNCHANGED" | "BLOCKED" | "FAILED";

export interface RegulatoryError {
  code: string;
  message: string;
  retryable: boolean;
  url?: string;
  status?: number;
  details?: Record<string, unknown>;
}

/** A source after the legacy fetch step (atlas_regulatory_sources). */
export interface AcquiredSource extends SourceCandidate {
  id: string;
  canonicalUrl?: string;
  citation?: string;
  contentType: string;
  contentHash: string;
  byteLength: number;
  status: AcquiredSourceStatus;
  httpStatus?: number;
  rawContent?: string;
  fetchError?: RegulatoryError;
  version: number;
  effectiveFrom?: number;
  effectiveTo?: number;
  lastFetchedAt?: string;
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

export type LegacyVerificationState =
  | "UNVERIFIED"
  | "VERIFIED"
  | "NEEDS_HUMAN_REVIEW"
  | "CONTRADICTED"
  | "INSUFFICIENT_EVIDENCE";

/** Legacy proposition row (atlas_regulatory_propositions). */
export interface LegacyProposition {
  id: string;
  jurisdictionCode: string;
  topic: string;
  actor?: string;
  claimType?: string;
  activity?: string;
  statement: string;
  normalizedValue?: string;
  citation?: unknown;
  sourceId: string;
  discoverySourceId?: string;
  authorityTier: SourceCandidateAuthorityTier;
  verificationState: LegacyVerificationState;
  supplementFinding?: string;
  effectiveFrom?: number;
  effectiveTo?: number;
  enactedAt?: number;
  amendedAt?: number;
  repealedAt?: number;
  supersededBy?: string;
  previousVersionId?: string;
  verifiedAt?: string;
  evidenceText?: string;
  evidenceLocation?: string;
  confidence?: number;
  requiresHumanReview?: boolean;
}

/** Legacy contradiction row (atlas_regulatory_contradictions). */
export interface LegacyContradiction {
  id?: string;
  jurisdictionCode: string;
  sourceAId: string;
  sourceBId: string;
  propositionAId?: string;
  propositionBId?: string;
  authorityTierA: SourceCandidateAuthorityTier;
  authorityTierB: SourceCandidateAuthorityTier;
  conflictType: string;
  description: string;
  resolutionStatus: string;
}

/** Legacy human-review queue row (atlas_regulatory_review_queue). */
export interface HumanReviewItem {
  id?: string;
  jurisdictionCode: string;
  reason: string;
  sourceId?: string;
  propositionId?: string;
  contradictionId?: string;
  summary: string;
  status: string;
  reviewerId?: string;
  reviewerNotes?: string;
  createdAt?: string;
}

/** Legacy coverage report row (atlas_regulatory_coverage). */
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
  topicsCovered: string[];
  topicsIncomplete: string[];
  sourceFreshness?: string;
  coverageScore: number;
  lastAcquisition: string;
  lastVerification?: string;
}

/** Legacy store contract implemented by InMemory/Supabase stores. */
export interface RegulatoryStore {
  upsertJurisdiction(jurisdiction: JurisdictionRecord): Promise<void>;
  upsertSource(source: AcquiredSource): Promise<AcquiredSource>;
  findSourceByHash(contentHash: string): Promise<AcquiredSource | undefined>;
  getSource(id: string): Promise<AcquiredSource | undefined>;
  upsertProposition(
    proposition: LegacyProposition,
  ): Promise<LegacyProposition>;
  listPropositions(
    filter?: Partial<
      Pick<LegacyProposition, "jurisdictionCode" | "topic" | "verificationState">
    >,
  ): Promise<LegacyProposition[]>;
  addContradiction(
    contradiction: LegacyContradiction,
  ): Promise<LegacyContradiction>;
  listContradictions(jurisdictionCode?: string): Promise<LegacyContradiction[]>;
  addReviewItem(item: HumanReviewItem): Promise<HumanReviewItem>;
  listReviewItems(jurisdictionCode?: string): Promise<HumanReviewItem[]>;
  saveCoverage(report: CoverageReport): Promise<void>;
  getCoverage(jurisdictionCode?: string): Promise<CoverageReport[]>;
}

// ---------------------------------------------------------------------------
// Legacy extraction helpers (deterministic heuristics)
// ---------------------------------------------------------------------------

/** Candidate proposition produced by the legacy text extraction step. */
export interface LegacyPropositionCandidate {
  jurisdictionCode: string;
  sourceId: string;
  topic: string;
  statement: string;
  authorityTier: SourceCandidateAuthorityTier;
  citation?: unknown;
  confidence?: number;
  effectiveFrom?: number;
  effectiveTo?: number;
  enactedAt?: number;
}

/** Keywords that suggest a line of acquired text states a regulatory rule. */
const RULE_SIGNAL_WORDS = [
  "shall",
  "must",
  "may not",
  "prohibited",
  "required",
  "within",
  "days after",
  "notice",
  "license",
  "fee",
  "coverage",
  "claim",
  "policy",
  "insured",
  "insurer",
  "supplement",
  "appraisal",
  "deductible",
  "assignment",
  "cancellation",
  "written request",
];

/** Infer a research topic from rule text using simple keyword matching. */
function inferTopic(text: string): string {
  const t = text.toLowerCase();
  const find = (needles: string[]) => needles.some((n) => t.includes(n));
  if (find(["supplement"])) return "supplemental_claims";
  if (find(["assignment of benefits", "assignment"])) return "assignment_of_benefits";
  if (find(["acknowledg"])) return "acknowledgment";
  if (find(["investigat"])) return "investigation";
  if (find(["coverage determ", "coverage"])) return "coverage_determination";
  if (find(["payment", "paid"])) return "payment";
  if (find(["bad faith", "unfair"])) return "unfair_claims_practices";
  if (find(["appraisal"])) return "appraisal";
  if (find(["public adjuster", "adjuster"])) return "public_adjuster_licensing";
  if (find(["fee"])) return "public_adjuster_fee_limits";
  if (find(["deductible"])) return "deductible_restrictions";
  if (find(["cancellation"])) return "cancellation_rights";
  if (find(["contractor", "license"])) return "contractor_licensing";
  if (find(["hurricane"])) return "hurricane";
  if (find(["wind"])) return "wind";
  if (find(["hail"])) return "hail";
  if (find(["notice of loss", "notice"])) return "notice_of_loss";
  return "unfair_claims_practices";
}

/**
 * Extract candidate propositions from acquired source text.
 *
 * Deterministic line-scanning heuristic: keeps lines that read like rule
 * statements and maps them onto discovery topics. The legacy worker treats
 * these as candidates; verification happens against the source text.
 */
export function extractPropositions(
  source: AcquiredSource,
): LegacyPropositionCandidate[] {
  const content = source.rawContent ?? "";
  if (!content.trim()) return [];

  const candidates: LegacyPropositionCandidate[] = [];
  const seen = new Set<string>();

  for (const rawLine of content.split(/\n+/)) {
    const line = rawLine
      .replace(/^\s*[\u2022\-*#]+\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line.length < 30 || line.length > 600) continue;
    if (!RULE_SIGNAL_WORDS.some((word) => line.toLowerCase().includes(word))) {
      continue;
    }
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    candidates.push({
      jurisdictionCode: source.jurisdictionCode,
      sourceId: source.id,
      topic: inferTopic(line),
      statement: line,
      authorityTier:
        source.kind === "secondary"
          ? "secondary_reference"
          : source.authorityTier,
      effectiveFrom: source.effectiveFrom,
      effectiveTo: source.effectiveTo,
      enactedAt: source.effectiveFrom,
    });
  }

  return candidates;
}

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Normalize an extracted candidate into a full legacy proposition row with
 * stable identity and default verification state.
 */
export function normalizeProposition(
  candidate: LegacyPropositionCandidate,
): LegacyProposition {
  const id =
    `prop_${simpleHash(
      `${candidate.jurisdictionCode}|${candidate.sourceId}|${candidate.topic}|${candidate.statement}`,
    )}`;
  return {
    id,
    jurisdictionCode: candidate.jurisdictionCode,
    sourceId: candidate.sourceId,
    topic: candidate.topic,
    statement: candidate.statement,
    normalizedValue: candidate.statement,
    citation: candidate.citation ?? {},
    authorityTier: candidate.authorityTier,
    verificationState: "UNVERIFIED",
    effectiveFrom: candidate.effectiveFrom,
    effectiveTo: candidate.effectiveTo,
    enactedAt: candidate.enactedAt,
    confidence: candidate.confidence ?? 0.5,
    requiresHumanReview: false,
  };
}

// ---------------------------------------------------------------------------
// Legacy verification helpers
// ---------------------------------------------------------------------------

export interface LegacyVerificationResult {
  state: LegacyVerificationState;
  reasons: string[];
}

/**
 * Verify a proposition against its source text (deterministic):
 *  - no acquired source text -> INSUFFICIENT_EVIDENCE
 *  - statement found in source text -> VERIFIED
 *  - prior contradiction recorded -> CONTRADICTED
 *  - otherwise -> NEEDS_HUMAN_REVIEW
 */
export function verifyProposition(
  proposition: LegacyProposition,
  source: AcquiredSource,
  _now: string,
  priorContradictions: LegacyContradiction[],
): LegacyVerificationResult {
  if (source.status === "BLOCKED" || source.status === "FAILED") {
    return {
      state: "INSUFFICIENT_EVIDENCE",
      reasons: ["Source could not be acquired; nothing to verify against."],
    };
  }
  const content = (source.rawContent ?? "").toLowerCase();
  if (!content.trim()) {
    return {
      state: "INSUFFICIENT_EVIDENCE",
      reasons: ["No source text available to verify against."],
    };
  }
  const statement = proposition.statement.toLowerCase();
  if (content.includes(statement)) {
    return {
      state: "VERIFIED",
      reasons: ["Rule statement found in the acquired source text."],
    };
  }
  if (
    priorContradictions.some(
      (contradiction) => contradiction.jurisdictionCode === proposition.jurisdictionCode,
    )
  ) {
    return {
      state: "CONTRADICTED",
      reasons: ["Prior contradiction recorded for this jurisdiction."],
    };
  }
  return {
    state: "NEEDS_HUMAN_REVIEW",
    reasons: [
      "Rule statement was not matched verbatim in the source; requires human review.",
    ],
  };
}

/** Apply a verification result onto a proposition row. */
export function applyVerification(
  proposition: LegacyProposition,
  verification: LegacyVerificationResult,
): LegacyProposition {
  const requiresReview =
    verification.state === "NEEDS_HUMAN_REVIEW" ||
    verification.state === "CONTRADICTED" ||
    verification.state === "INSUFFICIENT_EVIDENCE";
  return {
    ...proposition,
    verificationState: verification.state,
    verifiedAt:
      verification.state === "VERIFIED"
        ? new Date().toISOString()
        : proposition.verifiedAt,
    requiresHumanReview: requiresReview || proposition.requiresHumanReview,
  };
}

/**
 * Detect a statement-level contradiction between two propositions about the
 * same topic from different sources.
 */
export function detectContradiction(
  prior: LegacyProposition,
  candidate: LegacyProposition,
): LegacyContradiction | undefined {
  if (prior.statement === candidate.statement) return undefined;
  if (prior.topic !== candidate.topic) return undefined;
  return {
    jurisdictionCode: candidate.jurisdictionCode,
    sourceAId: prior.sourceId,
    sourceBId: candidate.sourceId,
    propositionAId: prior.id,
    propositionBId: candidate.id,
    authorityTierA: prior.authorityTier,
    authorityTierB: candidate.authorityTier,
    conflictType: "CONFLICTING_STATEMENTS",
    description:
      `Statement conflict between ${prior.sourceId} and ${candidate.sourceId}: ` +
      `"${prior.statement}" vs "${candidate.statement}".`,
    resolutionStatus: "NEEDS_HUMAN_REVIEW",
  };
}