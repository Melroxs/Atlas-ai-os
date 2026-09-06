// ---------------------------------------------------------------------------
// Atlas Regulatory Intelligence — Jurisdiction Completeness
//
// `regulatory_intelligence_coverage_score` (0-100) measures how much of the
// CONFIGURED acquisition/verification coverage has been met — it is NOT a
// legal completeness score. A score of 100 means the acquisition targets
// were hit, never "Atlas knows all law".
// ---------------------------------------------------------------------------

import type {
  FreshnessLevel,
  Jurisdiction,
  JurisdictionCoverage,
  RegulatoryProposition,
  RegulatorySource,
  VerificationStatus,
} from "./types";
import { SUPPLEMENT_TOPICS } from "./taxonomy";
import { jurisdictionFreshness, scoreFreshness } from "./freshness";

/** Coverage dimensions and their weights (sum = 1.0). */
export const COVERAGE_DIMENSIONS = {
  primary_source_coverage: { weight: 0.2, label: "Primary source coverage" },
  claims_handling_coverage: { weight: 0.15, label: "Claims-handling coverage" },
  supplement_coverage: { weight: 0.15, label: "Supplement coverage" },
  contractor_coverage: { weight: 0.1, label: "Contractor coverage" },
  public_adjuster_coverage: { weight: 0.1, label: "Public-adjuster coverage" },
  deadline_coverage: { weight: 0.1, label: "Deadline coverage" },
  peril_coverage: { weight: 0.05, label: "Peril coverage" },
  source_freshness: { weight: 0.05, label: "Source freshness" },
  verification_coverage: { weight: 0.05, label: "Verification coverage" },
  contradiction_rate: { weight: 0.05, label: "Contradiction rate" },
} as const;

export type CoverageDimension = keyof typeof COVERAGE_DIMENSIONS;

export interface CompletenessInput {
  jurisdiction: Jurisdiction;
  sources: RegulatorySource[];
  propositions: RegulatoryProposition[];
  /** Number of open contradictions for this jurisdiction. */
  contradictionCount: number;
  /** Topics with verified coverage — the configured targets. */
  configuredTargetTopics: string[];
  now?: number;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const TOPIC_GROUP_FOR_UNUSED: Record<string, "claims_handling_coverage" | "supplement_coverage" | "contractor_coverage" | "public_adjuster_coverage"> = {
  // claims handling group targets
  notice_of_loss: "claims_handling_coverage",
  acknowledgment: "claims_handling_coverage",
  investigation: "claims_handling_coverage",
  inspection: "claims_handling_coverage",
  coverage_determination: "claims_handling_coverage",
  claim_decision: "claims_handling_coverage",
  payment: "claims_handling_coverage",
  denial: "claims_handling_coverage",
  proof_of_loss: "claims_handling_coverage",
  unfair_claims_practices: "claims_handling_coverage",
  claims_practices: "claims_handling_coverage",
  // supplement group targets
  supplemental_claim: "supplement_coverage",
  reopened_claim: "supplement_coverage",
  proof_of_loss_deadline: "supplement_coverage",
  appraisal: "supplement_coverage",
  // contractor group targets
  licensing: "contractor_coverage",
  registration: "contractor_coverage",
  restoration_contracts: "contractor_coverage",
  assignment_of_benefits: "contractor_coverage",
  direction_to_pay: "contractor_coverage",
  deductible: "contractor_coverage",
  // public adjuster group targets
  pa_licensing: "public_adjuster_coverage",
  pa_fees: "public_adjuster_coverage",
  pa_fee_caps: "public_adjuster_coverage",
  pa_contracts: "public_adjuster_coverage",
};

const DIMENSION_TARGETS: Record<string, string[]> = {
  claims_handling_coverage: ["notice_of_loss", "acknowledgment", "investigation", "inspection", "coverage_determination", "payment", "denial", "proof_of_loss", "unfair_claims_practices", "claims_practices"],
  supplement_coverage: SUPPLEMENT_TOPICS,
  contractor_coverage: ["licensing", "registration", "restoration_contracts", "assignment_of_benefits", "direction_to_pay", "deductible"],
  public_adjuster_coverage: ["pa_licensing", "pa_fees", "pa_fee_caps", "pa_contracts"],
  deadline_coverage: ["response_deadlines", "payment_deadlines", "filing_deadlines", "proof_of_loss_deadline", "acknowledgment_deadline"],
  peril_coverage: ["mitigation", "water_damage", "mold", "fire", "wind", "hail", "storm", "flood", "roof"],
};

const VERIFIED_RANK: Record<VerificationStatus, number> = {
  VERIFIED: 2,
  PARTIALLY_VERIFIED: 1,
  DISCOVERED: 0,
  FETCHED: 0,
  EXTRACTED: 0,
  UNVERIFIED: 0,
  CONTRADICTED: 0,
  SUPERSEDED: 0,
  STALE: 0,
  FAILED: 0,
  NEEDS_HUMAN_REVIEW: 0,
  INSUFFICIENT_EVIDENCE: 0,
};

const FRESHNESS_RANK: Record<FreshnessLevel, number> = {
  CURRENT: 1,
  RECENT: 0.8,
  AGING: 0.5,
  STALE: 0.2,
  UNKNOWN: 0,
};

function dimCoverage(
  propositions: RegulatoryProposition[],
  targetTopics: string[],
): number {
  if (targetTopics.length === 0) return 0;
  let covered = 0;
  for (const topic of targetTopics) {
    const best = propositions
      .filter((p) => p.topic === topic)
      .reduce((max, p) => Math.max(max, VERIFIED_RANK[p.verificationStatus] ?? 0), 0);
    // VERIFIED = full credit, PARTIALLY_VERIFIED = half credit.
    if (best >= 2) covered += 1;
    else if (best === 1) covered += 0.5;
  }
  return covered / targetTopics.length;
}

/**
 * Compute the jurisdiction coverage score. Scores reflect configured
 * acquisition/verification targets, not legal completeness.
 */
export function computeJurisdictionCoverage(
  input: CompletenessInput,
): JurisdictionCoverage {
  const {
    jurisdiction,
    sources,
    propositions,
    contradictionCount,
    now = Date.now(),
  } = input;

  const jurisdictionProps = propositions.filter(
    (p) => p.jurisdictionId === jurisdiction.jurisdictionId,
  );
  const jurisdictionSources = sources.filter(
    (s) => s.jurisdictionId === jurisdiction.jurisdictionId,
  );

  const primarySourceCoverage = (() => {
    const primaryTarget = Math.max(1, Math.ceil(COVERAGE_DIMENSIONS.primary_source_coverage.weight * 100));
    const primaryCount = jurisdictionSources.filter(
      (s) => s.authorityTier === 1 && s.status !== "FAILED" && s.status !== "REGISTERED",
    ).length;
    return Math.min(1, primaryCount / primaryTarget);
  })();

  const dims: Record<CoverageDimension, number> = {
    primary_source_coverage: primarySourceCoverage,
    claims_handling_coverage: dimCoverage(jurisdictionProps, DIMENSION_TARGETS.claims_handling_coverage),
    supplement_coverage: dimCoverage(jurisdictionProps, DIMENSION_TARGETS.supplement_coverage),
    contractor_coverage: dimCoverage(jurisdictionProps, DIMENSION_TARGETS.contractor_coverage),
    public_adjuster_coverage: dimCoverage(jurisdictionProps, DIMENSION_TARGETS.public_adjuster_coverage),
    deadline_coverage: dimCoverage(jurisdictionProps, DIMENSION_TARGETS.deadline_coverage),
    peril_coverage: dimCoverage(jurisdictionProps, DIMENSION_TARGETS.peril_coverage),
    source_freshness: (() => {
      if (jurisdictionSources.length === 0) return 0;
      const scores = jurisdictionSources.map((s) => scoreFreshness(s, now));
      return FRESHNESS_RANK[jurisdictionFreshness(scores)];
    })(),
    verification_coverage: (() => {
      if (jurisdictionProps.length === 0) return 0;
      const verified = jurisdictionProps.filter(
        (p) => p.verificationStatus === "VERIFIED" || p.verificationStatus === "PARTIALLY_VERIFIED",
      ).length;
      return Math.min(1, verified / Math.max(1, jurisdictionProps.length));
    })(),
    contradiction_rate: (() => {
      if (jurisdictionProps.length === 0) return 1;
      const rate = contradictionCount / jurisdictionProps.length;
      return Math.max(0, 1 - Math.min(1, rate));
    })(),
  };

  let score = 0;
  for (const [dim, meta] of Object.entries(COVERAGE_DIMENSIONS) as Array<[CoverageDimension, { weight: number }]>) {
    score += dims[dim] * meta.weight;
  }
  const rawScore = Math.round(score * 100);

  const verifiedCount = jurisdictionProps.filter((p) => VERIFIED_RANK[p.verificationStatus] >= 1).length;
  const unverifiedCount = jurisdictionProps.length - verifiedCount;

  const gaps = input.configuredTargetTopics.filter((topic) => {
    const best = jurisdictionProps
      .filter((p) => p.topic === topic)
      .reduce((max, p) => Math.max(max, VERIFIED_RANK[p.verificationStatus] ?? 0), 0);
    return best < 1;
  });

  const supplementState = (() => {
    const supp = jurisdictionProps.filter((p) => SUPPLEMENT_TOPICS.includes(p.topic));
    if (supp.some((p) => p.supplementState === "explicitly_regulated")) return "explicitly_regulated";
    if (supp.some((p) => p.supplementState === "indirectly_regulated")) return "indirectly_regulated";
    if (supp.length === 0) return "research_incomplete";
    return "insufficient_evidence";
  })();

  const status = (() => {
    if (rawScore >= 80) return "READY";
    if (rawScore >= 50) return "PARTIAL";
    if (rawScore >= 25) return "NEEDS_REVIEW";
    return "RESEARCH_INCOMPLETE";
  })();

  return {
    jurisdictionId: jurisdiction.jurisdictionId,
    regulatoryIntelligenceCoverageScore: rawScore,
    dimensions: dims as unknown as Record<string, number>,
    status,
    sourceCount: jurisdictionSources.length,
    verifiedPropositionCount: verifiedCount,
    unverifiedPropositionCount: unverifiedCount,
    contradictionCount,
    supplementState,
    gaps,
    lastAcquisitionAt: undefined,
    freshness: (() => {
      if (jurisdictionSources.length === 0) return "UNKNOWN";
      return jurisdictionFreshness(jurisdictionSources.map((s) => scoreFreshness(s, now)));
    })(),
  };
}